import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { issueJwt, extractJwt, type JwtPayload, type UserRole } from './src/lib/jwt.js';
import { encryptCredentials, decryptCredentials, type EncryptedBlob } from './src/lib/crypto.js';
import { parseTenantConfig } from './src/lib/tenantConfig.js';
import type { TenantConfig, AdapterCredentials } from './src/lib/tenantConfig.js';
import { getRedis, redisKey, TTL } from './src/lib/redis.js';
import { attachAdapter } from './middleware/tenant.js';
import { AdapterFactory } from './adapter/AdapterFactory.js';
import type { IRestaurantAdapter } from './adapter/IRestaurantAdapter.js';
import type { WireOrder, WireCartItem } from './src/lib/types.js';
import { checkSchema } from './src/lib/supabaseAdmin.js';
import { PaymentProviderFactory } from './payments/PaymentProviderFactory.js';
import type { IPaymentProvider, PaymentTransaction } from './payments/IPaymentProvider.js';
import { rupeesToPaisa, paisaToRupees } from './payments/money.js';
import { probeEndpoint } from './adapter/probeEndpoint.js';
import type { HttpMethod } from './src/lib/posPresets.js';
import { fetchMenuFromSupabase } from './src/lib/supabaseMenu.js';
import {
  tenantsRepo,
  tenantConfigsRepo,
  credentialsRepo,
  usersRepo,
  auditRepo,
  dualWrite,
} from './src/lib/repo.js';
import { verifyWebhookSignature, handleWebhook } from './telephony/WhatsAppHandler.js';

dotenv.config();

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_DEV   = process.env.NODE_ENV !== 'production';
const ONE_YEAR = 365 * 24 * 60 * 60;
const BACKEND_URL = process.env.BACKEND_URL || 'https://voiceai-hzyb.onrender.com';

// Slugs that cannot be claimed by registered tenants. Anything in this set
// either belongs to a hardcoded legacy tenant or to a platform route/path.
const RESERVED_SLUGS = new Set([
  'savour-foods', 'admin', 'api', 'kiosk', 'super',
  'login', 'signup', 'dashboard', 'health', 'static', 'assets',
]);

// Reserved slugs that ARE valid tenants, mapped to their hardcoded tenantId.
// `tenant-config` consults this map first so a poisoned `tenant:slug:<x>` key
// in Redis can never override the real owner.
const SAVOUR_FOODS_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const RESERVED_SLUG_TENANT_IDS: Record<string, string> = {
  'savour-foods': SAVOUR_FOODS_TENANT_ID,
};

// Tenants whose menu lives in Supabase `v_menu` (read-only from this app's
// perspective). For these tenants the admin panel cannot edit the menu, and
// neither Redis `menu:data:<id>` nor the Render `/api/v1/menu` proxy are
// consulted — Supabase is the single source of truth.
const SUPABASE_MENU_TENANTS = new Set<string>([SAVOUR_FOODS_TENANT_ID]);

// ── Menu data types (stored in Redis, tenant-scoped) ─────────────────────────
interface MenuCategoryRow { id: string; name: string; sortOrder: number }
interface MenuItemRow     { id: string; categoryId: string; name: string; description: string; price: number; available: boolean }
interface MenuData        { categories: MenuCategoryRow[]; items: MenuItemRow[] }

// ── Local order management (for admin-managed-menu tenants) ──────────────────
// Used instead of the Render backend when the tenant manages their menu via the
// admin panel (i.e. menuData exists in Redis). The Render backend stays for
// Savour Foods which has no admin-managed menu in Redis.

interface LocalCartItem {
  cart_item_id: string;
  name:         string;
  category:     string;
  summary:      string;
  quantity:     number;
  unit_price:   number;
  modifiers:    string[];
  notes:        string | null;
}

interface LocalOrder {
  id:             string;
  order_number:   number;
  tenant_id:      string;
  status:         string;
  items:          LocalCartItem[];
  subtotal:       number;
  total:          number;
  customer_name:  string;
  customer_phone: string;
  order_type:     string;
  payment_method: string;
  // Online-payment state (absent for cash orders). payment_ref is the gateway tracker.
  payment_status?: string;
  payment_ref?:    string;
  notes:          string | null;
  created_at:     string;
  updated_at:     string;
}

// ── Local → wire normalisation ───────────────────────────────────────────────
// LocalOrder/LocalCartItem are the *storage* shapes in Redis. They are NOT what
// goes on the wire: the dashboard and the Render backend use `total_amount`,
// `dish_name` and `item_total`. Render is external so it defines the contract;
// we translate here on read.
//
// Do not "simplify" this by renaming the stored fields — 500 orders already sit
// in Redis under the old names, and these mappers are what keeps them readable.
// Returning the storage shape directly is the bug that rendered every order as
// Rs 0 with blank item names.

function toWireCartItem(i: LocalCartItem): WireCartItem {
  return {
    cart_item_id: i.cart_item_id,
    dish_name:    i.name,
    quantity:     i.quantity,
    unit_price:   i.unit_price,
    summary:      i.summary,
    notes:        i.notes,
  };
}

function toWireOrder(o: LocalOrder): WireOrder {
  return {
    id:             o.id,
    order_number:   o.order_number,
    customer_name:  o.customer_name,
    customer_phone: o.customer_phone,
    order_type:     o.order_type,
    status:         o.status,
    total_amount:   o.total,
    subtotal:       o.subtotal,
    notes:          o.notes,
    created_at:     o.created_at,
    items: o.items.map(i => ({
      dish_name:  i.name,
      quantity:   i.quantity,
      unit_price: i.unit_price,
      item_total: i.unit_price * i.quantity,
      notes:      i.notes,
      selected_options: (i.modifiers ?? []).map(m => ({ choice_name: m })),
    })),
  };
}

// Count menu items across the shapes a backend might return (flat array,
// { items }, { data }, or { categories: [{ items }] }). Used by test-connection.
function countMenuItems(menu: unknown): number {
  if (Array.isArray(menu)) return menu.length;
  if (menu && typeof menu === 'object') {
    const m = menu as Record<string, unknown>;
    if (Array.isArray(m.items)) return (m.items as unknown[]).length;
    if (Array.isArray(m.data))  return (m.data as unknown[]).length;
    if (Array.isArray(m.categories)) {
      return (m.categories as Array<Record<string, unknown>>)
        .reduce((s, c) => s + (Array.isArray(c.items) ? (c.items as unknown[]).length : 0), 0);
    }
  }
  return 0;
}

// Persist a payment transaction + an orderId → providerRef pointer so webhooks
// (which only know the gateway ref) and status polls can both find the record.
type RedisClientT = ReturnType<typeof getRedis>;
async function savePaymentTxn(redis: RedisClientT, txn: PaymentTransaction): Promise<void> {
  await redis.set(redisKey.payment(txn.providerRef), txn, { ex: TTL.PAYMENT });
  await redis.set(redisKey.orderPayment(txn.orderId), txn.providerRef, { ex: TTL.PAYMENT });
}

// Normalise a string for fuzzy matching: lowercase, strip punctuation, collapse spaces.
function normStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Fuzzy-match a voice/text query against the available menu items.
// Priority: exact → substring (either direction) → word-overlap ≥ 35 %.
function fuzzyMatchItem(query: string, items: MenuItemRow[]): MenuItemRow | null {
  const q     = normStr(query);
  const avail = items.filter(i => i.available !== false && i.name.trim() !== '');

  // 1. Exact
  let m = avail.find(i => normStr(i.name) === q);
  if (m) return m;

  // 2. Substring either direction
  m = avail.find(i => { const n = normStr(i.name); return n.includes(q) || q.includes(n); });
  if (m) return m;

  // 3. Word-overlap score
  const qw = q.split(' ').filter(w => w.length > 1);
  let best: MenuItemRow | null = null;
  let top = 0;
  for (const item of avail) {
    const iw    = normStr(item.name).split(' ').filter(w => w.length > 1);
    const hits  = qw.filter(w => iw.some(iw2 => iw2 === w || iw2.startsWith(w) || w.startsWith(iw2))).length;
    const score = hits / Math.max(qw.length, iw.length, 1);
    if (score > top) { top = score; best = item; }
  }
  return top >= 0.35 ? best : null;
}

// Returns the admin-managed menu for a tenant, or null if none exists.
// null means "fall through to the Render backend adapter".
//
// Tenants in SUPABASE_MENU_TENANTS never read from `menu:data:<id>` — their
// menu lives in Supabase v_menu. This guarantees the admin panel can never
// override their menu by writing the Redis key (whether by mistake or by a
// hijacked session like the agent1101 legacy login was previously able to do).
async function getLocalMenu(tenantId: string): Promise<MenuData | null> {
  if (SUPABASE_MENU_TENANTS.has(tenantId)) return null;
  try {
    const data = await getRedis().get<MenuData>(redisKey.menuData(tenantId));
    return data ?? null;
  } catch {
    return null;
  }
}

// Fetches the Supabase-backed menu for a tenant with a short Redis cache.
// Cache key is intentionally distinct from `menu:data:<id>` so the admin
// panel's write paths can never poison this lookup.
const SUPABASE_MENU_CACHE_TTL = 5 * 60; // 5 min
function supabaseMenuCacheKey(tenantId: string): string { return `menu:supabase:${tenantId}`; }

async function getSupabaseMenu(tenantId: string): Promise<MenuData | null> {
  try {
    const redis  = getRedis();
    const cached = await redis.get<MenuData>(supabaseMenuCacheKey(tenantId));
    if (cached) return cached;
  } catch { /* Redis unavailable — fetch fresh */ }

  let fresh: MenuData;
  try {
    fresh = await fetchMenuFromSupabase(tenantId);
  } catch (err) {
    console.error('[SUPABASE] menu fetch failed for', tenantId, '—', (err as Error).message);
    return null;
  }

  try {
    await getRedis().set(supabaseMenuCacheKey(tenantId), fresh, { ex: SUPABASE_MENU_CACHE_TTL });
  } catch { /* non-fatal */ }
  return fresh;
}

// Generates the markdown string Gemini receives as menu context.
// Called whenever menu data is saved; result is cached as menu:{tenantId}.
function buildMenuMarkdown(menu: MenuData, config: TenantConfig): string {
  const { categories, items } = menu;
  const cur  = config.businessRules.currencySymbol;
  let   md   = `# ${config.restaurantName} Menu\n\n`;
  const cats = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const cat of cats) {
    const catItems = items.filter(i => i.categoryId === cat.id && i.available !== false);
    if (catItems.length === 0) continue;
    md += `## ${cat.name}\n`;
    for (const item of catItems) {
      md += `- **${item.name}** — ${cur} ${item.price}`;
      if (item.description) md += `: ${item.description}`;
      md += '\n';
    }
    md += '\n';
  }
  return md.trim() || `# ${config.restaurantName} Menu\n\n(No items added yet)`;
}

