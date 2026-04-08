// server/index.js
import path from "node:path";
import fs from 'node:fs';
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
console.log('DOMAIN_MAP from env:', process.env.DOMAIN_MAP);
// ==================== DOMAIN MAPPING CONFIG ====================
// Cấu hình cứng: domain nào sẽ map vào folder nào
// Format: DOMAIN_MAP="exness-vn.com:domain1,exness-th.com:domain2,localhost:domain1"
const DOMAIN_MAP = new Map();

const domainMapConfig = process.env.DOMAIN_MAP || 'localhost:domain1';
domainMapConfig.split(',').forEach(item => {
  const [domain, folder] = item.split(':');
  if (domain && folder) {
    DOMAIN_MAP.set(domain.trim(), folder.trim());
  }
});

// Map mặc định (fallback)
const DEFAULT_FOLDER = process.env.DEFAULT_FOLDER || null;

console.log('📍 Domain mapping:');
DOMAIN_MAP.forEach((folder, domain) => {
  console.log(`   ${domain} → ${folder}`);
});
if (DEFAULT_FOLDER) {
  console.log(`   * (default) → ${DEFAULT_FOLDER}`);
}

// ==================== MIDDLEWARE ====================

// Middleware xác định domain và map folder
app.use((req, _res, next) => {
  console.log('\n📋 Headers received:');
  console.log(`   x-forwarded-for: ${req.headers['x-forwarded-for']}`);
  console.log(`   host: ${req.headers.host}`);
  console.log(`   user-agent: ${req.headers['user-agent']}`);

  req.domainHost = normalizeHost(req.headers["x-forwarded-host"] || req.headers.host || "localhost");

  // Map domain → folder
  let mappedFolder = DOMAIN_MAP.get(req.domainHost);
  if (!mappedFolder && DEFAULT_FOLDER) {
    mappedFolder = DEFAULT_FOLDER;
  }
  req.domainFolder = mappedFolder || null;

  console.log(`   domainHost: ${req.domainHost}`);
  console.log(`   mappedFolder: ${req.domainFolder || '(none - using fallback)'}`);

  next();
});

// CORS config
const corsOrigin = process.env.NODE_ENV === "production"
  ? (process.env.CORS_ORIGIN || "").split(",").map(item => item.trim()).filter(Boolean)
  : "*";
app.use(cors({ origin: corsOrigin.length ? corsOrigin : "*" }));

// ==================== BLOCK MIDDLEWARE ====================

