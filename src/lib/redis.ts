import { Redis } from '@upstash/redis';

// Upstash REST-based Redis client — works on Vercel, Render, and any serverless env.
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env
let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('[REDIS] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
  }
  _redis = new Redis({ url, token });
  return _redis;
}

// TTLs
export const TTL = {
  TENANT_CONFIG: 5 * 60,          // 5 min
  MENU_CONTEXT:  6 * 60 * 60,     // 6 h
  SESSION:       12 * 60 * 60,    // 12 h
} as const;

// Key builders — single place so key format never drifts
export const redisKey = {
  tenantConfig: (tenantId: string) => `tenant:config:${tenantId}`,
  menuContext:  (tenantId: string) => `menu:${tenantId}`,
  session:      (sessionId: string) => `session:${sessionId}`,
} as const;
