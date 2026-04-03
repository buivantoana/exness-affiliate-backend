import path from "node:path";
import fs from "node:fs/promises";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { createPublicApiRouter } from "./routes/api.js";
import { createAdminRouter } from "./routes/admin.js";
import { createRedirectRouter } from "./routes/redirect.js";
import { getDomainConfig, normalizeHost } from "./db/index.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve("public");
const DEFAULT_HTML = path.join(PUBLIC_DIR, "index.html");
const ADMIN_HTML = path.join(PUBLIC_DIR, "admin.html");
const GEOIP_API = "http://ip-api.com/json";

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, _res, next) => {
  req.domainHost = normalizeHost(req.headers["x-forwarded-host"] || req.headers.host || "localhost");
  next();
});

const corsOrigin =
  process.env.NODE_ENV === "production"
    ? (process.env.CORS_ORIGIN || "").split(",").map((item) => item.trim()).filter(Boolean)
    : "*";
app.use(
  cors({
    origin: corsOrigin.length ? corsOrigin : "*"
  })
);

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return (
    req.headers["cf-connecting-ip"] ||
    (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "") ||
    req.headers["x-real-ip"] ||
    req.socket.remoteAddress ||
    ""
  );
}

function buildBlockResponse(res, config) {
  if (config.blockAction === "redirect" && config.blockRedirectUrl) {
    return res.redirect(302, config.blockRedirectUrl);
  }
  if (config.blockAction === "drop") {
    res.status(444);
    return res.end();
  }
  return res
    .status(403)
    .type("html")
    .send("<h1>Access Restricted</h1><p>Not available in your region.</p>");
}

async function shouldBlockRequest(req) {
  const config = await getDomainConfig(req.domainHost);
  if (!config) {
    return false;
  }

  const pathname = req.path || "/";
  if (pathname.startsWith("/api") || pathname.startsWith("/go")) {
    return false;
  }

  const ip = getClientIp(req);
  const blockedIps = config.blockedIPs || [];
  const blockedCountries = config.blockedCountries || [];

  if (ip && blockedIps.includes(ip)) {
    return config;
  }

  if (blockedCountries.length > 0 && ip && ip !== "127.0.0.1" && ip !== "::1") {
    try {
      const response = await fetch(`${GEOIP_API}/${ip}?fields=countryCode`);
      const data = await response.json();
      if (data?.countryCode && blockedCountries.includes(data.countryCode)) {
        return config;
      }
    } catch {
      return false;
    }
  }

  return false;
}

app.use(async (req, res, next) => {
  const blockConfig = await shouldBlockRequest(req);
  if (blockConfig) {
    return buildBlockResponse(res, blockConfig);
  }
  return next();
});

app.use("/api", createPublicApiRouter());
app.use("/api/admin", createAdminRouter());
app.use("/go", createRedirectRouter());

app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

app.get("/admin.html", async (_req, res) => {
  if (await fileExists(ADMIN_HTML)) {
    return res.sendFile(ADMIN_HTML);
  }
  return res.status(404).send("admin.html not found");
});

app.get("*", async (req, res) => {
  const domainIndex = path.join(PUBLIC_DIR, req.domainHost, "index.html");
  if (await fileExists(domainIndex)) {
    return res.sendFile(domainIndex);
  }
  if (await fileExists(DEFAULT_HTML)) {
    return res.sendFile(DEFAULT_HTML);
  }
  return res.status(404).send("index.html not found");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
