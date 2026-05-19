import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { issueJwt, extractJwt, type JwtPayload, type UserRole } from './src/lib/jwt.js';
import { encryptCredentials, decryptCredentials } from './src/lib/crypto.js';
import { parseTenantConfig } from './src/lib/tenantConfig.js';
import type { TenantConfig } from './src/lib/tenantConfig.js';
import { getRedis, redisKey, TTL } from './src/lib/redis.js';
import { attachAdapter } from './middleware/tenant.js';
import type { IRestaurantAdapter } from './adapter/IRestaurantAdapter.js';
import { fetchMenuFromSupabase } from './src/lib/supabaseMenu.js';

dotenv.config();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_DEV  = process.env.NODE_ENV !== 'production';
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
  notes:          string | null;
  created_at:     string;
  updated_at:     string;
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
}

// Ensure a tenant row exists in the FastAPI/Supabase operational DB.
// Called at registration and before every menu sync — if the endpoint doesn't
// exist yet the error is logged but not thrown (menu sync will surface its own error).
async function ensureTenantInBackend(tenantId: string, slug: string, name: string, plan: string): Promise<void> {
  await axios.post(
    `${BACKEND_URL}/api/v1/admin/ensure-tenant`,
    { slug, name, plan, status: 'active' },
    { headers: { 'X-Tenant-ID': tenantId }, timeout: 20_000 },
  );
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

  if (!process.env.JWT_SECRET)     console.warn('[AUTH] JWT_SECRET not set — JWT auth will fail');
  if (!process.env.SESSION_SECRET) console.warn('[AUTH] SESSION_SECRET not set — legacy sessions lost on restart');

  app.set('trust proxy', 1);
  // Disable Express's auto-generated ETag for API responses. Tenant-scoped
  // endpoints must never return 304: the browser would then reuse a cached
  // body that may have belonged to a different tenant (this is exactly how
  // Johnny's menu kept appearing under Savour even after the Redis fix).
  app.set('etag', false);
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    next();
  });

  // ── Rate limiters ───────────────────────────────────────────────────────────
  const generalLimiter = rateLimit({ windowMs: 15*60*1000, max: 200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
  const agentLimiter   = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
  const authLimiter    = rateLimit({ windowMs: 15*60*1000, max: 20,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts.' } });
  const tokenLimiter   = rateLimit({ windowMs: 60*1000,    max: 10,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many token requests.' } });

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

      const ONE_YEAR = 365 * 24 * 60 * 60;
      await Promise.all([
        redis.set(emailKey, { email: email.toLowerCase(), passwordHash, tenantId, slug, role: 'tenant_admin' }, { ex: ONE_YEAR }),
        redis.set(slugKey,  tenantId, { ex: ONE_YEAR }),
        redis.set(redisKey.tenantConfig(tenantId), config, { ex: TTL.TENANT_CONFIG }),
        redis.sadd(redisKey.tenantsIndex, tenantId),
      ]);

      void writeAuditLog(tenantId, 'register', email.toLowerCase(), `slug=${slug} plan=${plan ?? 'starter'}`);

      // Register tenant in the FastAPI operational DB (non-fatal — can be retried via Sync to AI)
      ensureTenantInBackend(tenantId, slug, restaurantName, plan ?? 'starter').catch(err =>
        console.warn('[AUTH] ensureTenantInBackend failed (non-fatal):', (err as Error).message)
      );

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
      console.log(`[ADMIN] Config saved for tenant ${tenantId}`);
      res.json({ ok: true, kioskUrl: `/kiosk/${config.slug}` });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Adapter connection test ─────────────────────────────────────────────────
  // Tries paths in order; a non-5xx response (including 404) proves the server
  // is reachable. Only ECONNREFUSED / network errors are hard failures.
  app.post('/api/admin/test-connection', requireAuth, async (req: Request, res: Response) => {
    const { backendUrl } = req.body as { backendUrl?: string };
    if (!backendUrl) { res.status(400).json({ error: 'backendUrl is required' }); return; }

    const base    = backendUrl.replace(/\/$/, '');
    const probes  = [
      `${base}/api/v1/agent/menu-context`,
      `${base}/api/v1/menu`,
      `${base}/health`,
      base,
    ];

    for (const url of probes) {
      try {
        const result = await axios.get(url, {
          timeout: 10_000,
          headers: { 'X-Tenant-ID': req.jwtPayload!.tenantId },
          // Accept anything < 500 — 404 still proves the server answered
          validateStatus: s => s < 500,
        });

        if (result.status === 200) {
          const sample = typeof result.data === 'string'
            ? result.data.slice(0, 400)
            : JSON.stringify(result.data).slice(0, 400);
          res.json({ ok: true, sampleOutput: sample });
        } else {
          // Server is reachable but this path doesn't exist for this tenant yet
          res.json({
            ok: true,
            sampleOutput: `Server is reachable (HTTP ${result.status} at ${url}). ` +
              `The menu-context endpoint will be available once this tenant is provisioned on the backend.`,
          });
        }
        return;
      } catch (err) {
        if (!axios.isAxiosError(err) || !err.response) continue; // network error — try next probe
        // Got a 5xx — server is up but erroring
        res.json({ ok: false, error: `HTTP ${err.response.status} at ${url}: ${err.message}` });
        return;
      }
    }

    res.json({ ok: false, error: 'Could not reach the server. Check the URL and ensure the backend is running.' });
  });

  // ── Adapter credentials (encrypted at rest) ───────────────────────────────
  // Stores baseUrl + apiKey (and optional extras) encrypted with AES-256-GCM.
  // The plaintext never appears in logs, audit entries, or TenantConfig exports.

  app.post('/api/admin/save-credentials', requireAuth, async (req: Request, res: Response) => {
    const { role, tenantId } = req.jwtPayload!;
    if (role !== 'tenant_admin' && role !== 'super_admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    const { baseUrl, apiKey, apiSecret } =
      req.body as { baseUrl?: string; apiKey?: string; apiSecret?: string };
    if (!baseUrl) { res.status(400).json({ error: 'baseUrl is required' }); return; }

    try {
      const blob  = encryptCredentials({ baseUrl, apiKey, apiSecret });
      const redis = getRedis();
      await redis.set(redisKey.credentialsKey(tenantId), blob);
      void writeAuditLog(tenantId, 'credentials_save', req.jwtPayload!.sub);
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
      // Decrypt just to get the baseUrl — never return the key
      const creds = decryptCredentials(blob as Parameters<typeof decryptCredentials>[0]);
      res.json({ hasCredentials: true, baseUrl: creds.baseUrl ?? '' });
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
        const ensureMsg = axios.isAxiosError(ensureErr)
          ? ((ensureErr.response?.data as { detail?: string })?.detail ?? ensureErr.message)
          : String(ensureErr);
        console.warn('[MENU] ensure-tenant step failed (continuing to sync):', ensureMsg);
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
          res.json(items); return;
        } catch { res.json([]); return; }
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

          await redis.set(redisKey.localOrder(orderId), order, { ex: TTL.LOCAL_ORDER });
          await redis.lpush(redisKey.localOrders(tenantId), orderId);
          await redis.ltrim(redisKey.localOrders(tenantId), 0, 499);
          await redis.del(cartKey);

          console.log(`[LOCAL] Order #${orderNum} created for tenant ${tenantId}`);
          res.status(201).json({ id: orderId, order_id: orderId, order_number: orderNum, total, summary: `Order #${orderNum}` });
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
          res.json(filtered); return;
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
