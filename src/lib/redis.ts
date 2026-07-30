import { Redis } from '@upstash/redis';

// ── MockRedis ────────────────────────────────────────────────────────────────
// Simple in-memory Redis stand-in used when USE_MOCK_REDIS=true so the
// server can boot without real Upstash credentials (local dev / CI).
class MockRedis {
  private store = new Map<string, { value: unknown; expireAt?: number }>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expireAt && Date.now() > entry.expireAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    const expireAt = opts?.ex ? Date.now() + opts.ex * 1000 : undefined;
    this.store.set(key, { value, expireAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string): Promise<number> {
    const entry = this.store.get(key);
    const cur = entry ? Number(entry.value) || 0 : 0;
    const next = cur + 1;
    this.store.set(key, { value: next });
    return next;
  }

  async hset(key: string, field: string, value: unknown): Promise<void> {
    const entry = this.store.get(key);
    const hash = (entry?.value ?? {}) as Record<string, unknown>;
    hash[field] = value;
    this.store.set(key, { value: hash });
  }

  async hget<T>(key: string, field: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return ((entry.value as Record<string, unknown>)[field] ?? null) as T;
  }

  async hgetall<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return entry.value as T;
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    const entry = this.store.get(key);
    const hash = (entry?.value ?? {}) as Record<string, number>;
    hash[field] = (hash[field] || 0) + increment;
    this.store.set(key, { value: hash });
    return hash[field];
  }

  async lpush(key: string, ...values: unknown[]): Promise<number> {
    const entry = this.store.get(key);
    const list = (entry?.value ?? []) as unknown[];
    list.unshift(...values);
    this.store.set(key, { value: list });
    return list.length;
  }

  async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    const entry = this.store.get(key);
    if (!entry) return [];
    const list = entry.value as T[];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    const entry = this.store.get(key);
    if (!entry) return;
    const list = entry.value as unknown[];
    this.store.set(key, { value: list.slice(start, stop === -1 ? undefined : stop + 1) });
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.store.get(key);
    if (!entry) return [];
    return [...(entry.value as Set<string>)];
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const entry = this.store.get(key);
    const set = (entry?.value ?? new Set<string>()) as Set<string>;
    let added = 0;
    for (const m of members) { if (!set.has(m)) { set.add(m); added++; } }
    this.store.set(key, { value: set });
    return added;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────
// Upstash REST-based Redis client — works on Vercel, Render, and any serverless env.
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env
let _redis: Redis | MockRedis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis as Redis;

  if (process.env.USE_MOCK_REDIS === 'true') {
    console.log('[REDIS] Initialized MockRedis in-memory client');
    _redis = new MockRedis() as unknown as Redis;
    return _redis as Redis;
  }

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
  PAYMENT:        30 * 24 * 60 * 60,  // 30 days — match order retention
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
  // Payments — keyed by gateway providerRef; plus an orderId → providerRef pointer
  payment:           (providerRef: string) => `payment:${providerRef}`,
  orderPayment:      (orderId: string)     => `order:payment:${orderId}`,
  // WhatsApp channel — session state and conversation history per customer
  waSession:         (waNumber: string, tenantId: string) => `wa:session:${waNumber}:${tenantId}`,
  waHistory:         (waNumber: string, tenantId: string) => `wa:history:${waNumber}:${tenantId}`,
  waRouting:         (phoneNumberId: string) => `wa:routing:${phoneNumberId}`,
} as const;

export const WA_TTL = {
  SESSION: 1800,  // 30 min — active ordering session
  HISTORY: 1800,  // 30 min — conversation history
  ROUTING: 300,   // 5 min — phoneNumberId → tenantId cache
} as const;
