import type { Request, Response, NextFunction } from 'express';
import { getRedis, redisKey, TTL } from '../src/lib/redis.js';
import { parseTenantConfig, type TenantConfig, type AdapterCredentials } from '../src/lib/tenantConfig.js';
import { AdapterFactory } from '../adapter/AdapterFactory.js';
import type { IRestaurantAdapter } from '../adapter/IRestaurantAdapter.js';

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

export async function attachAdapter(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const tenantId = req.jwtPayload?.tenantId ?? SAVOUR_FOODS_TENANT_ID;

  try {
    const config: TenantConfig = await loadConfig(tenantId);
    const credentials: AdapterCredentials = {}; // Phase 5: decrypt from DB
    const adapter: IRestaurantAdapter = AdapterFactory.create(config, credentials);

    req.tenantConfig = config;
    req.adapter      = adapter;

    // Keep cache warm asynchronously — don't block the request
    warmCache(config).catch(() => undefined);
  } catch (err) {
    // If config load fails, fall back to Savour Foods so nothing breaks
    console.error('[TENANT] Failed to load config, using Savour Foods fallback:', err);
    req.tenantConfig = SAVOUR_FOODS_CONFIG_FALLBACK;
    req.adapter      = AdapterFactory.create(SAVOUR_FOODS_CONFIG_FALLBACK, {});
  }

  next();
}
