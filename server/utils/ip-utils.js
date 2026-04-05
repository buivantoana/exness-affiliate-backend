// server/utils/ip-utils.js
import fetch from 'node-fetch';

// Cache IP info
const ipInfoCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

// Pre-compile CIDR ranges
const cidrRanges = new Map();

// Hàm chuyển IPv6 sang dạng số (đơn giản hóa)
function isLocalIP(ip) {
   return ip === '::1' || ip === '127.0.0.1' || ip === 'localhost' || ip.startsWith('192.168.') || ip.startsWith('10.');
}

// CIDR check helper (chỉ hỗ trợ IPv4)
function ipToLong(ip) {
   // Bỏ qua nếu là IPv6
   if (ip.includes(':')) return 0;

   const parts = ip.split('.');
   if (parts.length !== 4) return 0;
   return ((parseInt(parts[0]) << 24) >>> 0) +
      ((parseInt(parts[1]) << 16) >>> 0) +
      ((parseInt(parts[2]) << 8) >>> 0) +
      parseInt(parts[3]);
}

function cidrToRange(cidr) {
   const [network, bits] = cidr.split('/');
   const mask = ~((1 << (32 - parseInt(bits))) - 1) >>> 0;
   const networkLong = ipToLong(network);
   return {
      start: networkLong & mask,
      end: (networkLong & mask) | (~mask >>> 0)
   };
}

export function initCIDRRanges(cidrList) {
   cidrRanges.clear();
   for (const cidr of cidrList) {
      cidrRanges.set(cidr, cidrToRange(cidr));
   }
   console.log(`✅ Initialized ${cidrRanges.size} CIDR ranges`);
}

export function isIPInCIDR(ip, cidr) {
   const ipLong = ipToLong(ip);
   if (ipLong === 0) return false; // IPv6 hoặc IP không hợp lệ

   const range = cidrRanges.get(cidr);
   if (!range) return false;
   return ipLong >= range.start && ipLong <= range.end;
}

export function isIPInAnyCIDR(ip, cidrList) {
   if (!cidrList || cidrList.length === 0) return false;
   return cidrList.some(cidr => isIPInCIDR(ip, cidr));
}

// Get IP info with caching
export async function getIPInfo(ip) {
   // Bỏ qua local IP
   if (isLocalIP(ip)) {
      return { countryCode: 'VN', proxy: false, hosting: false, as: '' };
   }

   // Check cache
   if (ipInfoCache.has(ip)) {
      const cached = ipInfoCache.get(ip);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
         return cached.data;
      }
      ipInfoCache.delete(ip);
   }

   try {
      const response = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,proxy,hosting,as`);
      const data = await response.json();

      if (data && data.countryCode) {
         ipInfoCache.set(ip, {
            data,
            timestamp: Date.now()
         });
      }

      return data;
   } catch (error) {
      console.error(`Failed to fetch IP info for ${ip}:`, error);
      return null;
   }
}

// Check if ASN is blocked
export function isASNBlocked(asn, blockedASNs) {
   if (!asn || !blockedASNs?.length) return false;
   const asnNumber = asn.split(' ')[0];
   return blockedASNs.includes(asnNumber);
}

// Get client real IP
export function getClientIP(req) {
   const ip = req.headers['cf-connecting-ip'] ||
      req.headers['x-forwarded-for']?.split(',')[0].trim() ||
      req.headers['x-real-ip'] ||
      req.socket.remoteAddress ||
      '';

   // Log để debug
   console.log(`📡 Client IP detected: ${ip}`);
   return ip;
}

// Check bad referrer
export function isBadReferrer(referer, badReferrers) {
   if (!referer || !badReferrers?.length) return false;
   return badReferrers.some(bad => referer.toLowerCase().includes(bad.toLowerCase()));
}