// Super admin credentials loaded from env — if not set, super admin login is disabled
const SUPER_ADMIN_EMAIL         = process.env.SUPER_ADMIN_EMAIL         ?? '';
const SUPER_ADMIN_PASSWORD_HASH = process.env.SUPER_ADMIN_PASSWORD_HASH ?? '';

// ── Augment Express Request ───────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      jwtPayload?:  JwtPayload;
      tenantConfig?: TenantConfig;
      adapter?:     IRestaurantAdapter;
      paymentProvider?: IPaymentProvider;
      rawBody?:     Buffer;
    }
  }
}

// ── Legacy auth (Savour Foods backward compat) ────────────────────────────────
const AUTH_USERNAME      = 'agent1101';
const AUTH_PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH
  ?? 'a3046da0d15a27e89f2afe639b25748a7ad4d9290af3e7b1b6c1a5533c8f0a8c';
const SESSION_SECRET = process.env.SESSION_SECRET
  ?? crypto.randomBytes(32).toString('hex');

function issueLegacyToken(username: string): string {
  const payload = JSON.stringify({ sub: username, exp: Date.now() + 12 * 60 * 60 * 1000 });
  const b64 = Buffer.from(payload).toString('base64');
  const sig  = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

function verifyLegacyToken(token: string): boolean {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const b64 = token.slice(0, dot);
    const sig  = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const { exp } = JSON.parse(Buffer.from(b64, 'base64').toString()) as { exp: number };
    return exp > Date.now();
  } catch {
    return false;
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const jwtPayload = extractJwt(req.headers['authorization']);
  if (jwtPayload) { req.jwtPayload = jwtPayload; next(); return; }

  const legacyToken =
    (req.headers['x-auth-token'] as string | undefined) ??
    (req.body as { token?: string })?.token;

  if (legacyToken && verifyLegacyToken(legacyToken)) {
    req.jwtPayload = {
      sub: 'legacy-agent1101', tenantId: '00000000-0000-4000-8000-000000000001',
      role: 'tenant_admin', slug: 'savour-foods',
    };
    next(); return;
  }

  res.status(401).json({ error: 'Unauthorized' });
}

// Super-admin-only guard (must follow requireAuth in the chain, or stand alone)
function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const jwtPayload = extractJwt(req.headers['authorization']);
  if (!jwtPayload)                         { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (jwtPayload.role !== 'super_admin')   { res.status(403).json({ error: 'Super admin access required' }); return; }
  req.jwtPayload = jwtPayload;
  next();
}

// Non-fatal audit log helper — failures are swallowed so they never block requests
interface AuditEntry { ts: string; action: string; sub: string; tenantId: string; details?: string }

async function writeAuditLog(tenantId: string, action: string, sub: string, details?: string): Promise<void> {
  try {
    const redis = getRedis();
    const entry: AuditEntry = { ts: new Date().toISOString(), action, sub, tenantId, details };
    const key = redisKey.auditLog(tenantId);
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, 499);
  } catch { /* non-fatal */ }
  // Dual-write to Postgres — append-only, isolated from Redis success/failure.
  void dualWrite('audit_log', auditRepo.append({ tenantId, actor: sub, action, details }));
}

// Ensure a tenant row exists in the relational source of truth (Supabase
// `tenants`). Previously this called FastAPI's `/api/v1/admin/ensure-tenant`,
// which 500s — the FK violations on category sync were the visible symptom.
// We now write directly to the shared Supabase `tenants` table so both this
// app and the FastAPI menu-sync flow are reading from the same row.
async function ensureTenantInBackend(tenantId: string, slug: string, name: string, plan: string): Promise<void> {
  await tenantsRepo.upsert({ id: tenantId, slug, name, plan, status: 'active' });
}

