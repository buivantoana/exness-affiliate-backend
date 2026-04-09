import express from "express";
import {
  getAllDomains,
  getAnalytics,
  getDomainConfig,
  getDomainSummaryMap,
  getResolvedConfig,
  listSubPathConfigs,
  normalizeHost,
  normalizePathSegment,
  upsertDomainConfig,
  upsertSubPathConfig,
  deleteSubPath
} from "../db/index.js";
import { getAdminUser, requireAdmin, signAdminToken, verifyPassword } from "../middleware/auth.js";
import { getRedisClient } from "../utils/redis-client.js";

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_LIMIT = 5;

function consumeAttempt(ip) {
  const now = Date.now();
  const current = loginAttempts.get(ip) || [];
  const next = current.filter((time) => now - time < LOGIN_WINDOW_MS);
  next.push(now);
  loginAttempts.set(ip, next);
  return next.length;
}

function isRateLimited(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((time) => now - time < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, attempts);
  return attempts.length >= LOGIN_LIMIT;
}

function validateDomainConfig(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "Invalid config payload";
  }
  return null;
}

export function createAdminRouter() {
  const router = express.Router();
  // DELETE /api/admin/analytics/route/:route
  router.use(express.json());
  router.delete("/analytics/route/:route", async (req, res) => {
    const { route } = req.params;
    const domain = req.domainHost;

    await deleteAnalyticsRoute(domain, route);
    return res.json({ success: true, message: `Deleted ${route}` });
  });
  // / GET /api / admin / block - lists - Lấy danh sách block hiện tại
  router.get("/block-lists", async (req, res) => {
    const config = await getDomainConfig(req.domainHost);
    return res.json({
      blockedCountries: config?.blockedCountries || [],
      blockedIPs: config?.blockedIPs || [],
      blockedCIDR: config?.blockedCIDR || [],
      blockedASNs: config?.blockedASNs || [],
      badReferrers: config?.badReferrers || [],
      blockAction: config?.blockAction || "redirect",
      blockRedirectUrl: config?.blockRedirectUrl || ""
    });
  });
  // server/routes/admin.js

  // ⭐ RESET REPEAT VISIT COUNT CHO 1 IP
  router.post("/reset-visit", async (req, res) => {
    const { ip } = req.body;

    if (!ip) {
      return res.status(400).json({ success: false, error: "IP is required" });
    }

    try {
      const redis = await getRedisClient();
      await redis.del(`visit:${ip}`);

      console.log(`✅ Reset repeat visit count for IP: ${ip}`);
      res.json({ success: true, message: `Reset visit count for ${ip}` });
    } catch (error) {
      console.error(`❌ Failed to reset for IP ${ip}:`, error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ⭐ RESET TẤT CẢ IP (chỉ dùng khi test)
  router.post("/reset-all-visits", async (req, res) => {
    try {
      const redis = await getRedisClient();

      // Lấy tất cả keys có dạng visit:*
      const keys = await redis.keys('visit:*');

      if (keys.length > 0) {
        await redis.del(keys);
      }

      console.log(`✅ Reset all repeat visit counts (${keys.length} keys)`);
      res.json({ success: true, message: `Reset ${keys.length} IPs` });
    } catch (error) {
      console.error(`❌ Failed to reset all:`, error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ⭐ XEM SỐ LẦN TRUY CẬP CỦA 1 IP
  router.get("/visit-count/:ip", async (req, res) => {
    const { ip } = req.params;

    try {
      const redis = await getRedisClient();
      const visits = await redis.get(`visit:${ip}`);

      res.json({
        success: true,
        ip,
        visits: visits ? parseInt(visits) : 0
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  // PUT /api/admin/block-lists - Cập nhật block lists
  router.put("/block-lists", express.json(), async (req, res) => {
    const current = await getDomainConfig(req.domainHost);
    const updated = {
      ...current,
      blockedCountries: req.body.blockedCountries ?? current?.blockedCountries ?? [],
      blockedIPs: req.body.blockedIPs ?? current?.blockedIPs ?? [],
      blockedCIDR: req.body.blockedCIDR ?? current?.blockedCIDR ?? [],
      blockedASNs: req.body.blockedASNs ?? current?.blockedASNs ?? [],
      badReferrers: req.body.badReferrers ?? current?.badReferrers ?? [],
      blockAction: req.body.blockAction ?? current?.blockAction ?? "redirect",
      blockRedirectUrl: req.body.blockRedirectUrl ?? current?.blockRedirectUrl ?? ""
    };

    await upsertDomainConfig(req.domainHost, updated);
    return res.json({ success: true, config: updated });
  });
  // DELETE /api/admin/analytics/all
  router.delete("/analytics/all", async (req, res) => {
    const domain = req.domainHost;
    await clearAllAnalytics(domain);
    return res.json({ success: true, message: `Cleared all analytics for ${domain}` });
  });

  router.post("/login", express.json(), async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (isRateLimited(ip)) {
      return res.status(429).json({ success: false, error: "Too many login attempts" });
    }
  
    const { username, password } = req.body || {};
    const domain = req.domainHost; // ⭐ THÊM DÒNG NÀY - lấy domain từ request
  
    // ⭐ SỬA DÒNG NÀY - truyền thêm domain vào hàm
    if (username !== getAdminUser(domain) || !verifyPassword(password, domain)) {
      consumeAttempt(ip);
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }
  
    loginAttempts.delete(ip);
    // ⭐ SỬA DÒNG NÀY - gắn domain vào token
    const token = signAdminToken({ username, role: "admin", domain });
    return res.json({ success: true, token });
  });

  router.post("/logout", requireAdmin, (_req, res) => {
    return res.json({ success: true });
  });

  router.get("/status", requireAdmin, (req, res) => {
    return res.json({ success: true, isAdmin: true, username: req.admin.username });
  });

  router.use(requireAdmin);

  router.get("/current-domain", async (req, res) => {
    const config = await getDomainConfig(req.domainHost);
    return res.json({
      domain: req.domainHost,
      config: config || null
    });
  });

  router.get("/domains", async (_req, res) => {
    const domains = await getAllDomains();
    return res.json({ domains: getDomainSummaryMap(domains) });
  });

  router.put("/domains/:domain", express.json(), async (req, res) => {
    const domain = normalizeHost(req.params.domain);
    const validationError = validateDomainConfig(req.body);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }

    const config = await upsertDomainConfig(domain, req.body);
    return res.json({ success: true, domain, config });
  });

  router.get("/sub-pages", async (req, res) => {
    const subPathConfigs = await listSubPathConfigs(req.domainHost);
    return res.json({ domain: req.domainHost, subPathConfigs });
  });

  router.post("/sub-pages", express.json(), async (req, res) => {
    const path = normalizePathSegment(req.body?.path);
    if (!path) {
      return res.status(400).json({ success: false, error: "Sub-path is required" });
    }

    const config = await upsertSubPathConfig(req.domainHost, path, req.body?.config || {});
    return res.status(201).json({
      success: true,
      domain: req.domainHost,
      path,
      config: config.subPathConfigs[path]
    });
  });

  router.put("/sub-pages/:path", express.json(), async (req, res) => {
    const path = normalizePathSegment(req.params.path);
    if (!path) {
      return res.status(400).json({ success: false, error: "Sub-path is required" });
    }

    const config = await upsertSubPathConfig(req.domainHost, path, req.body || {});
    return res.json({
      success: true,
      domain: req.domainHost,
      path,
      config: config.subPathConfigs[path]
    });
  });

  router.delete("/sub-pages/:path", async (req, res) => {
    const path = normalizePathSegment(req.params.path);
    if (!path) {
      return res.status(400).json({ success: false, error: "Sub-path is required" });
    }

    await deleteSubPath(req.domainHost, path);
    return res.json({ success: true, domain: req.domainHost, path });
  });

  router.get("/analytics", async (req, res) => {
    const clicks = await getAnalytics(req.domainHost);
    return res.json({ domain: req.domainHost, clicks });
  });

  router.get("/resolved-links", async (req, res) => {
    const subPath = normalizePathSegment(req.query.subpath);
    const config = await getResolvedConfig(req.domainHost, subPath);
    return res.json({ domain: req.domainHost, subPath, config });
  });

  return router;
}
