// server/middleware/auth.js
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const TOKEN_TTL = "24h";

// ⭐ Hàm hash password có phân biệt domain
function derivePasswordHash(password, domain) {
  // Mỗi domain có secret riêng
  const domainSecret = `${process.env.SECRET_KEY || "development-secret"}_${domain}`;
  return crypto.createHmac("sha256", domainSecret).update(String(password || "")).digest("hex");
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

// ⭐ Hàm lấy username theo domain
export function getAdminUser(domain) {
  // Chuyển domain thành tên biến env (vd: extrading-hub.com → ADMIN_USER_EXTRADING_HUB_COM)
  const envKey = `ADMIN_USER_${domain.toUpperCase().replace(/\./g, '_').replace(/-/g, '_')}`;
  return process.env[envKey] || process.env.ADMIN_USER || "admin";
}

// ⭐ Hàm verify password theo domain
export function verifyPassword(password, domain) {
  // Tìm biến env password theo domain
  const passKey = `ADMIN_PASS_${domain.toUpperCase().replace(/\./g, '_').replace(/-/g, '_')}`;
  const configuredPass = process.env[passKey] || process.env.ADMIN_PASS || "";
  
  // So sánh trực tiếp (plain text) hoặc dùng hash
  // Cách 1: So sánh plain text (đơn giản)
  return password === configuredPass;
  
  // Cách 2: So sánh hash (bảo mật hơn, bỏ comment nếu muốn dùng)
  // const configuredHash = derivePasswordHash(configuredPass, domain);
  // const inputHash = derivePasswordHash(password, domain);
  // return safeCompare(inputHash, configuredHash);
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

// ⭐ Middleware kiểm tra token có đúng domain không
export function requireAdmin(req, res, next) {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    const decoded = verifyAdminToken(token);
    req.admin = decoded;
    
    // ⭐ KIỂM TRA DOMAIN TRONG TOKEN
    if (decoded.domain && decoded.domain !== req.domainHost) {
      return res.status(403).json({ 
        success: false, 
        error: "Token not valid for this domain" 
      });
    }
    
    return next();
  } catch {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}