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
  TENANT_CONFIG:  365 * 24 * 60 * 60, // 1 year — configs are explicitly saved; short TTL causes data loss
  MENU_CONTEXT:   6 * 60 * 60,        // 6 h
  SESSION:        12 * 60 * 60,       // 12 h
  USAGE_HASH:     90 * 24 * 60 * 60,  // 90 days
  LOCAL_CART:     12 * 60 * 60,       // 12 h — same as session
  LOCAL_ORDER:    30 * 24 * 60 * 60,  // 30 days
} as const;

// Key builders — single place so key format never drifts
export const redisKey = {
  tenantConfig:      (tenantId: string) => `tenant:config:${tenantId}`,
  menuContext:       (tenantId: string) => `menu:${tenantId}`,
  session:           (sessionId: string) => `session:${sessionId}`,
  auditLog:          (tenantId: string) => `audit:log:${tenantId}`,
  usage:             (tenantId: string, date: string) => `usage:${tenantId}:${date}`,
  credentialsKey:    (tenantId: string) => `creds:${tenantId}`,
  menuData:          (tenantId: string) => `menu:data:${tenantId}`,
  tenantsIndex:      'tenants:index',
  // Local order management — used for admin-managed-menu tenants (not Render backend)
  localCart:         (tenantId: string, sessionId: string) => `local:cart:${tenantId}:${sessionId}`,
  localOrders:       (tenantId: string) => `local:orders:${tenantId}`,
  localOrder:        (orderId: string)  => `local:order:${orderId}`,
  localOrderCounter: (tenantId: string) => `local:order:counter:${tenantId}`,
} as const;
