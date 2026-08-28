import type { Request, Response, NextFunction } from 'express';
import { parseTenantConfig, type TenantConfig, type AdapterCredentials } from '../src/lib/tenantConfig.js';
import { readTenantConfig, readCredentials } from '../src/lib/platformState.js';
import { AdapterFactory } from '../adapter/AdapterFactory.js';
import type { IRestaurantAdapter } from '../adapter/IRestaurantAdapter.js';
import { PaymentProviderFactory } from '../payments/PaymentProviderFactory.js';
import { extractJwt } from '../src/lib/jwt.js';

// Savour Foods hard-coded fallback — the original single-tenant kiosk, which
// predates the tenants table and may have no row in it. Kept as a last resort
// only: readTenantConfig() now consults Postgres, so this fires solely when
// Savour has genuinely never been persisted. Delete it once that tenant has
// been through scripts/backfill-platform-state.ts.
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

// Resolution order is Redis cache → Postgres → Savour fallback, all of it
// inside readTenantConfig() except the last step. A cache miss is now a slower
// request rather than a 404, which is the whole point of the cutover: a config
// only disappears if it was never written, not if a key expired.
async function loadConfig(tenantId: string): Promise<TenantConfig> {
  const config = await readTenantConfig(tenantId);
  if (config) return config;

  if (tenantId === SAVOUR_FOODS_TENANT_ID) {
    console.warn('[TENANT] Savour Foods has no tenant_configs row — serving hardcoded fallback');
    return SAVOUR_FOODS_CONFIG_FALLBACK;
  }

  throw new Error(`[TENANT] Config not found for tenant ${tenantId}`);
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

  // Cache, then adapter_credentials in Postgres. Returns {} when the tenant has
  // none or decryption fails — managed tenants need none, and custom_api
  // surfaces the problem when the adapter actually tries to use one.
  const credentials: AdapterCredentials = await readCredentials(tenantId);

  const adapter: IRestaurantAdapter = AdapterFactory.create(config, credentials);
  req.tenantConfig = config;
  req.adapterCredentials = credentials;
  req.adapter      = adapter;

  // Build the payment provider too (cash by default). Guarded: a misconfigured
  // gateway (e.g. provider set to safepay but no key yet) must not 500 every
  // agent route — payment routes surface the misconfiguration on use instead.
  try {
    req.paymentProvider = PaymentProviderFactory.create(config, credentials);
  } catch (err) {
    console.warn(`[PAYMENT] provider init failed for tenant ${config.tenantId}:`, (err as Error).message);
  }

  // Surface the resolved tenant on every tenant-scoped response. Frontends can
  // (and should) cross-check this against the tenantId they expected — catches
  // accidental cross-tenant calls before they show wrong data to a user.
  res.setHeader('X-Resolved-Tenant', config.tenantId);

  next();
}