async function logSuspicious(ip, reason, detail = "") {
  console.log(`⚠️ [SUSPICIOUS] IP: ${ip} | Reason: ${reason} ${detail}`);
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

function isLocalIP(ip) {
  return ip === '::1' || ip === '127.0.0.1' || ip === 'localhost' ||
    ip.startsWith('192.168.') || ip.startsWith('10.');
}

async function blockMiddleware(req, res, config) {
  const ip = getClientIP(req);
  const { pathname } = new URL(req.url, "http://x");

  if (pathname.startsWith("/api") || pathname.startsWith("/go")) {
    return false;
  }

  const hasExtension = /\.[a-zA-Z0-9]+$/.test(pathname);
  if (hasExtension) {
    return false;
  }

  if ((config.blockedIPs || []).includes(ip)) {
    await doBlock(res, config);
    return 'handled';
  }

  if (config.blockedCIDR?.length && !ip.includes(':') && ip !== '::1') {
    if (isIPInAnyCIDR(ip, config.blockedCIDR)) {
      await doBlock(res, config);
      return 'handled';
    }
  }

  if (pathname !== "/verify") {
    const referer = req.headers.referer || "";
    if (isBadReferrer(referer, config.badReferrers)) {
      await logSuspicious(ip, "competitor_referrer", referer);
      return 'suspicious';
    }
  }

  if (!isLocalIP(ip)) {
    try {
      const redis = await getRedisClient();
      const visitKey = `visit:${ip}`;
      const visits = await redis.incr(visitKey);

      if (visits === 1) {
        await redis.expire(visitKey, 86400);
      }

      if (pathname === "/verify") {
        return false;
      }

      if (visits > 20) {
        await logSuspicious(ip, "repeat_visit", `visits: ${visits}`);
        return 'suspicious';
      }
    } catch (error) {
      console.log(`   ⚠️ Repeat visit error:`, error.message);
    }
  }

  return false;
}

// ==================== SERVE PAGE ====================

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
  console.log(`   Mapped folder: ${req.domainFolder || '(none)'}`);
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

  if (blockResult === 'handled') return;

  const filename = (blockResult === 'suspicious') ? 'blog.html' : 'index.html';

  // ⭐ Ưu tiên: folder đã map > folder domain > fallback
  let specificPath = null;

  if (req.domainFolder) {
    specificPath = path.join(PUBLIC_DIR, req.domainFolder, filename);
  }

  const domainPath = path.join(PUBLIC_DIR, domain, filename);
  const fallbackPath = path.join(PUBLIC_DIR, filename);

  let file = null;
  if (specificPath && await fileExists(specificPath)) {
    file = specificPath;
    console.log(`   Using mapped folder: ${req.domainFolder}/${filename}`);
  } else if (await fileExists(domainPath)) {
    file = domainPath;
    console.log(`   Using domain folder: ${domain}/${filename}`);
  } else {
    file = fallbackPath;
    console.log(`   Using fallback: ${filename}`);
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  if (blockResult === 'suspicious') {
    console.log(`📝 Serving blog.html for ${domain} (IP: ${getClientIP(req)})`);
  }

  fs.createReadStream(file).pipe(res);
}

// ==================== MULTI-DOMAIN STATIC ASSETS ====================

app.use((req, res, next) => {
  const pathname = req.path;
  const mappedFolder = req.domainFolder;
  const domain = req.domainHost;

  const staticPrefixes = ['/assets/', '/static/', '/fonts/', '/images/', '/media/', '/locales/'];
  const isStaticAsset = staticPrefixes.some(prefix => pathname.startsWith(prefix));

  if (isStaticAsset) {
    // Ưu tiên 1: folder đã map
    if (mappedFolder) {
      const mappedPath = path.join(PUBLIC_DIR, mappedFolder, pathname);
      if (fs.existsSync(mappedPath)) {
        console.log(`[Asset] Serving from mapped folder: ${mappedFolder}${pathname}`);
        req.url = `/${mappedFolder}${pathname}`;
        return next();
      }
    }

    // Ưu tiên 2: folder theo tên domain
    const domainPath = path.join(PUBLIC_DIR, domain, pathname);
    if (fs.existsSync(domainPath)) {
      console.log(`[Asset] Serving from domain folder: ${domain}${pathname}`);
      req.url = `/${domain}${pathname}`;
      return next();
    }
  }

  next();
});

// ==================== ROUTES ====================

// 1. API routes
app.use("/api", createPublicApiRouter());
app.use("/api/admin", createAdminRouter());
app.use("/go", createRedirectRouter());

// 2. Admin HTML
app.get("/admin.html", async (_req, res) => {
  if (await fileExists(ADMIN_HTML)) {
    return res.sendFile(ADMIN_HTML);
  }
  return res.status(404).send("admin.html not found");
});

// 3. Static files
app.use(express.static(PUBLIC_DIR));

// 4. Catch-all - serve page
app.get("*", async (req, res) => {
  if (req.path.match(/\.\w+$/)) {
    return res.status(404).send("File not found");
  }
  await servePage(req, res, req.domainHost);
});

// ==================== START SERVER ====================

app.listen(PORT, async () => {
  const defaultConfig = await getDomainConfig('localhost');
  if (defaultConfig?.blockedCIDR) {
    initCIDRRanges(defaultConfig.blockedCIDR);
  }

  console.log(`\n🚀 Server listening on port ${PORT}`);
  console.log(`📁 Public directory: ${PUBLIC_DIR}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`\n📌 Domain mapping rules:`);
  DOMAIN_MAP.forEach((folder, domain) => {
    console.log(`   ${domain} → /${folder}/`);
  });
  if (DEFAULT_FOLDER) {
    console.log(`   (default) → /${DEFAULT_FOLDER}/`);
  }
  console.log(`   (fallback) → / (root)\n`);
});