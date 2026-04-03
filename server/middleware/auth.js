import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const TOKEN_TTL = "24h";

function derivePasswordHash(password) {
  const secret = process.env.SECRET_KEY || "development-secret";
  return crypto.createHmac("sha256", secret).update(String(password || "")).digest("hex");
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function getAdminUser() {
  return process.env.ADMIN_USER || "admin";
}

export function verifyPassword(password) {
  const configuredHash = derivePasswordHash(process.env.ADMIN_PASS || "");
  const inputHash = derivePasswordHash(password);
  return safeCompare(inputHash, configuredHash);
}

export function signAdminToken(payload = {}) {
  return jwt.sign(payload, process.env.SECRET_KEY || "development-secret", {
    algorithm: "HS256",
    expiresIn: TOKEN_TTL
  });
}

export function verifyAdminToken(token) {
  return jwt.verify(token, process.env.SECRET_KEY || "development-secret", {
    algorithms: ["HS256"]
  });
}

export function requireAdmin(req, res, next) {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    req.admin = verifyAdminToken(token);
    return next();
  } catch {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}
