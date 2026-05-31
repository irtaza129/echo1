import type { Request, Response, NextFunction } from 'express';
import { getRedis, redisKey, TTL } from '../src/lib/redis.js';
import { parseTenantConfig, type TenantConfig, type AdapterCredentials } from '../src/lib/tenantConfig.js';
import { decryptCredentials, type EncryptedBlob } from '../src/lib/crypto.js';
import { AdapterFactory } from '../adapter/AdapterFactory.js';
import type { IRestaurantAdapter } from '../adapter/IRestaurantAdapter.js';
import { extractJwt } from '../src/lib/jwt.js';

// Savour Foods hard-coded fallback — used when no JWT is present or Redis is
// unavailable. Remove once Supabase DB lookup is wired in (Phase 3).
const SAVOUR_FOODS_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const SAVOUR_FOODS_CONFIG_FALLBACK: TenantConfig = parseTenantConfig({
  tenantId:       SAVOUR_FOODS_TENANT_ID,
  slug:           'savour-foods',
  restaurantName: 'Savour Foods',
  plan:           'growth',
  adapter:        { type: 'managed' },
  gemini: {
    agentName:          'Savour Assistant',
    voice:              'Puck',
    languages:          ['en', 'ur', 'roman-ur'],
    systemPromptExtras: [
      'DRINK RULES (Savour Foods only stocks these brands):',
      '- "Cola Next" (also spelled "Colla Next") is the cola drink — NOT Pepsi or Coke.',
      '- "Fizzup" (also "Fizz Up") is the lemon/lime drink — NOT Sprite or 7Up.',
      '- "Savour Mineral Water" is the water option.',
      '- When a customer says "cola" or "coke"  → use "Cola Next" as the modifier.',
      '- When a customer says "sprite" or "7up" → use "Fizzup" as the modifier.',
      '- When a customer says "water"            → use "Savour Mineral Water" as the modifier.',
      '',
      'URDU CONFIRM WORDS: "haan", "theek hai", "bilkul", "ji" all mean yes — treat them as confirmation.',
      '',
      'MODIFIER EXAMPLE: "Aik special choice pulao, leg aur chest piece, boxed"',
      '→ add_item("special choice pulao", ["leg piece", "chest piece", "boxed"])',
    ].join('\n'),
  },
  branding:      { primaryColor: '#C8102E', logoUrl: '', kioskTitle: 'Welcome to Savour Foods' },
  businessRules: { gstRate: 0.15, currencySymbol: 'PKR', orderStatusMachine: ['pending','confirmed','preparing','ready','out_for_delivery','delivered'] },
  features:      { deliveryOrders: false, tableNumbers: true, transcriptScreen: true, loyaltyPoints: false },
});

async function loadConfig(tenantId: string): Promise<TenantConfig> {
  // 1. Try Redis cache
  try {
    const redis  = getRedis();
    const cached = await redis.get<unknown>(redisKey.tenantConfig(tenantId));
    if (cached) return parseTenantConfig(cached);
  } catch {
    // Redis unavailable — continue to fallback
  }

  // 2. Hard-coded fallback for Savour Foods while DB is being wired up
  if (tenantId === SAVOUR_FOODS_TENANT_ID) return SAVOUR_FOODS_CONFIG_FALLBACK;

  // Phase 3: add Supabase DB lookup here
  throw new Error(`[TENANT] Config not found for tenant ${tenantId}`);
}

