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

  router.post("/login", express.json(), async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (isRateLimited(ip)) {
      return res.status(429).json({ success: false, error: "Too many login attempts" });
    }

    const { username, password } = req.body || {};
    if (username !== getAdminUser() || !verifyPassword(password)) {
      consumeAttempt(ip);
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    loginAttempts.delete(ip);
    const token = signAdminToken({ username, role: "admin" });
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
