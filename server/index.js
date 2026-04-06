// server/index.js - THAY THẾ hàm serveIndex và blockMiddleware cũ

import path from "node:path";
import fs from 'node:fs';           // ⭐ Thêm dòng này (cho createReadStream)
import fsPromises from 'node:fs/promises';
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { createPublicApiRouter } from "./routes/api.js";
import { createAdminRouter } from "./routes/admin.js";
import { createRedirectRouter } from "./routes/redirect.js";
import { getDomainConfig, getOrCreateDomainConfig, normalizeHost } from "./db/index.js";
import { getClientIP, getIPInfo, isASNBlocked, isBadReferrer, isIPInAnyCIDR, initCIDRRanges } from "./utils/ip-utils.js";
import { getRedisClient } from "./utils/redis-client.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve("public");
const DEFAULT_INDEX = path.join(PUBLIC_DIR, "index.html");
const DEFAULT_BLOG = path.join(PUBLIC_DIR, "blog.html");
const ADMIN_HTML = path.join(PUBLIC_DIR, "admin.html");

app.disable("x-powered-by");
app.set("trust proxy", true);

// Middleware xác định domain
app.use((req, _res, next) => {
  console.log('\n📋 Headers received:');
  console.log(`   x-forwarded-for: ${req.headers['x-forwarded-for']}`);
  console.log(`   host: ${req.headers.host}`);
  console.log(`   user-agent: ${req.headers['user-agent']}`);
  req.domainHost = normalizeHost(req.headers["x-forwarded-host"] || req.headers.host || "localhost");
  next();
});

// CORS config
const corsOrigin = process.env.NODE_ENV === "production"
  ? (process.env.CORS_ORIGIN || "").split(",").map(item => item.trim()).filter(Boolean)
  : "*";
app.use(cors({ origin: corsOrigin.length ? corsOrigin : "*" }));

// ==================== BLOCK MIDDLEWARE MỚI (3 cấp độ) ====================

async function logSuspicious(ip, reason, detail = "") {
  console.log(`⚠️ [SUSPICIOUS] IP: ${ip} | Reason: ${reason} ${detail}`);
  // Có thể ghi vào file log riêng
}

async function doBlock(res, config) {
  if (config.blockAction === "redirect" && config.blockRedirectUrl) {
    return res.redirect(302, config.blockRedirectUrl);
  }
  if (config.blockAction === "drop") {
    res.status(444);
    return res.end();
  }
  return res.status(403).type("html").send("<h1>Access Restricted</h1><p>Not available in your region.</p>");
}

async function blockMiddleware(req, res, config) {
  const ip = getClientIP(req);
  const { pathname } = new URL(req.url, "http://x");

  console.log(`\n🔍 ===== BLOCK MIDDLEWARE =====`);
  console.log(`   IP: ${ip}`);
  console.log(`   Path: ${pathname}`);
  console.log(`   Config: blockedIPs=${config?.blockedIPs?.length || 0}, blockedCIDR=${config?.blockedCIDR?.length || 0}, blockedCountries=${config?.blockedCountries?.length || 0}`);

  // Không check /api/* và /go/*
  if (pathname.startsWith("/api") || pathname.startsWith("/go")) {
    console.log(`   → Skip (API/GO route)`);
    return false;
  }

  // ===== TIER 1: HARD BLOCK =====
  // Static blocked IPs
  if ((config.blockedIPs || []).includes(ip)) {
    console.log(`   🔴 HARD BLOCK: IP in blocked list`);
    await doBlock(res, config);
    return 'handled';
  }

  // Check CIDR ranges (chỉ cho IPv4)
  if (config.blockedCIDR?.length && !ip.includes(':') && ip !== '::1') {
    const inCIDR = isIPInAnyCIDR(ip, config.blockedCIDR);
    console.log(`   🔍 CIDR check: ${inCIDR ? 'MATCH' : 'no match'}`);
    if (inCIDR) {
      console.log(`   🔴 HARD BLOCK: IP in CIDR range`);
      await doBlock(res, config);
      return 'handled';
    }
  }

  // ===== TIER 2: SUSPICIOUS → blog.html =====
  try {
    const info = await getIPInfo(ip);
    console.log(`   📊 IP Info result:`, info);

    if (info) {
      // Check blocked countries
      const blockedCountries = config.blockedCountries || [];
      console.log(`   🌍 Country check: ${info.countryCode} in ${JSON.stringify(blockedCountries)}`);
      
      if (blockedCountries.includes(info.countryCode)) {
        console.log(`   🟡 SUSPICIOUS: Blocked country ${info.countryCode}`);
        await logSuspicious(ip, "blocked_country", info.countryCode);
        return 'suspicious';
      }

      // Check blocked ASNs (datacenter)
      if (isASNBlocked(info.as, config.blockedASNs)) {
        console.log(`   🟡 SUSPICIOUS: Blocked ASN ${info.as}`);
        await logSuspicious(ip, "blocked_asn", info.as);
        return 'suspicious';
      }

      // VPN / Proxy / Hosting detection
      if (info.proxy || info.hosting) {
        console.log(`   🟡 SUSPICIOUS: ${info.proxy ? 'VPN/Proxy' : 'Hosting'} detected`);
        await logSuspicious(ip, info.proxy ? "vpn_proxy" : "hosting");
        return 'suspicious';
      }
    } else {
      console.log(`   ⚠️ No IP info returned, skipping suspicious checks`);
    }
  } catch (error) {
    console.error(`   ❌ IP info API error:`, error.message);
  }

  // Check bad referrer
 
  // Check bad referrer
  const referer = req.headers.referer || "";
  if (isBadReferrer(referer, config.badReferrers)) {
    console.log(`   🟡 SUSPICIOUS: Bad referrer ${referer}`);
    await logSuspicious(ip, "competitor_referrer", referer);
    return 'suspicious';
  }
  if (!isLocalIP(ip)) {
    console.log("AAAAA blocked ip")
    try {
      const redis = await getRedisClient();
      const visits = await redis.incr(`visit:${ip}`);
      console.log(`   📊 Repeat visit: ${visits} for IP ${ip}`);
      
      if (visits === 1) {
        await redis.expire(`visit:${ip}`, 86400);
      }
      if (visits > 5) {
        console.log(`   🟡 SUSPICIOUS: Repeat visit ${visits}`);
        await logSuspicious(ip, "repeat_visit", `visits: ${visits}`);
        return 'suspicious';
      }
    } catch (error) {
      console.log(`   ⚠️ Repeat visit error:`, error.message);
    }
  }

  console.log(`   ✅ CLEAN: Serving index.html`);
  return false;
}