// Warm a loaded config back into Redis so subsequent requests hit cache
async function warmCache(config: TenantConfig): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(redisKey.tenantConfig(config.tenantId), config, { ex: TTL.TENANT_CONFIG });
  } catch {
    // Non-fatal
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
// "Soft" — never returns 401. If no JWT, defaults to Savour Foods so the
// existing kiosk keeps working without auth headers on agent routes.
// Phase 3 will harden this to require auth on all routes.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function attachAdapter(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Soft-extract JWT if a bearer token is present but requireAuth wasn't run
  // ahead of us in the route chain (e.g. /api/orders for the kitchen dashboard).
  // This lets any authenticated caller be tenant-resolved by their JWT without
  // forcing every route to require auth.
  if (!req.jwtPayload) {
    const payload = extractJwt(req.headers['authorization']);
    if (payload) req.jwtPayload = payload;
  }

  const jwtTenantId    = req.jwtPayload?.tenantId;
  const rawHeader      = req.headers['x-tenant-id'];
  const headerTenantId = typeof rawHeader === 'string' && UUID_RE.test(rawHeader) ? rawHeader : undefined;

  // Strict isolation: if both a JWT tenantId and an X-Tenant-ID header are
  // present they MUST agree. A mismatch is either a bug or an attempt to make
  // one tenant's session act on another tenant's data — refuse.
  if (jwtTenantId && headerTenantId && jwtTenantId !== headerTenantId) {
    console.warn(`[TENANT] Refusing request — JWT tenantId ${jwtTenantId} ≠ X-Tenant-ID ${headerTenantId}`);
    res.status(403).json({ error: 'Tenant mismatch between auth token and X-Tenant-ID header' });
    return;
  }

  // Resolution order: JWT > header > legacy Savour default. The Savour
  // fallback only kicks in for unauthenticated requests with no header —
  // preserves the original single-tenant kiosk behaviour at the entry point.
  const tenantId = jwtTenantId ?? headerTenantId ?? SAVOUR_FOODS_TENANT_ID;
  const usedFallback = !jwtTenantId && !headerTenantId;

  // Loud when the legacy Savour fallback fires — every well-behaved caller
  // (logged-in admin, signed-up tenant kiosk, anonymous /kiosk/:slug page)
  // sends at least one of these headers. A request that lands here is
  // either the original unauthenticated Savour kiosk URL (expected) or a
  // bug — the warn makes it visible in prod logs either way.
  if (usedFallback) {
    console.warn(`[TENANT] No JWT or X-Tenant-ID on ${req.method} ${req.originalUrl} — defaulting to Savour Foods`);
  }

  let config: TenantConfig;
  try {
    config = await loadConfig(tenantId);
  } catch (err) {
    if (usedFallback) {
      // Should be unreachable — Savour's hardcoded fallback never throws —
      // but if it ever does, surface it instead of pretending nothing happened.
      console.error('[TENANT] Savour Foods fallback config failed to load:', err);
      res.status(500).json({ error: 'Tenant config unavailable' });
      return;
    }
    // Caller explicitly asked for this tenant (via JWT or header) and it
    // doesn't exist. Never silently downgrade to Savour — that's exactly the
    // bug class we're locking down.
    console.warn(`[TENANT] Unknown tenant ${tenantId} requested via ${jwtTenantId ? 'JWT' : 'X-Tenant-ID'}`);
    res.status(404).json({ error: 'Tenant not found' });
    return;
  }

  // Load encrypted credentials from Redis and decrypt (Phase 5)
  let credentials: AdapterCredentials = {};
  try {
    const redis = getRedis();
    const blob  = await redis.get<EncryptedBlob>(redisKey.credentialsKey(tenantId));
    if (blob) credentials = decryptCredentials(blob);
  } catch {
    // Credentials unavailable — adapter will work for managed; custom_api will throw on use
  }

  const adapter: IRestaurantAdapter = AdapterFactory.create(config, credentials);
  req.tenantConfig = config;
  req.adapter      = adapter;

  // Surface the resolved tenant on every tenant-scoped response. Frontends can
  // (and should) cross-check this against the tenantId they expected — catches
  // accidental cross-tenant calls before they show wrong data to a user.
  res.setHeader('X-Resolved-Tenant', config.tenantId);

  // Keep cache warm asynchronously — don't block the request
  warmCache(config).catch(() => undefined);

  next();
}
