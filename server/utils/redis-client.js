// server/utils/redis-client.js
// Nếu không có Redis, dùng Map in-memory (cho development)

class InMemoryStore {
   constructor() {
     this.store = new Map();
   }
 
   async incr(key) {
     const current = this.store.get(key) || 0;
     const next = current + 1;
     this.store.set(key, next);
     return next;
   }
 
   async expire(key, seconds) {
     setTimeout(() => {
       this.store.delete(key);
     }, seconds * 1000);
     return 1;
   }
 
   // ⭐ THÊM METHOD DEL - xóa 1 hoặc nhiều keys
   async del(key) {
     if (typeof key === 'string') {
       this.store.delete(key);
       return 1;
     }
     if (Array.isArray(key)) {
       let count = 0;
       for (const k of key) {
         if (this.store.delete(k)) count++;
       }
       return count;
     }
     return 0;
   }
 
   // ⭐ THÊM METHOD KEYS - lấy danh sách keys theo pattern
   async keys(pattern) {
     const allKeys = Array.from(this.store.keys());
     if (pattern === '*') return allKeys;
     // Chuyển pattern * thành regex
     const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
     return allKeys.filter(key => regex.test(key));
   }
 
   // ⭐ THÊM METHOD GET - lấy giá trị của key
   async get(key) {
     const value = this.store.get(key);
     return value !== undefined ? String(value) : null;
   }
 
   // ⭐ THÊM METHOD SET (tùy chọn, cho tương thích)
   async set(key, value, options = {}) {
     this.store.set(key, value);
     if (options.EX) {
       setTimeout(() => {
         this.store.delete(key);
       }, options.EX * 1000);
     }
     return 'OK';
   }
 }
 
 let client;
 
 export async function getRedisClient() {
   if (client) return client;
 
   // Try to connect to Redis if REDIS_URL is set
   if (process.env.REDIS_URL) {
     try {
       const { createClient } = await import('redis');
       client = createClient({ url: process.env.REDIS_URL });
       await client.connect();
       console.log('✅ Redis connected');
       return client;
     } catch (error) {
       console.warn('⚠️ Redis connection failed, using in-memory store');
     }
   }
 
   // Fallback to in-memory store
   console.log('📝 Using in-memory store for rate limiting');
   client = new InMemoryStore();
   return client;
 }