// Thêm hàm isLocalIP
function isLocalIP(ip) {
  return ip === '::1' || ip === '127.0.0.1' || ip === 'localhost' || 
         ip.startsWith('192.168.') || ip.startsWith('10.'); // ⭐ 10.0.0.99 sẽ bị coi là local!
}
// ==================== SERVE PAGE MỚI (chọn index.html hoặc blog.html) ====================

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function servePage(req, res, domain) {
  console.log(`\n📄 ===== SERVEPAGE CALLED =====`);
  console.log(`   Domain: ${domain}`);
  console.log(`   URL: ${req.url}`);
  
  const config = await getDomainConfig(domain);
  console.log(`   Config found: ${!!config}`);
  
  if (!config) {
    console.log(`   ⚠️ No config, serving fallback`);
    const defaultPath = path.join(PUBLIC_DIR, "index.html");
    if (await fileExists(defaultPath)) {
      return res.sendFile(defaultPath);
    }
    return res.status(404).send("Not found");
  }

  const blockResult = await blockMiddleware(req, res, config);
  console.log(`   Block result: ${blockResult}`);
  // Nếu đã handled (hard block) → dừng
  if (blockResult === 'handled') return;

  // Chọn file dựa vào kết quả
  const filename = (blockResult === 'suspicious') ? 'blog.html' : 'index.html';

  // Ưu tiên file theo domain, sau đó fallback
  const specificPath = path.join(PUBLIC_DIR, domain, filename);
  const fallbackPath = path.join(PUBLIC_DIR, filename);

  const file = (await fileExists(specificPath)) ? specificPath : fallbackPath;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  if (blockResult === 'suspicious') {
    console.log(`📝 Serving blog.html for ${domain} (IP: ${getClientIP(req)})`);
  }

  fs.createReadStream(file).pipe(res);
}

// ==================== ROUTES ====================
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.use("/api", createPublicApiRouter());
app.use("/api/admin", createAdminRouter());
app.use("/go", createRedirectRouter());

// Admin HTML - phải nằm TRƯỚC catch-all
app.get("/admin.html", async (_req, res) => {
  if (await fileExists(ADMIN_HTML)) {
    return res.sendFile(ADMIN_HTML);
  }
  return res.status(404).send("admin.html not found");
});

// Catch-all - Tất cả các route khác (bao gồm /, /abc, /verify...)
app.get("*", async (req, res) => {
  console.log(`\n🎯 CATCH-ALL TRIGGERED: ${req.url}`);
  await servePage(req, res, req.domainHost);
});

// Static files (assets, images, css, js) - chỉ serve file tĩnh

// Khởi động server
app.listen(PORT, async () => {
  // Khởi tạo CIDR ranges
  const defaultConfig = await getDomainConfig('localhost');
  if (defaultConfig?.blockedCIDR) {
    initCIDRRanges(defaultConfig.blockedCIDR);
  }

  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📁 Public directory: ${PUBLIC_DIR}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});