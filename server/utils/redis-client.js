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