// Helper: propagate adapter errors with the correct HTTP status
function adapterError(res: Response, err: unknown): void {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 500;
    res.status(status).json(err.response?.data ?? { error: err.message });
  } else {
    console.error('[ADAPTER] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Server bootstrap ──────────────────────────────────────────────────────────
async function startServer() {
  const app  = express();
  const PORT = 3000;

  if (!process.env.JWT_SECRET)              console.warn('[AUTH] JWT_SECRET not set — JWT auth will fail');
  if (!process.env.SESSION_SECRET)          console.warn('[AUTH] SESSION_SECRET not set — legacy sessions lost on restart');
  if (!process.env.META_APP_SECRET)         console.warn('[WA] META_APP_SECRET not set — WhatsApp webhook verification disabled');
  if (!process.env.META_WHATSAPP_TOKEN)     console.warn('[WA] META_WHATSAPP_TOKEN not set — WhatsApp replies will fail');
  if (!process.env.META_WEBHOOK_VERIFY_TOKEN) console.warn('[WA] META_WEBHOOK_VERIFY_TOKEN not set — Meta webhook registration will fail');

  app.set('trust proxy', 1);
  // Disable Express's auto-generated ETag for API responses. Tenant-scoped
  // endpoints must never return 304: the browser would then reuse a cached
  // body that may have belonged to a different tenant (this is exactly how
  // Johnny's menu kept appearing under Savour even after the Redis fix).
  app.set('etag', false);
  // Capture the raw request body so payment webhooks can verify HMAC signatures
  // (signatures are computed over the exact bytes the gateway sent, not the
  // re-serialised JSON). Stashed on req.rawBody; harmless for every other route.
  app.use(express.json({
    limit: '100kb',
    verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; },
  }));
  app.use('/api/', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    next();
  });

  // ── Rate limiters ───────────────────────────────────────────────────────────
  const generalLimiter  = rateLimit({ windowMs: 15*60*1000, max: 200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
  const agentLimiter    = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
  const authLimiter     = rateLimit({ windowMs: 15*60*1000, max: 20,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts.' } });
  const tokenLimiter    = rateLimit({ windowMs: 60*1000,    max: 10,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many token requests.' } });
  const webhookLimiter  = rateLimit({ windowMs: 60*1000,    max: 60,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many webhook requests.' } });

  app.use('/api/', generalLimiter);
  app.use('/api/agent/', agentLimiter);
  app.use('/api/auth/', authLimiter);

  // Warm up Render backend on startup
  const warmupClient = axios.create({ timeout: 15_000 });
  warmupClient.get(`${BACKEND_URL}/api/v1/menu`).catch(() =>
    console.warn('[WARMUP] Render backend cold-starting')
  );
  warmupClient.get(`${BACKEND_URL}/api/v1/agent/menu-context`).catch(() =>
    console.warn('[WARMUP] menu-context cold-starting')
  );

  // Verify the deployed Postgres schema matches what repo.ts writes. Non-fatal
  // (Redis is the primary store), but loud — a mismatch here means dual-writes
  // are failing silently, which is exactly how the audit_log drift went
  // unnoticed. Run once at boot; a schema change requires a redeploy anyway.
  checkSchema()
    .then(problems => {
      if (!problems.length) { console.log('[SCHEMA] Postgres schema OK'); return; }
      for (const p of problems) {
        console.error(`[SCHEMA] MISMATCH ${p.table}: missing column(s) ${p.missing.join(', ')}`);
      }
      console.error(
        `[SCHEMA] ${problems.length} table(s) drifted — dual-writes to these WILL fail silently. ` +
        `Apply the pending migration in migrations/.`,
      );
    })
    .catch(err => console.warn('[SCHEMA] Could not verify schema:', err instanceof Error ? err.message : err));

  // ── Gemini ephemeral token ──────────────────────────────────────────────────
  app.post('/api/gemini-token', tokenLimiter, async (_req, res: Response) => {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) { res.status(500).json({ error: 'Server configuration error' }); return; }
    try {
      const ai    = new GoogleGenAI({ apiKey: geminiApiKey, httpOptions: { apiVersion: 'v1alpha' } });
      const token = await ai.authTokens.create({});
      if (!token.name) throw new Error('SDK returned no token name');
      console.log('[TOKEN] Ephemeral token issued');
      res.json({ ephemeralToken: token.name });
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? ((err.response?.data as { error?: { message?: string } })?.error?.message ?? err.message)
        : String(err);
      console.error('[TOKEN] Failed:', msg);
      res.status(500).json({ error: `Token generation failed: ${msg}` });
    }
  });

  // ── Voice preview — generates a short TTS sample for the voice selector ──────
  const VALID_VOICES = new Set(['Puck','Zephyr','Charon','Kore','Fenrir','Aoede','Orbit','Umbriel','Algieba']);

  app.post('/api/admin/preview-voice', requireAuth, tokenLimiter, async (req: Request, res: Response) => {
    const { voice } = req.body as { voice?: string };
    if (!voice || !VALID_VOICES.has(voice)) {
      res.status(400).json({ error: 'Invalid voice name' }); return;
    }
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) { res.status(500).json({ error: 'Server not configured' }); return; }
    try {
      const r = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent',
        {
          contents: [{ role: 'user', parts: [{ text: `Hello! I'm your AI assistant, here to help you order.` }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        },
        { headers: { 'x-goog-api-key': geminiApiKey }, timeout: 15_000 },
      );
      const part = r.data?.candidates?.[0]?.content?.parts?.[0];
      if (!part?.inlineData?.data) throw new Error('No audio in TTS response');
      res.json({ audioBase64: part.inlineData.data, mimeType: part.inlineData.mimeType ?? 'audio/pcm;rate=24000' });
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as { error?: { message?: string } })?.error?.message ?? err.message
        : String(err);
      console.error('[VOICE PREVIEW] Failed:', msg);
      res.status(500).json({ error: msg });
    }
  });

  // ── Auth endpoints ──────────────────────────────────────────────────────────
  app.post('/api/auth/login', authLimiter, async (req: Request, res: Response) => {
    const { username, password, email } = req.body as { username?: string; password?: string; email?: string };
    const loginId = email ?? username;
    if (typeof loginId !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Invalid request' }); return;
    }
    const hash = crypto.createHash('sha256').update(password).digest('hex');

    // Super admin login via env vars
    if (SUPER_ADMIN_EMAIL && SUPER_ADMIN_PASSWORD_HASH && loginId === SUPER_ADMIN_EMAIL && hash === SUPER_ADMIN_PASSWORD_HASH) {
      if (!process.env.JWT_SECRET) { res.status(500).json({ error: 'Server not configured for JWT auth' }); return; }
      const jwtToken = issueJwt({ sub: SUPER_ADMIN_EMAIL, tenantId: 'super', role: 'super_admin', slug: 'super' });
      void writeAuditLog('super', 'login', SUPER_ADMIN_EMAIL);
      res.json({ token: issueLegacyToken(loginId), jwtToken, role: 'super_admin', slug: 'super' });
      return;
    }

    // Legacy hardcoded user (agent1101)
    if (loginId === AUTH_USERNAME && hash === AUTH_PASSWORD_HASH) {
      const jwtToken = process.env.JWT_SECRET
        ? issueJwt({ sub: 'legacy-agent1101', tenantId: '00000000-0000-4000-8000-000000000001', role: 'tenant_admin', slug: 'savour-foods' })
        : undefined;
      res.json({ token: issueLegacyToken(loginId), jwtToken, role: 'tenant_admin', slug: 'savour-foods' }); return;
    }

    // Email-based users registered via /api/auth/register
    try {
      const redis = getRedis();
      const user  = await redis.get<{ email: string; passwordHash: string; tenantId: string; slug: string; role: UserRole }>(
        `user:email:${loginId.toLowerCase()}`
      );
      if (user && user.passwordHash === hash) {
        // Self-heal: a user account that holds a reserved slug should never have
        // been created. Refuse the login so the rogue account is effectively
        // dead until an operator runs scripts/cleanup-poisoned-slug.ts.
        if (RESERVED_SLUGS.has(user.slug)) {
          console.warn(`[AUTH] Refusing login for ${user.email} — stored slug "${user.slug}" is reserved`);
          res.status(403).json({ error: 'This account is in an invalid state. Contact support.' }); return;
        }
        const jwtToken = process.env.JWT_SECRET
          ? issueJwt({ sub: user.email, tenantId: user.tenantId, role: user.role, slug: user.slug })
          : undefined;
        res.json({ token: issueLegacyToken(loginId), jwtToken, role: user.role, slug: user.slug }); return;
      }
    } catch (err) {
      console.error('[AUTH] Redis user lookup failed:', err);
    }

    res.status(401).json({ error: 'Invalid credentials' });
  });

  // ── Register new tenant ────────────────────────────────────────────────────
  app.post('/api/auth/register', authLimiter, async (req: Request, res: Response) => {
    const { email, password, restaurantName, slug, plan } =
      req.body as { email?: string; password?: string; restaurantName?: string; slug?: string; plan?: string };

    if (!email || !password || !restaurantName || !slug) {
      res.status(400).json({ error: 'email, password, restaurantName, and slug are required' }); return;
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'slug may only contain lowercase letters, numbers, and hyphens' }); return;
    }
    if (RESERVED_SLUGS.has(slug)) {
      res.status(400).json({ error: 'That identifier is reserved. Please choose a different one.' }); return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' }); return;
    }

    try {
      const redis        = getRedis();
      const emailKey     = `user:email:${email.toLowerCase()}`;
      const slugKey      = `tenant:slug:${slug}`;

      const [existingEmail, existingSlug] = await Promise.all([
        redis.get(emailKey),
        redis.get(slugKey),
      ]);
      if (existingEmail) { res.status(409).json({ error: 'Email already registered' }); return; }
      if (existingSlug)  { res.status(409).json({ error: 'That restaurant identifier is already taken' }); return; }

      const tenantId     = crypto.randomUUID();
      const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

      const config = parseTenantConfig({
        tenantId,
        slug,
        restaurantName,
        plan: ['starter','growth','enterprise'].includes(plan ?? '') ? plan : 'starter',
        adapter: { type: 'managed' },
        gemini: {
          agentName:          `${restaurantName} Assistant`,
          voice:              'Puck',
          languages:          ['en'],
          systemPromptExtras: '',
        },
        branding: {
          primaryColor: '#000000',
          logoUrl:      '',
          kioskTitle:   `Welcome to ${restaurantName}`,
        },
        businessRules: {
          gstRate:            0,
          currencySymbol:     '$',
          orderStatusMachine: ['pending','confirmed','preparing','ready','delivered'],
        },
        features: {
          deliveryOrders:   false,
          tableNumbers:     false,
          transcriptScreen: false,
          loyaltyPoints:    false,
        },
      });

      await Promise.all([
        redis.set(emailKey, { email: email.toLowerCase(), passwordHash, tenantId, slug, role: 'tenant_admin' }, { ex: ONE_YEAR }),
        redis.set(slugKey,  tenantId, { ex: ONE_YEAR }),
        redis.set(redisKey.tenantConfig(tenantId), config, { ex: TTL.TENANT_CONFIG }),
        redis.sadd(redisKey.tenantsIndex, tenantId),
      ]);

      void writeAuditLog(tenantId, 'register', email.toLowerCase(), `slug=${slug} plan=${plan ?? 'starter'}`);

      // Dual-write registration into the relational source of truth so the
      // tenant row, its config, and the admin user all exist in Postgres.
      // Each is independent — a failure on one doesn't block the others.
      void dualWrite('tenants.upsert',         tenantsRepo.upsert({ id: tenantId, slug, name: restaurantName, plan: plan ?? 'starter' }));
      void dualWrite('tenant_configs.upsert',  tenantConfigsRepo.upsert(tenantId, config, email.toLowerCase()));
      void dualWrite('platform_users.upsert',  usersRepo.upsert({ tenantId, email: email.toLowerCase(), passwordHash, role: 'tenant_admin' }));

      if (!process.env.JWT_SECRET) {
        res.status(500).json({ error: 'Server not configured for JWT auth' }); return;
      }
      const jwtToken = issueJwt({ sub: email.toLowerCase(), tenantId, role: 'tenant_admin', slug });
      console.log(`[AUTH] Registered new tenant: ${slug} (${tenantId})`);
      res.status(201).json({ jwtToken, slug, tenantId, role: 'tenant_admin' });
    } catch (err) {
      console.error('[AUTH] Register failed:', err);
      res.status(500).json({ error: 'Registration failed — please try again' });
    }
  });

  app.post('/api/auth/verify', (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    if (typeof token !== 'string') { res.status(400).json({ error: 'Invalid request' }); return; }
    if (extractJwt(`Bearer ${token}`) || verifyLegacyToken(token)) {
      res.json({ ok: true }); return;
    }
    res.status(401).json({ error: 'Invalid or expired token' });
  });

  // ── Tenant config (public — branding only, no secrets) ─────────────────────
  app.get('/api/tenant-config/:slug', async (req: Request, res: Response) => {
    const slug = req.params.slug;
    // Same reasoning as /api/menu: this response is tenant-specific keyed by URL
    // path, and a stale 304 here would feed the wrong tenantId into App.tsx.
    res.set('Cache-Control', 'no-store, must-revalidate');
    try {
      const redis = getRedis();

      // Reserved-slug guard: if the slug has a hardcoded owner, use it regardless of
      // what Redis says. If the slug is reserved but has no hardcoded owner (e.g.
      // "admin", "api"), 404 immediately — never consult Redis for those.
      let tenantId: string | null;
      if (RESERVED_SLUG_TENANT_IDS[slug]) {
        tenantId = RESERVED_SLUG_TENANT_IDS[slug];
      } else if (RESERVED_SLUGS.has(slug)) {
        res.status(404).json({ error: 'Tenant not found' }); return;
      } else {
        tenantId = await redis.get<string>(`tenant:slug:${slug}`);
      }
      if (!tenantId) { res.status(404).json({ error: 'Tenant not found' }); return; }

      const cached = await redis.get<unknown>(redisKey.tenantConfig(tenantId));
      let config;
      if (cached) {
        config = parseTenantConfig(cached);
      } else if (tenantId === SAVOUR_FOODS_TENANT_ID) {
        config = parseTenantConfig({
          tenantId, slug: 'savour-foods', restaurantName: 'Savour Foods', plan: 'growth',
          adapter: { type: 'managed' },
          gemini: { agentName: 'Savour Assistant', voice: 'Puck', languages: ['en','ur','roman-ur'], systemPromptExtras: '' },
          branding: { primaryColor: '#C8102E', logoUrl: '', kioskTitle: 'Welcome to Savour Foods' },
          businessRules: { gstRate: 0.15, currencySymbol: 'PKR', orderStatusMachine: ['pending','confirmed','preparing','ready','out_for_delivery','delivered'] },
          features: { deliveryOrders: false, tableNumbers: true, transcriptScreen: true, loyaltyPoints: false },
        });
      } else {
        res.status(404).json({ error: 'Tenant config not found' }); return;
      }

      res.json({
        tenantId:       config.tenantId,
        restaurantName: config.restaurantName,
        branding:       config.branding,
        businessRules:  config.businessRules,
        features:       config.features,
        gemini: {
          agentName:          config.gemini.agentName,
          voice:              config.gemini.voice,
          languages:          config.gemini.languages,
          systemPromptExtras: config.gemini.systemPromptExtras,
        },
        setupComplete: config.setupComplete,
        setupStep:     config.setupStep,
      });
    } catch (err) {
      console.error('[TENANT] config fetch failed:', err);
      res.status(500).json({ error: 'Failed to load config' });
    }
  });

  // ── Admin: push config into Redis cache ────────────────────────────────────
  app.post('/api/admin/cache-config', requireAuth, async (req: Request, res: Response) => {
    const role = req.jwtPayload?.role;
    if (role !== 'super_admin' && role !== 'tenant_admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    try {
      const config = parseTenantConfig(req.body);
      const redis  = getRedis();
      await redis.set(redisKey.tenantConfig(config.tenantId), config, { ex: TTL.TENANT_CONFIG });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Tenant admin: get full config (not just public subset) ────────────────
  app.get('/api/admin/my-config', requireAuth, async (req: Request, res: Response) => {
    const { tenantId, slug } = req.jwtPayload!;
    try {
      const redis  = getRedis();
      const cached = await redis.get<unknown>(redisKey.tenantConfig(tenantId));
      if (cached) { res.json(cached); return; }
    } catch {
      // Redis unavailable — fall through to fallbacks
    }
    // Hardcoded fallback for Savour Foods
    if (tenantId === '00000000-0000-4000-8000-000000000001') {
      res.json({
        tenantId, slug: 'savour-foods', restaurantName: 'Savour Foods', plan: 'growth',
        adapter: { type: 'managed' },
        gemini: { agentName: 'Savour Assistant', voice: 'Puck', languages: ['en','ur','roman-ur'], systemPromptExtras: '' },
        branding: { primaryColor: '#C8102E', logoUrl: '', kioskTitle: 'Welcome to Savour Foods' },
        businessRules: { gstRate: 0.15, currencySymbol: 'PKR', orderStatusMachine: ['pending','confirmed','preparing','ready','out_for_delivery','delivered'] },
        features: { deliveryOrders: false, tableNumbers: true, transcriptScreen: true, loyaltyPoints: false },
      });
      return;
    }
    // Redis key expired — rebuild a minimal config from JWT claims so the admin panel
    // still loads. The admin can re-save from the Config tab to persist properly.
    console.warn(`[ADMIN] Config missing from Redis for tenant ${tenantId} — returning default`);
    const restored = parseTenantConfig({
      tenantId, slug,
      restaurantName: slug,
      plan: 'starter',
      adapter: { type: 'managed' },
      gemini: { agentName: 'AI Assistant', voice: 'Puck', languages: ['en'], systemPromptExtras: '' },
      branding: { primaryColor: '#000000', logoUrl: '', kioskTitle: `Welcome to ${slug}` },
      businessRules: { gstRate: 0, currencySymbol: '$', orderStatusMachine: ['pending','confirmed','preparing','ready','delivered'] },
      features: { deliveryOrders: false, tableNumbers: false, transcriptScreen: false, loyaltyPoints: false },
    });
    // Write it back so subsequent requests don't have to rebuild
    try {
      const redis = getRedis();
      await redis.set(redisKey.tenantConfig(tenantId), restored, { ex: TTL.TENANT_CONFIG });
    } catch { /* non-fatal */ }
    res.json(restored);
  });

  // ── Tenant admin: save full config ─────────────────────────────────────────
  app.post('/api/admin/save-config', requireAuth, async (req: Request, res: Response) => {
    const { role, tenantId } = req.jwtPayload!;
    if (role !== 'tenant_admin' && role !== 'super_admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    try {
      // Force tenantId from JWT — never trust the body for this
      const config = parseTenantConfig({ ...req.body, tenantId });
      const redis  = getRedis();
      await redis.set(redisKey.tenantConfig(tenantId), config, { ex: TTL.TENANT_CONFIG });
      // Invalidate stale menu cache so next request re-fetches from backend
      await redis.del(redisKey.menuContext(tenantId)).catch(() => undefined);
      void writeAuditLog(tenantId, 'config_save', req.jwtPayload!.sub);
      // Dual-write the config (and keep tenants.slug/name in sync — admins
      // editing the restaurant name in the wizard should propagate to Postgres).
      void dualWrite('tenant_configs.upsert', tenantConfigsRepo.upsert(tenantId, config, req.jwtPayload!.sub));
      void dualWrite('tenants.upsert',        tenantsRepo.upsert({ id: tenantId, slug: config.slug, name: config.restaurantName, plan: config.plan }));
      console.log(`[ADMIN] Config saved for tenant ${tenantId}`);
      res.json({ ok: true, kioskUrl: `/kiosk/${config.slug}` });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Adapter connection test ─────────────────────────────────────────────────
  // Exercises the REAL adapter — same path, auth, and injected params the kiosk
  // will use — and reports an actual menu item count. This makes "connected but
  // empty" actionable (missing key / filter / wrong path) instead of mysterious.
  app.post('/api/admin/test-connection', requireAuth, async (req: Request, res: Response) => {
    const { tenantId } = req.jwtPayload!;
    const { backendUrl, apiKey, apiSecret, endpointMappings } = req.body as {
      backendUrl?: string; apiKey?: string; apiSecret?: string; endpointMappings?: unknown;
    };
    if (!backendUrl) { res.status(400).json({ error: 'backendUrl is required' }); return; }
    const base = backendUrl.replace(/\/$/, '');

    // If the onboarder didn't re-type the API key, fall back to the saved one.
    let key = apiKey;
    let secret = apiSecret;
    if (!key) {
      try {
        const blob = await getRedis().get<EncryptedBlob>(redisKey.credentialsKey(tenantId));
        if (blob) { const c = decryptCredentials(blob); key = c.apiKey; secret = secret ?? c.apiSecret; }
      } catch { /* no saved creds */ }
    }

    let adapter: IRestaurantAdapter;
    try {
      const cfg = parseTenantConfig({
        tenantId, slug: 'connection-test', restaurantName: 'Connection Test', plan: 'starter',
        adapter: { type: 'custom_api', endpointMappings: Array.isArray(endpointMappings) ? endpointMappings : undefined },
        gemini: {}, branding: {}, businessRules: {}, features: {},
      });
      adapter = AdapterFactory.create(cfg, { baseUrl: base, apiKey: key, apiSecret: secret });
    } catch (err) {
      res.status(400).json({ ok: false, error: `Invalid adapter configuration: ${String(err)}` });
      return;
    }

    // 1. Fetch the menu the way the kiosk will, and count what came back.
    try {
      const menu  = await adapter.getMenuForUI();
      const count = countMenuItems(menu);
      if (count > 0) {
        res.json({ ok: true, itemCount: count, sampleOutput: `✓ Fetched ${count} menu item(s) from your backend.` });
      } else {
        res.json({
          ok: true, itemCount: 0,
          sampleOutput:
            'Connected, but the menu came back empty. This usually means one of:\n' +
            '•  the endpoint needs an API key — add it above, or\n' +
            '•  it needs a required filter (e.g. branch_id / location_id), or\n' +
            '•  the menu lives at a different path.\n' +
            'Use "Detect requirements" on the Menu / Add to Cart operations to add what it needs, then test again.',
        });
      }
      return;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        const status = err.response.status;
        const hint =
          status === 401 || status === 403 ? 'Authentication failed — check your API key.'
          : status === 404                 ? 'Path not found — check the Menu endpoint path in Advanced settings.'
          :                                  'The backend errored on this request.';
        res.json({ ok: status < 500, sampleOutput: `Backend responded HTTP ${status}. ${hint}`,
          error: status >= 500 ? `Backend error HTTP ${status}` : undefined });
        return;
      }
    }

    // 2. Last resort — is the host even reachable?
    try {
      await axios.get(base, { timeout: 8_000, validateStatus: () => true });
      res.json({ ok: true, sampleOutput: 'Host is reachable, but the menu endpoint returned no data. Check the path, API key, and required filters.' });
    } catch {
      res.json({ ok: false, error: 'Could not reach the server. Check the URL and that the backend is running.' });
    }
  });

  // ── Endpoint discovery (probe) ──────────────────────────────────────────────
  // Figures out what a POS endpoint requires (auth, required params/filters) via
  // OpenAPI import or a live probe, so the onboarding UI can pop input fields.
  app.post('/api/admin/probe-endpoint', requireAuth, async (req: Request, res: Response) => {
    const { tenantId } = req.jwtPayload!;
    const { baseUrl, path, method, apiKey } = req.body as
      { baseUrl?: string; path?: string; method?: string; apiKey?: string };
    if (!baseUrl || !path) { res.status(400).json({ error: 'baseUrl and path are required' }); return; }

    const verb = (method ?? 'GET').toUpperCase();
    const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (!allowed.includes(verb)) { res.status(400).json({ error: 'Invalid method' }); return; }

    // Use the key the onboarder just typed, else fall back to saved credentials.
    let key = apiKey;
    let secret: string | undefined;
    if (!key) {
      try {
        const blob = await getRedis().get<EncryptedBlob>(redisKey.credentialsKey(tenantId));
        if (blob) { const c = decryptCredentials(blob); key = c.apiKey; secret = c.apiSecret; }
      } catch { /* no saved creds — probe unauthenticated */ }
    }

    try {
      const result = await probeEndpoint({ baseUrl, path, method: verb as HttpMethod, apiKey: key, apiSecret: secret });
      res.json(result);
    } catch (err) {
      console.error('[PROBE] failed:', err);
      res.status(502).json({ error: 'Probe failed', message: String(err) });
    }
  });

  // ── Adapter credentials (encrypted at rest) ───────────────────────────────
  // Stores baseUrl + apiKey (and optional extras) encrypted with AES-256-GCM.
  // The plaintext never appears in logs, audit entries, or TenantConfig exports.

  app.post('/api/admin/save-credentials', requireAuth, async (req: Request, res: Response) => {
    const { role, tenantId } = req.jwtPayload!;
    if (role !== 'tenant_admin' && role !== 'super_admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    const incoming = req.body as Partial<AdapterCredentials>;
    // Accept POS/backend creds AND payment-gateway creds. At least one connection
    // identifier must be present so we don't store an empty blob.
    const hasSomething =
      incoming.baseUrl || incoming.webhookUrl || incoming.apiKey ||
      incoming.paymentApiKey || incoming.paymentWebhookSecret;
    if (!hasSomething) {
      res.status(400).json({ error: 'baseUrl, webhookUrl, or payment credentials are required' }); return;
    }

    try {
      const redis = getRedis();
      // Merge with existing credentials so saving POS keys doesn't wipe payment
      // keys (and vice-versa). Only fields actually sent are overwritten; an
      // empty-string field is treated as "clear", undefined as "leave as-is".
      let existing: AdapterCredentials = {};
      try {
        const prevBlob = await redis.get<EncryptedBlob>(redisKey.credentialsKey(tenantId));
        if (prevBlob) existing = decryptCredentials(prevBlob);
      } catch { /* no prior creds — start fresh */ }

      const merged: AdapterCredentials = { ...existing };
      for (const [k, v] of Object.entries(incoming)) {
        if (v !== undefined) merged[k] = v === '' ? undefined : v;
      }

      const blob = encryptCredentials(merged);
      await redis.set(redisKey.credentialsKey(tenantId), blob);
      void writeAuditLog(tenantId, 'credentials_save', req.jwtPayload!.sub);
      void dualWrite('adapter_credentials.upsert', credentialsRepo.upsert(tenantId, blob));
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('CREDENTIAL_ENCRYPTION_KEY')) {
        res.status(500).json({ error: 'Server not configured for credential encryption — set CREDENTIAL_ENCRYPTION_KEY' });
      } else {
        res.status(500).json({ error: 'Failed to save credentials' });
      }
    }
  });

  app.get('/api/admin/credentials-status', requireAuth, async (req: Request, res: Response) => {
    const { tenantId } = req.jwtPayload!;
    try {
      const redis = getRedis();
      const blob  = await redis.get(redisKey.credentialsKey(tenantId));
      if (!blob) { res.json({ hasCredentials: false }); return; }
      // Decrypt just to get the non-secret URLs — never return the key/secret
      const creds = decryptCredentials(blob as Parameters<typeof decryptCredentials>[0]);
      res.json({ hasCredentials: true, baseUrl: creds.baseUrl ?? '', webhookUrl: creds.webhookUrl ?? '' });
    } catch {
      res.json({ hasCredentials: false });
    }
  });

  // ── Audit log ─────────────────────────────────────────────────────────────
  app.get('/api/admin/audit-log', requireAuth, async (req: Request, res: Response) => {
    const { tenantId, role } = req.jwtPayload!;
    const targetId = role === 'super_admin'
      ? ((req.query.tenantId as string | undefined) ?? tenantId)
      : tenantId;
    try {
      const redis   = getRedis();
      const entries = await redis.lrange(redisKey.auditLog(targetId), 0, 49);
      res.json(entries);
    } catch (err) {
      console.error('[AUDIT] Failed to read log:', err);
      res.status(500).json({ error: 'Failed to read audit log' });
    }
  });

  // ── Usage metrics ──────────────────────────────────────────────────────────
  app.post('/api/admin/report-usage', requireAuth, async (req: Request, res: Response) => {
    const { tenantId } = req.jwtPayload!;
    const { promptTokens = 0, responseTokens = 0, costUsd = 0 } =
      req.body as { promptTokens?: number; responseTokens?: number; costUsd?: number };
    const date = new Date().toISOString().slice(0, 10);
    const key  = redisKey.usage(tenantId, date);
    try {
      const redis = getRedis();
      await Promise.all([
        redis.hincrby(key, 'promptTokens',   Math.round(promptTokens)),
        redis.hincrby(key, 'responseTokens', Math.round(responseTokens)),
        redis.hincrby(key, 'callCount',      1),
        redis.hincrby(key, 'costUsdMicro',   Math.round(costUsd * 1_000_000)),
      ]);
      await redis.expire(key, TTL.USAGE_HASH);
      res.json({ ok: true });
    } catch {
      res.json({ ok: false });
    }
  });

  app.get('/api/admin/usage', requireAuth, async (req: Request, res: Response) => {
    const { tenantId, role } = req.jwtPayload!;
    const targetId = role === 'super_admin'
      ? ((req.query.tenantId as string | undefined) ?? tenantId)
      : tenantId;
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    try {
      const redis   = getRedis();
      const results = [];
      for (let i = days - 1; i >= 0; i--) {
        const d   = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const raw = await redis.hgetall<Record<string, string>>(redisKey.usage(targetId, d));
        results.push({
          date:           d,
          promptTokens:   Number(raw?.promptTokens   ?? 0),
          responseTokens: Number(raw?.responseTokens ?? 0),
          callCount:      Number(raw?.callCount       ?? 0),
          costUsd:        Number(raw?.costUsdMicro    ?? 0) / 1_000_000,
        });
      }
      res.json(results);
    } catch (err) {
      console.error('[USAGE] Failed to read usage:', err);
      res.status(500).json({ error: 'Failed to read usage' });
    }
  });

  // ── Super admin: list all tenants ─────────────────────────────────────────
  app.get('/api/super/tenants', requireSuperAdmin, async (_req: Request, res: Response) => {
    try {
      const redis     = getRedis();
      const tenantIds = (await redis.smembers(redisKey.tenantsIndex)) as string[];
      const configs   = await Promise.all(
        tenantIds.map(id => redis.get<unknown>(redisKey.tenantConfig(id)).catch(() => null))
      );
      const tenants = configs
        .map((cfg, i) => (cfg ? { tenantId: tenantIds[i], ...(cfg as Record<string, unknown>) } : null))
        .filter(Boolean);
      res.json(tenants);
    } catch (err) {
      console.error('[SUPER] tenants list failed:', err);
      res.status(500).json({ error: 'Failed to load tenants' });
    }
  });

  // ── Super admin: impersonate tenant ───────────────────────────────────────
  app.post('/api/super/tenants/:tenantId/impersonate', requireSuperAdmin, async (req: Request, res: Response) => {
    const { tenantId } = req.params;
    if (!UUID_RE.test(tenantId)) { res.status(400).json({ error: 'Invalid tenant ID' }); return; }
    try {
      const redis  = getRedis();
      const config = await redis.get<{ slug?: string }>(redisKey.tenantConfig(tenantId));
      if (!config) { res.status(404).json({ error: 'Tenant not found' }); return; }
      const impJwt = issueJwt({ sub: req.jwtPayload!.sub, tenantId, role: 'tenant_admin', slug: config.slug ?? tenantId });
      void writeAuditLog(tenantId, 'impersonate', req.jwtPayload!.sub, 'impersonated by super_admin');
      res.json({ jwtToken: impJwt, slug: config.slug });
    } catch (err) {
      console.error('[SUPER] impersonate failed:', err);
      res.status(500).json({ error: 'Impersonation failed' });
    }
  });

  // ── Super admin: adapter templates (static) ────────────────────────────────
  app.get('/api/super/adapter-templates', requireSuperAdmin, (_req: Request, res: Response) => {
    res.json([
      {
        id: 'managed', name: 'Managed Backend (Render)',
        description: 'Use the shared Savour Foods Render backend — no configuration needed.',
        adapterConfig: { type: 'managed' },
      },
      {
        id: 'custom_api', name: 'Custom REST API',
        description: 'Connect to your own backend. Provide a base URL and optional auth header.',
        adapterConfig: { type: 'custom_api', baseUrl: 'https://your-backend.example.com', authHeader: '' },
      },
      {
        id: 'foodics', name: 'Foodics POS',
        description: 'Pre-configured for Foodics Cloud POS API v5.',
        adapterConfig: { type: 'custom_api', baseUrl: 'https://api.foodics.com/v5', authHeader: 'Bearer YOUR_TOKEN' },
      },
      {
        id: 'airtable', name: 'Airtable Menu',
        description: 'Read-only menu from Airtable; orders POST to a Zapier/Make webhook.',
        adapterConfig: { type: 'custom_api', baseUrl: 'https://api.airtable.com/v0/YOUR_BASE', authHeader: 'Bearer YOUR_API_KEY' },
      },
    ]);
  });

  // ── Admin: menu data CRUD ─────────────────────────────────────────────────
  app.get('/api/admin/menu', requireAuth, async (req: Request, res: Response) => {
    const { tenantId } = req.jwtPayload!;
    // Supabase-backed tenants don't have an editable Redis menu — surface a
    // clear empty state so the admin UI shows "read-only" rather than the
    // stale `menu:data:<id>` blob that may still be lying around in Redis.
    if (SUPABASE_MENU_TENANTS.has(tenantId)) {
      res.json({ categories: [], items: [], readOnly: true, source: 'supabase_v_menu' });
      return;
    }
    try {
      const redis    = getRedis();
      const menuData = await redis.get<MenuData>(redisKey.menuData(tenantId));
      res.json(menuData ?? { categories: [], items: [] });
    } catch (err) {
      console.error('[MENU] Failed to get menu data:', err);
      res.status(500).json({ error: 'Failed to load menu' });
    }
  });

  app.post('/api/admin/menu', requireAuth, async (req: Request, res: Response) => {
    const { role, tenantId } = req.jwtPayload!;
    if (role !== 'tenant_admin' && role !== 'super_admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    // Supabase-backed tenants own their menu in v_menu. The admin panel must
    // not be able to write `menu:data:<id>` or push to Render for these — that
    // is exactly the path that previously contaminated Savour's menu cache.
    if (SUPABASE_MENU_TENANTS.has(tenantId)) {
      res.status(403).json({
        error: 'Menu for this tenant is sourced from Supabase v_menu and cannot be edited from this panel.',
      });
      return;
    }
    const body = req.body as { categories?: unknown; items?: unknown };
    if (!Array.isArray(body.categories) || !Array.isArray(body.items)) {
      res.status(400).json({ error: 'categories and items arrays are required' }); return;
    }
    const menuData: MenuData = {
      categories: body.categories as MenuCategoryRow[],
      items:      body.items as MenuItemRow[],
    };
    try {
      const redis = getRedis();
      await redis.set(redisKey.menuData(tenantId), menuData);
      // Rebuild Gemini menu context markdown and overwrite the cache
      const configRaw = await redis.get<unknown>(redisKey.tenantConfig(tenantId)).catch(() => null);
      if (configRaw) {
        try {
          const config = parseTenantConfig(configRaw);
          const md     = buildMenuMarkdown(menuData, config);
          await redis.set(redisKey.menuContext(tenantId), md, { ex: TTL.MENU_CONTEXT });
        } catch { /* non-fatal — cache regenerated on next request */ }
      }
      void writeAuditLog(tenantId, 'menu_save', req.jwtPayload!.sub,
        `categories=${menuData.categories.length} items=${menuData.items.length}`);

      // Forward to FastAPI backend so dishes land in Supabase for resolve-item fuzzy matching.
      // Shape matches admin_service.py DishIn: category, name, description, price, base_price, tag, available
      const flatDishes = menuData.items.map(item => {
        const cat = menuData.categories.find(c => c.id === item.categoryId);
        return {
          category:    cat?.name ?? 'Uncategorised',
          name:        item.name,
          description: item.description,
          price:       item.price,
          base_price:  item.price,
          tag:         '',
          available:   item.available,
        };
      });

      let syncOk = false;
      let syncError: string | undefined;
      try {
        await axios.post(
          `${BACKEND_URL}/api/v1/admin/menu`,
          { dishes: flatDishes },
          { headers: { 'X-Tenant-ID': tenantId }, timeout: 10_000 },
        );
        syncOk = true;
        console.log(`[MENU] FastAPI sync succeeded for tenant ${tenantId} (${flatDishes.length} dishes)`);
      } catch (err) {
        syncError = axios.isAxiosError(err)
          ? ((err.response?.data as { detail?: string })?.detail ?? err.message)
          : String(err);
        console.warn('[MENU] FastAPI sync failed:', syncError);
      }

      res.json({ ok: true, syncOk, ...(syncError ? { syncError } : {}) });
    } catch (err) {
      console.error('[MENU] Failed to save menu data:', err);
      res.status(500).json({ error: 'Failed to save menu' });
    }
  });

  // ── Admin: manually re-sync saved menu to FastAPI/Supabase ──────────────────
  app.post('/api/admin/menu/sync', requireAuth, async (req: Request, res: Response) => {
    const { role, tenantId } = req.jwtPayload!;
    if (role !== 'tenant_admin' && role !== 'super_admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    if (SUPABASE_MENU_TENANTS.has(tenantId)) {
      res.status(403).json({
        error: 'Menu for this tenant is sourced from Supabase v_menu — no sync needed.',
      });
      return;
    }
    try {
      const redis    = getRedis();
      const menuData = await redis.get<MenuData>(redisKey.menuData(tenantId));
      if (!menuData) { res.status(404).json({ error: 'No menu saved yet — save the menu first.' }); return; }

      const flatDishes = menuData.items.map(item => {
        const cat = menuData.categories.find(c => c.id === item.categoryId);
        return {
          category:    cat?.name ?? 'Uncategorised',
          name:        item.name,
          description: item.description,
          price:       item.price,
          base_price:  item.price,
          tag:         '',
          available:   item.available,
        };
      });

      // Ensure tenant row exists before inserting dishes (FK constraint).
      // Non-fatal: if the tenant already exists the upsert is a no-op; if the
      // backend is cold-starting we still attempt the menu sync below (it will
      // surface a clearer FK error if the row is truly missing).
      const configRaw = await redis.get<{ restaurantName?: string; slug?: string; plan?: string }>(redisKey.tenantConfig(tenantId)).catch(() => null);
      try {
        await ensureTenantInBackend(
          tenantId,
          configRaw?.slug  ?? tenantId,
          configRaw?.restaurantName ?? tenantId,
          configRaw?.plan  ?? 'starter',
        );
      } catch (ensureErr) {
        // Surface the real error instead of masking it behind the downstream
        // FK violation on categories. If we couldn't create the tenant row
        // there's no point trying to insert child rows that depend on it.
        const ensureMsg = axios.isAxiosError(ensureErr)
          ? ((ensureErr.response?.data as { detail?: string })?.detail ?? ensureErr.message)
          : String(ensureErr);
        console.error('[MENU] ensure-tenant failed — aborting sync:', ensureMsg);
        res.status(502).json({ ok: false, error: `ensure-tenant failed: ${ensureMsg}` });
        return;
      }

      await axios.post(
        `${BACKEND_URL}/api/v1/admin/menu`,
        { dishes: flatDishes },
        { headers: { 'X-Tenant-ID': tenantId }, timeout: 30_000 },
      );
      void writeAuditLog(tenantId, 'menu_sync', req.jwtPayload!.sub, `items=${menuData.items.length}`);
      console.log(`[MENU] Manual sync succeeded for tenant ${tenantId} (${flatDishes.length} dishes)`);
      res.json({ ok: true });
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? ((err.response?.data as { detail?: string })?.detail ?? err.message)
        : String(err);
      console.warn('[MENU] Manual sync failed:', msg);
      res.status(502).json({ ok: false, error: msg });
    }
  });

  // ── Agent routes — all go through the adapter ───────────────────────────────
  app.use('/api/agent/', attachAdapter);

  app.get('/api/agent/menu-context', async (req: Request, res: Response) => {
    const tenantId = req.tenantConfig?.tenantId;
    // Tenant-scoped: never let an intermediary or the browser hold a 304 that
    // could later be replayed for a different tenant.
    res.set('Cache-Control', 'no-store, must-revalidate');
    try {
      if (tenantId) {
        // 0. Supabase-backed tenants: bypass Redis admin-managed cache entirely.
        if (SUPABASE_MENU_TENANTS.has(tenantId) && req.tenantConfig) {
          const supaMenu = await getSupabaseMenu(tenantId);
          if (supaMenu) {
            const md = buildMenuMarkdown(supaMenu, req.tenantConfig);
            res.type('text/plain').send(md);
            return;
          }
          // Supabase failed — fall through to adapter so kiosk still works
          console.warn(`[MENU] Supabase fetch failed for ${tenantId}; falling back to adapter`);
        }

        try {
          const redis = getRedis();
          // 1. Check rendered markdown cache
          const cached = await redis.get<string>(redisKey.menuContext(tenantId));
          if (cached) {
            console.log(`[MENU] Cache hit for tenant ${tenantId}`);
            res.type('text/plain').send(cached);
            return;
          }
          // 2. Check raw menu data — build markdown from it (admin-managed menu)
          const menuData = await redis.get<MenuData>(redisKey.menuData(tenantId));
          if (menuData && req.tenantConfig) {
            const md = buildMenuMarkdown(menuData, req.tenantConfig);
            await redis.set(redisKey.menuContext(tenantId), md, { ex: TTL.MENU_CONTEXT }).catch(() => undefined);
            res.type('text/plain').send(md);
            return;
          }
        } catch {
          // Redis unavailable — fall through to adapter
        }
      }

      // 3. Fall through to backend adapter (managed / custom_api)
      const text = await req.adapter!.getMenuContext();

      if (tenantId && !SUPABASE_MENU_TENANTS.has(tenantId)) {
        try {
          const redis = getRedis();
          await redis.set(redisKey.menuContext(tenantId), text, { ex: TTL.MENU_CONTEXT });
        } catch {
          // Non-fatal
        }
      }

      res.type('text/plain').send(text);
    } catch (err) { adapterError(res, err); }
  });

  app.post('/api/agent/resolve-item', async (req: Request, res: Response) => {
    const b = req.body as { session_id: string; dish_query: string; modifiers?: string[]; quantity?: number; notes?: string | null };
    const tenantId = req.tenantConfig?.tenantId;

    // Local path: tenant has an admin-managed menu in Redis
    if (tenantId) {
      const menu = await getLocalMenu(tenantId);
      if (menu) {
        const qty   = b.quantity || 1;
        const mods  = (b.modifiers ?? []).filter(Boolean);
        const match = fuzzyMatchItem(b.dish_query, menu.items);
        if (!match) {
          res.json({
            status: 'not_found', cart_item_id: null, summary: null, unit_price: null,
            ai_instruction: `I couldn't find '${b.dish_query}' on the menu. Could you clarify what you'd like?`,
          });
          return;
        }
        const cat     = menu.categories.find(c => c.id === match.categoryId);
        const summary = mods.length > 0
          ? `${match.name} × ${qty} (${mods.join(', ')})`
          : `${match.name} × ${qty}`;
        const cartItemId = crypto.randomUUID();
        try {
          const redis    = getRedis();
          const cartKey  = redisKey.localCart(tenantId, b.session_id);
          const existing = (await redis.get<LocalCartItem[]>(cartKey)) ?? [];
          const newItem: LocalCartItem = {
            cart_item_id: cartItemId, name: match.name,
            category: cat?.name ?? '', summary, quantity: qty,
            unit_price: match.price, modifiers: mods, notes: b.notes ?? null,
          };
          await redis.set(cartKey, [...existing, newItem], { ex: TTL.LOCAL_CART });
        } catch { /* non-fatal — cart may not persist but the kiosk maintains its own state */ }
        console.log(`[LOCAL] resolve-item: "${b.dish_query}" → "${match.name}" for tenant ${tenantId}`);
        res.json({ status: 'ok', summary, unit_price: match.price, cart_item_id: cartItemId });
        return;
      }
    }

    // Render-backend path (Savour Foods and any tenant without a local menu)
    try {
      const result = await req.adapter!.resolveItem({
        sessionId: b.session_id, dishQuery: b.dish_query,
        modifiers: b.modifiers,  quantity:  b.quantity,  notes: b.notes,
      });
      res.json(result);
    } catch (err) { adapterError(res, err); }
  });

  app.post('/api/agent/remove-item', async (req: Request, res: Response) => {
    const b        = req.body as { session_id: string; cart_item_id: string };
    const tenantId = req.tenantConfig?.tenantId;
    if (tenantId) {
      const menu = await getLocalMenu(tenantId);
      if (menu) {
        try {
          const redis   = getRedis();
          const cartKey = redisKey.localCart(tenantId, b.session_id);
          const items   = (await redis.get<LocalCartItem[]>(cartKey)) ?? [];
          await redis.set(cartKey, items.filter(i => i.cart_item_id !== b.cart_item_id), { ex: TTL.LOCAL_CART });
        } catch { /* non-fatal */ }
        res.json({ ok: true }); return;
      }
    }
    try { await req.adapter!.removeItem(b.session_id, b.cart_item_id); res.json({ ok: true }); }
    catch (err) { adapterError(res, err); }
  });

  app.post('/api/agent/clear-cart', async (req: Request, res: Response) => {
    const b        = req.body as { session_id: string };
    const tenantId = req.tenantConfig?.tenantId;
    if (tenantId) {
      const menu = await getLocalMenu(tenantId);
      if (menu) {
        try { await getRedis().del(redisKey.localCart(tenantId, b.session_id)); } catch { /* non-fatal */ }
        res.json({ ok: true }); return;
      }
    }
    try { await req.adapter!.clearCart(b.session_id); res.json({ ok: true }); }
    catch (err) { adapterError(res, err); }
  });

  app.get('/api/agent/cart/:sessionId', async (req: Request, res: Response) => {
    if (!UUID_RE.test(req.params.sessionId)) {
      res.status(400).json({ error: 'Invalid session ID format' }); return;
    }
    const tenantId = req.tenantConfig?.tenantId;
    if (tenantId) {
      const menu = await getLocalMenu(tenantId);
      if (menu) {
        try {
          const items = (await getRedis().get<LocalCartItem[]>(redisKey.localCart(tenantId, req.params.sessionId))) ?? [];
          res.json(items.map(toWireCartItem)); return;
        } catch (err) {
          // Previously `res.json([])` — a Redis outage was reported as "cart is
          // empty" with a 200. An error must never be indistinguishable from an
          // empty result; fail loudly so the caller can retry or surface it.
          console.error('[LOCAL] get-cart failed:', err);
          res.status(500).json({ error: 'Failed to load cart' }); return;
        }
      }
    }
    try { res.json(await req.adapter!.getCart(req.params.sessionId)); }
    catch (err) { adapterError(res, err); }
  });

  app.post('/api/agent/submit-order', async (req: Request, res: Response) => {
    const b = req.body as {
      session_id: string; customer_name?: string; customer_phone?: string;
      order_type?: string; payment_method?: string; delivery_fee?: number;
      discount?: number; instructions?: string | null; notes?: string | null;
      // Inline cart sent by the frontend — used as primary source so Redis cart
      // persistence failures don't block order submission.
      cart_items?: Array<{ cart_item_id?: string; summary: string; quantity: number; unit_price: number; notes?: string | null }>;
    };
    const tenantId = req.tenantConfig?.tenantId;

    if (tenantId) {
      const menu = await getLocalMenu(tenantId);
      if (menu) {
        try {
          const redis    = getRedis();
          const cartKey  = redisKey.localCart(tenantId, b.session_id);

          // Prefer Redis cart (has full detail); fall back to inline cart_items from body
          const redisItems  = await redis.get<LocalCartItem[]>(cartKey).catch(() => null) ?? [];
          const inlineItems: LocalCartItem[] = (b.cart_items ?? []).map(i => ({
            cart_item_id: i.cart_item_id ?? crypto.randomUUID(),
            name:         i.summary,
            category:     '',
            summary:      i.summary,
            quantity:     i.quantity,
            unit_price:   i.unit_price,
            modifiers:    [],
            notes:        i.notes ?? null,
          }));
          const items = redisItems.length > 0 ? redisItems : inlineItems;
          if (items.length === 0) { res.status(400).json({ error: 'Cart is empty' }); return; }

          const cfg       = req.tenantConfig!;
          const subtotal  = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
          const gst       = Math.round(subtotal * cfg.businessRules.gstRate);
          const total     = subtotal + gst;
          const orderNum  = await redis.incr(redisKey.localOrderCounter(tenantId));
          const orderId   = crypto.randomUUID();
          const now       = new Date().toISOString();

          const order: LocalOrder = {
            id: orderId, order_number: orderNum, tenant_id: tenantId, status: 'pending',
            items, subtotal, total,
            customer_name:  b.customer_name  ?? 'Guest',
            customer_phone: b.customer_phone ?? '',
            order_type:     b.order_type     ?? 'dine_in',
            payment_method: b.payment_method ?? 'cash',
            notes: b.notes ?? b.instructions ?? null,
            created_at: now, updated_at: now,
          };

          // If this tenant collects payment online, create a checkout session
          // up-front so the kiosk can redirect the customer. The order stays
          // 'pending' until the signed webhook confirms capture (truth = webhook,
          // not the client). Cash tenants skip this entirely — unchanged.
          let payment: { providerRef: string; redirectUrl?: string; clientToken?: string; status: string } | undefined;
          if (PaymentProviderFactory.isOnline(cfg) && req.paymentProvider) {
            try {
              const amountPaisa = rupeesToPaisa(total);
              const checkout    = await req.paymentProvider.createCheckout({
                orderId, amountPaisa, currency: cfg.businessRules.currency,
                customerName: order.customer_name, customerPhone: order.customer_phone,
              });
              order.payment_method = req.paymentProvider.id;
              order.payment_status = checkout.status;
              order.payment_ref    = checkout.providerRef;
              await savePaymentTxn(redis, {
                providerRef: checkout.providerRef, provider: req.paymentProvider.id,
                tenantId, orderId, amountPaisa, currency: cfg.businessRules.currency,
                status: checkout.status, method: 'card', createdAt: now, updatedAt: now,
              });
              payment = {
                providerRef: checkout.providerRef, redirectUrl: checkout.redirectUrl,
                clientToken: checkout.clientToken, status: checkout.status,
              };
            } catch (err) {
              // Never lose the order over a gateway hiccup — record it unpaid so
              // staff can collect manually, and surface the failure to the caller.
              console.error('[PAYMENT] checkout creation failed:', err);
              order.payment_status = 'failed';
            }
          }

          await redis.set(redisKey.localOrder(orderId), order, { ex: TTL.LOCAL_ORDER });
          await redis.lpush(redisKey.localOrders(tenantId), orderId);
          await redis.ltrim(redisKey.localOrders(tenantId), 0, 499);
          await redis.del(cartKey);

          console.log(`[LOCAL] Order #${orderNum} created for tenant ${tenantId}`);
          res.status(201).json({ id: orderId, order_id: orderId, order_number: orderNum, total, summary: `Order #${orderNum}`, payment });
        } catch (err) {
          console.error('[LOCAL] submit-order failed:', err);
          res.status(500).json({ error: 'Failed to submit order' });
        }
        return;
      }
    }

    // Render-backend path
    try {
      const result = await req.adapter!.submitOrder({
        sessionId:      b.session_id,   customerName:  b.customer_name,
        customerPhone:  b.customer_phone, orderType:   b.order_type,
        paymentMethod:  b.payment_method, deliveryFee: b.delivery_fee,
        discount:       b.discount,     instructions:  b.instructions,  notes: b.notes,
      });
      res.status(201).json(result);
    } catch (err) { adapterError(res, err); }
  });

  // ── Payments (Safepay etc.) ─────────────────────────────────────────────────
  // checkout + status are tenant-scoped (need req.paymentProvider); the webhook
  // is called server-to-server by the gateway with no auth, so it resolves the
  // tenant from the stored transaction instead of attachAdapter.
  app.use('/api/payments/checkout', attachAdapter);
  app.use('/api/payments/status',   attachAdapter);

  // Create a checkout session for an existing local order. Returns the hosted
  // checkout URL the kiosk redirects the customer to.
  app.post('/api/payments/checkout', async (req: Request, res: Response) => {
    const tenantId = req.tenantConfig?.tenantId;
    const provider = req.paymentProvider;
    if (!tenantId || !provider) { res.status(400).json({ error: 'Tenant or payment provider unavailable' }); return; }
    if (provider.id === 'cash') { res.status(400).json({ error: 'Tenant is not configured for online payment' }); return; }

    const { order_id, redirect_url, cancel_url } = req.body as
      { order_id?: string; redirect_url?: string; cancel_url?: string };
    if (!order_id) { res.status(400).json({ error: 'order_id is required' }); return; }

    try {
      const redis = getRedis();
      const order = await redis.get<LocalOrder>(redisKey.localOrder(order_id));
      if (!order || order.tenant_id !== tenantId) { res.status(404).json({ error: 'Order not found' }); return; }

      const amountPaisa = rupeesToPaisa(order.total);
      const checkout    = await provider.createCheckout({
        orderId: order_id, amountPaisa, currency: req.tenantConfig!.businessRules.currency,
        customerName: order.customer_name, customerPhone: order.customer_phone,
        redirectUrl: redirect_url, cancelUrl: cancel_url,
      });

      const now = new Date().toISOString();
      order.payment_method = provider.id;
      order.payment_status = checkout.status;
      order.payment_ref    = checkout.providerRef;
      await redis.set(redisKey.localOrder(order_id), order, { ex: TTL.LOCAL_ORDER });
      await savePaymentTxn(redis, {
        providerRef: checkout.providerRef, provider: provider.id, tenantId,
        orderId: order_id, amountPaisa, currency: req.tenantConfig!.businessRules.currency,
        status: checkout.status, method: 'card', createdAt: now, updatedAt: now,
      });

      res.json({
        providerRef: checkout.providerRef, redirectUrl: checkout.redirectUrl,
        clientToken: checkout.clientToken, status: checkout.status,
      });
    } catch (err) {
      console.error('[PAYMENT] checkout failed:', err);
      res.status(502).json({ error: 'Payment gateway error' });
    }
  });

  // Inbound gateway webhook. Public — authenticity is proven by the HMAC
  // signature, not by a session. Tenant is resolved from the stored transaction.
  app.post('/api/payments/:provider/webhook', async (req: Request, res: Response) => {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');

    // Read the providerRef untrusted, only to locate which tenant's secret to
    // verify against. The signature check below still validates the full body.
    let refHint = '';
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      const data   = (parsed.data ?? {}) as Record<string, unknown>;
      refHint = String(data.tracker ?? data.token ?? data.reference ?? parsed.tracker ?? parsed.token ?? '');
    } catch { /* refHint stays empty */ }
    if (!refHint) { res.status(400).json({ error: 'Missing payment reference' }); return; }

    try {
      const redis = getRedis();
      const txn   = await redis.get<PaymentTransaction>(redisKey.payment(refHint));
      if (!txn) { res.status(404).json({ error: 'Unknown payment reference' }); return; }

      // Rebuild this tenant's provider so verifyWebhook uses the right secret.
      let credentials: AdapterCredentials = {};
      try {
        const blob = await redis.get<EncryptedBlob>(redisKey.credentialsKey(txn.tenantId));
        if (blob) credentials = decryptCredentials(blob);
      } catch { /* no creds → verification will fail safely below */ }
      const provider = PaymentProviderFactory.createById(txn.provider, credentials);

      const result = provider.verifyWebhook(raw, req.headers);
      if (!result.signatureValid) {
        console.warn(`[PAYMENT] webhook signature INVALID for ref ${refHint} (tenant ${txn.tenantId})`);
        res.status(401).json({ error: 'Invalid signature' }); return;
      }

      // Idempotent: re-deliveries of an already-final state are no-ops.
      const now = new Date().toISOString();
      if (txn.status !== result.status) {
        txn.status    = result.status;
        txn.updatedAt = now;
        await redis.set(redisKey.payment(refHint), txn, { ex: TTL.PAYMENT });

        const order = await redis.get<LocalOrder>(redisKey.localOrder(txn.orderId));
        if (order) {
          order.payment_status = result.status;
          order.updated_at     = now;
          // On capture, advance a still-pending order so the kitchen sees a paid order.
          if (result.status === 'captured' && order.status === 'pending') order.status = 'confirmed';
          await redis.set(redisKey.localOrder(txn.orderId), order, { ex: TTL.LOCAL_ORDER });
        }
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[PAYMENT] webhook handling failed:', err);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // Polling fallback for a missed webhook (cold start / network blip).
  app.get('/api/payments/status/:providerRef', async (req: Request, res: Response) => {
    const tenantId    = req.tenantConfig?.tenantId;
    const providerRef = req.params.providerRef;
    if (!tenantId) { res.status(400).json({ error: 'Tenant unavailable' }); return; }
    try {
      const redis = getRedis();
      const txn   = await redis.get<PaymentTransaction>(redisKey.payment(providerRef));
      if (!txn || txn.tenantId !== tenantId) { res.status(404).json({ error: 'Payment not found' }); return; }

      // If still open, ask the gateway directly and reconcile.
      if (req.paymentProvider && txn.status === 'initiated') {
        try {
          const live = await req.paymentProvider.getStatus(providerRef);
          if (live.status !== txn.status) {
            txn.status = live.status; txn.updatedAt = new Date().toISOString();
            await redis.set(redisKey.payment(providerRef), txn, { ex: TTL.PAYMENT });
          }
        } catch { /* gateway unreachable — return last-known status */ }
      }

      res.json({ providerRef, status: txn.status, amountRupees: paisaToRupees(txn.amountPaisa) });
    } catch (err) {
      console.error('[PAYMENT] status failed:', err);
      res.status(500).json({ error: 'Failed to read payment status' });
    }
  });

  // ── Menu + Orders routes — also through adapter ─────────────────────────────
  app.use('/api/menu',   attachAdapter);
  app.use('/api/orders', attachAdapter);

  app.get('/api/menu', async (req: Request, res: Response) => {
    const tenantId = req.tenantConfig?.tenantId;
    const cur      = req.tenantConfig?.businessRules.currencySymbol ?? '$';
    // Tenant-scoped: prevent a 304 from carrying another tenant's body.
    res.set('Cache-Control', 'no-store, must-revalidate');

    const buildUiMenu = (menuData: MenuData) => menuData.categories
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(cat => ({
        id:    cat.id,
        name:  cat.name,
        items: menuData.items
          .filter(i => i.categoryId === cat.id)
          .map(i => ({
            id:             i.id,
            name:           i.name,
            description:    i.description,
            price:          i.price,
            available:      i.available,
            category:       cat.name,
            currencySymbol: cur,
          })),
      }));

    try {
      // 0. Supabase-backed tenants: bypass Redis admin-managed and Render entirely.
      if (tenantId && SUPABASE_MENU_TENANTS.has(tenantId)) {
        const supaMenu = await getSupabaseMenu(tenantId);
        if (supaMenu) { res.json(buildUiMenu(supaMenu)); return; }
        console.warn(`[MENU] Supabase fetch failed for ${tenantId}; falling back to adapter`);
        // fall through so kiosk still renders something during a Supabase outage
      }

      // 1. Admin-managed menu in Redis (non-Supabase tenants only)
      if (tenantId) {
        try {
          const redis    = getRedis();
          const menuData = await redis.get<MenuData>(redisKey.menuData(tenantId));
          if (menuData) { res.json(buildUiMenu(menuData)); return; }
        } catch {
          // Redis unavailable — fall through to adapter
        }
      }
      // 2. Render-backed adapter
      const menu = await req.adapter!.getMenuForUI();
      res.json(menu);
    } catch (err) { adapterError(res, err); }
  });

  app.post('/api/orders', async (req: Request, res: Response) => {
    // Direct order creation (not via agent) — forward body as submit-order
    const b = req.body as { session_id?: string; [k: string]: unknown };
    try {
      const result = await req.adapter!.submitOrder({
        sessionId:    (b.session_id as string) ?? 'direct',
        customerName: b.customer_name as string | undefined,
        orderType:    b.order_type as string | undefined,
      });
      res.status(201).json(result);
    } catch (err) { adapterError(res, err); }
  });

  app.get('/api/orders', async (req: Request, res: Response) => {
    const q        = req.query as Record<string, string>;
    const tenantId = req.tenantConfig?.tenantId;

    if (tenantId) {
      const menu = await getLocalMenu(tenantId);
      if (menu) {
        try {
          const redis    = getRedis();
          const ids      = await redis.lrange(redisKey.localOrders(tenantId), 0, 99);
          const orders   = (await Promise.all(ids.map(id => redis.get<LocalOrder>(redisKey.localOrder(id)).catch(() => null))))
            .filter((o): o is LocalOrder => o !== null);
          const filtered = q.status ? orders.filter(o => o.status === q.status) : orders;
          res.json(filtered.map(toWireOrder)); return;
        } catch (err) {
          console.error('[LOCAL] get-orders failed:', err);
          res.status(500).json({ error: 'Failed to load orders' }); return;
        }
      }
    }

    try {
      const orders = await req.adapter!.getOrders({
        status:  q.status,
        perPage: q.per_page ? Number(q.per_page) : undefined,
      });
      res.json(orders);
    } catch (err) { adapterError(res, err); }
  });

  app.patch('/api/orders/:orderId/status', attachAdapter, async (req: Request, res: Response) => {
    if (!UUID_RE.test(req.params.orderId)) {
      res.status(400).json({ error: 'Invalid order ID format' }); return;
    }
    const { status } = req.body as { status?: string };
    if (typeof status !== 'string') {
      res.status(400).json({ error: 'status is required' }); return;
    }

    // Check local orders first (UUID keys are the same format for both paths)
    try {
      const order = await getRedis().get<LocalOrder>(redisKey.localOrder(req.params.orderId));
      if (order) {
        const updated: LocalOrder = { ...order, status, updated_at: new Date().toISOString() };
        await getRedis().set(redisKey.localOrder(req.params.orderId), updated, { ex: TTL.LOCAL_ORDER });
        res.json(updated); return;
      }
    } catch { /* fall through to adapter */ }

    try {
      const result = await req.adapter!.updateOrderStatus(req.params.orderId, status);
      res.json(result);
    } catch (err) { adapterError(res, err); }
  });

  // ── Orders: single endpoint for all active statuses (used by live dashboard) ─
  // Returns pending + confirmed + preparing + ready in one request so the
  // kitchen dashboard can poll at 6-second intervals without 4× the requests.
  app.get('/api/orders/active', attachAdapter, async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    const tenantId    = req.tenantConfig?.tenantId;
    const ACTIVE      = ['pending', 'confirmed', 'preparing', 'ready'] as const;

    if (tenantId) {
      const menu = await getLocalMenu(tenantId);
      if (menu) {
        try {
          const redis  = getRedis();
          const ids    = await redis.lrange(redisKey.localOrders(tenantId), 0, 199);
          const orders = (await Promise.all(
            ids.map(id => redis.get<LocalOrder>(redisKey.localOrder(id)).catch(() => null))
          )).filter((o): o is LocalOrder => o !== null && (ACTIVE as readonly string[]).includes(o.status));
          res.json(orders); return;
        } catch (err) {
          console.error('[LOCAL] get-orders/active failed:', err);
          res.status(500).json({ error: 'Failed to load orders' }); return;
        }
      }
    }

    try {
      const results = await Promise.all(
        ACTIVE.map(s => req.adapter!.getOrders({ status: s, perPage: 50 }))
      );
      res.json((results as unknown[][]).flat());
    } catch (err) { adapterError(res, err); }
  });

  // ── Staff management ───────────────────────────────────────────────────────
  // tenant_admin can invite staff/manager accounts scoped to their own tenant.

  app.get('/api/admin/staff', requireAuth, async (req: Request, res: Response) => {
    const { tenantId, role } = req.jwtPayload!;
    if (role !== 'tenant_admin' && role !== 'super_admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    try {
      const redis    = getRedis();
      const emails   = (await redis.smembers(`tenant:staff:${tenantId}`)) as string[];
      const members  = (await Promise.all(
        emails.map(async email => {
          const u = await redis.get<{ email: string; role: string }>(`user:email:${email}`).catch(() => null);
          return u ? { email: u.email, role: u.role } : null;
        })
      )).filter(Boolean);
      res.json(members);
    } catch (err) {
      console.error('[STAFF] list failed:', err);
      res.status(500).json({ error: 'Failed to load staff' });
    }
  });

  app.post('/api/admin/staff/invite', requireAuth, authLimiter, async (req: Request, res: Response) => {
    const { tenantId, role } = req.jwtPayload!;
    if (role !== 'tenant_admin' && role !== 'super_admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    const { email, staffRole, password } =
      req.body as { email?: string; staffRole?: string; password?: string };

    if (!email || !password)                          { res.status(400).json({ error: 'email and password are required' }); return; }
    if (!['staff', 'manager'].includes(staffRole ?? '')){ res.status(400).json({ error: 'staffRole must be "staff" or "manager"' }); return; }
    if (password.length < 8)                          { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }

    try {
      const redis        = getRedis();
      const emailKey     = `user:email:${email.toLowerCase()}`;
      const existing     = await redis.get<{ tenantId: string }>(emailKey).catch(() => null);
      if (existing && existing.tenantId !== tenantId) {
        res.status(409).json({ error: 'That email is already registered to a different account' }); return;
      }
      const configRaw      = await redis.get<{ slug?: string }>(redisKey.tenantConfig(tenantId)).catch(() => null);
      const slug           = configRaw?.slug ?? tenantId;
      const passwordHash   = crypto.createHash('sha256').update(password).digest('hex');

      await redis.set(emailKey,
        { email: email.toLowerCase(), passwordHash, tenantId, slug, role: staffRole },
        { ex: ONE_YEAR }
      );
      await redis.sadd(`tenant:staff:${tenantId}`, email.toLowerCase());
      void writeAuditLog(tenantId, 'staff_invite', req.jwtPayload!.sub, `email=${email} role=${staffRole}`);
      console.log(`[STAFF] Invited ${email} as ${staffRole} for tenant ${tenantId}`);
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error('[STAFF] invite failed:', err);
      res.status(500).json({ error: 'Failed to invite staff member' });
    }
  });

  app.delete('/api/admin/staff/:email', requireAuth, async (req: Request, res: Response) => {
    const { tenantId, role } = req.jwtPayload!;
    if (role !== 'tenant_admin' && role !== 'super_admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    const email = decodeURIComponent(req.params.email).toLowerCase();
    try {
      const redis = getRedis();
      const u     = await redis.get<{ tenantId: string; role: string }>(`user:email:${email}`).catch(() => null);
      if (!u) { res.status(404).json({ error: 'Staff member not found' }); return; }
      if (u.tenantId !== tenantId) { res.status(403).json({ error: 'Cannot remove users from another tenant' }); return; }
      if (u.role === 'tenant_admin') { res.status(400).json({ error: 'Cannot remove a tenant admin account' }); return; }
      await redis.del(`user:email:${email}`);
      await redis.srem(`tenant:staff:${tenantId}`, email);
      void writeAuditLog(tenantId, 'staff_remove', req.jwtPayload!.sub, `removed=${email}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('[STAFF] remove failed:', err);
      res.status(500).json({ error: 'Failed to remove staff member' });
    }
  });

  // ── WhatsApp Business (Meta Cloud API) ──────────────────────────────────────
  // GET: Meta webhook verification challenge
  app.get('/telephony/whatsapp/webhook', (req: Request, res: Response) => {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      console.log('[WA] Webhook verification challenge succeeded');
      res.status(200).send(String(challenge));
    } else {
      console.warn(`[WA] Webhook verification challenge failed: mode=${mode} tokenMatch=${token === process.env.META_WEBHOOK_VERIFY_TOKEN}`);
      res.sendStatus(403);
    }
  });

  // POST: incoming messages — signature is verified against req.rawBody, the
  // exact bytes Meta sent, captured by the global express.json() verify hook
  // above (line ~400). Do NOT add express.raw() here: the global json()
  // parser already consumed the stream by the time any route-level middleware
  // runs, so a second raw parser finds nothing left to read and leaves
  // req.body as the already-parsed object instead of a Buffer.
  app.post('/telephony/whatsapp/webhook', webhookLimiter, (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    console.log(`[WA] POST /telephony/whatsapp/webhook received (${rawBody?.length ?? 0} bytes)`);
    const sig = req.headers['x-hub-signature-256'];
    if (!rawBody || typeof sig !== 'string' || !verifyWebhookSignature(rawBody, sig)) {
      console.warn('[WA] Webhook signature verification failed');
      res.sendStatus(403); return;
    }
    // Respond 200 immediately — Meta requires fast acknowledgement
    res.sendStatus(200);
    // req.body is already the parsed payload (global json() parser handled it)
    handleWebhook(req.body as Parameters<typeof handleWebhook>[0]).catch(err =>
      console.error('[WA] Webhook processing error:', (err as Error).message)
    );
  });

  // ── Static / SPA ────────────────────────────────────────────────────────────
  if (IS_DEV) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res: Response) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer();
