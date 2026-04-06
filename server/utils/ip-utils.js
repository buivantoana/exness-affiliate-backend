// server/utils/ip-utils.js
import fetch from 'node-fetch';

// Cache IP info
const ipInfoCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 giờ

// CIDR check helper
function ipToLong(ip) {
  if (ip.includes(':')) return 0; // IPv6 không hỗ trợ
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

// Pre-compile CIDR ranges
const cidrRanges = new Map();

export function initCIDRRanges(cidrList) {
  cidrRanges.clear();
  for (const cidr of cidrList) {
    cidrRanges.set(cidr, cidrToRange(cidr));
  }
  console.log(`✅ Initialized ${cidrRanges.size} CIDR ranges`);
}

export function isIPInCIDR(ip, cidr) {
  const ipLong = ipToLong(ip);
  if (ipLong === 0) return false;
  const range = cidrRanges.get(cidr);
  if (!range) return false;
  return ipLong >= range.start && ipLong <= range.end;
}

export function isIPInAnyCIDR(ip, cidrList) {
  if (!cidrList || cidrList.length === 0) return false;
  return cidrList.some(cidr => isIPInCIDR(ip, cidr));
}

// Check if IP is local
function isLocalIP(ip) {
  return ip === '::1' || ip === '127.0.0.1' || ip === 'localhost' || 
         ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.');
}

// Get IP info with caching - THÊM LOG CHI TIẾT
export async function getIPInfo(ip) {
  console.log(`\n🌐 ===== getIPInfo() called =====`);
  console.log(`   Input IP: ${ip}`);
  
  // Bỏ qua local IP
  if (isLocalIP(ip)) {
    console.log(`   ⏭️ Skip: Local IP detected`);
    return { countryCode: 'VN', proxy: false, hosting: false, as: '' };
  }
  
  // Check cache
  if (ipInfoCache.has(ip)) {
    const cached = ipInfoCache.get(ip);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`   📦 Cache hit for IP: ${ip}`);
      console.log(`   Cached data:`, cached.data);
      return cached.data;
    }
    ipInfoCache.delete(ip);
  }

  try {
    const url = `http://ip-api.com/json/${ip}?fields=countryCode,proxy,hosting,as`;
    console.log(`   📡 Fetching: ${url}`);
    
    const response = await fetch(url);
    const data = await response.json();
    
    console.log(`   📥 API Response:`, JSON.stringify(data, null, 2));
    
    if (data && data.countryCode) {
      // Cache result
      ipInfoCache.set(ip, {
        data,
        timestamp: Date.now()
      });
      console.log(`   💾 Cached result for ${ip}`);
    } else {
      console.log(`   ⚠️ No countryCode in response`);
    }
    
    return data;
  } catch (error) {
    console.error(`   ❌ Failed to fetch IP info for ${ip}:`, error.message);
    return null;
  }
}

// Check if ASN is blocked
export function isASNBlocked(asn, blockedASNs) {
  if (!asn || !blockedASNs?.length) return false;
  const asnNumber = asn.split(' ')[0];
  const isBlocked = blockedASNs.includes(asnNumber);
  console.log(`   🔍 ASN check: ${asnNumber} -> ${isBlocked ? 'BLOCKED' : 'allowed'}`);
  return isBlocked;
}

// Get client real IP - THÊM LOG
export function getClientIP(req) {
   // ⭐ Lấy từ headers (không phân biệt chữ hoa/thường)
   const forwarded = req.headers['x-forwarded-for'] || 
                     req.headers['X-Forwarded-For'] ||
                     req.headers['x-forwarded-for'];
   
   const cfIp = req.headers['cf-connecting-ip'];
   const realIp = req.headers['x-real-ip'];
   const remoteIp = req.socket.remoteAddress;
   
   let ip = forwarded?.split(',')[0].trim() || 
            cfIp ||
            realIp ||
            remoteIp ||
            '';
   
   // Log để debug
   console.log(`\n📡 ===== getClientIP() =====`);
   console.log(`   req.headers['x-forwarded-for']: ${req.headers['x-forwarded-for']}`);
   console.log(`   forwarded variable: ${forwarded}`);
   console.log(`   → Selected IP: ${ip}`);
   
   return ip;
 }

// Check bad referrer
export function isBadReferrer(referer, badReferrers) {
  if (!referer || !badReferrers?.length) return false;
  const isBad = badReferrers.some(bad => referer.toLowerCase().includes(bad.toLowerCase()));
  if (isBad) {
    console.log(`   🔍 Bad referrer detected: ${referer}`);
  }
  return isBad;
}