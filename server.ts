import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { issueJwt, extractJwt, type JwtPayload, type UserRole } from './src/lib/jwt.js';
import { parseTenantConfig } from './src/lib/tenantConfig.js';
import type { TenantConfig } from './src/lib/tenantConfig.js';
import { getRedis, redisKey, TTL } from './src/lib/redis.js';
import { attachAdapter } from './middleware/tenant.js';
import type { IRestaurantAdapter } from './adapter/IRestaurantAdapter.js';

dotenv.config();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_DEV  = process.env.NODE_ENV !== 'production';
const BACKEND_URL = process.env.BACKEND_URL || 'https://voiceai-hzyb.onrender.com';

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
  app.use(express.json({ limit: '100kb' }));

  // ── Rate limiters ───────────────────────────────────────────────────────────
  const generalLimiter = rateLimit({ windowMs: 15*60*1000, max: 200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
  const agentLimiter   = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
  const authLimiter    = rateLimit({ windowMs: 15*60*1000, max: 10,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts.' } });
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

  // ── Auth endpoints ──────────────────────────────────────────────────────────
  app.post('/api/auth/login', authLimiter, async (req: Request, res: Response) => {
    const { username, password, email } = req.body as { username?: string; password?: string; email?: string };
    const loginId = email ?? username;
    if (typeof loginId !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Invalid request' }); return;
    }
    const hash = crypto.createHash('sha256').update(password).digest('hex');

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
      ]);

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
    if (req.params.slug !== 'savour-foods') {
      res.status(404).json({ error: 'Tenant not found' }); return;
    }
    try {
      const redis  = getRedis();
      const cached = await redis.get<unknown>(
        redisKey.tenantConfig('00000000-0000-4000-8000-000000000001')
      );
      const config = cached
        ? parseTenantConfig(cached)
        : parseTenantConfig({
            tenantId: '00000000-0000-4000-8000-000000000001', slug: 'savour-foods',
            restaurantName: 'Savour Foods', plan: 'growth', adapter: { type: 'managed' },
            gemini: { agentName: 'Savour Assistant', voice: 'Puck', languages: ['en','ur','roman-ur'], systemPromptExtras: '' },
            branding: { primaryColor: '#C8102E', logoUrl: '', kioskTitle: 'Welcome to Savour Foods' },
            businessRules: { gstRate: 0.15, currencySymbol: 'PKR', orderStatusMachine: ['pending','confirmed','preparing','ready','out_for_delivery','delivered'] },
            features: { deliveryOrders: false, tableNumbers: true, transcriptScreen: true, loyaltyPoints: false },
          });
      res.json({
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
    } catch {
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
    const tenantId = req.jwtPayload!.tenantId;
    try {
      const redis  = getRedis();
      const cached = await redis.get<unknown>(redisKey.tenantConfig(tenantId));
      if (cached) { res.json(cached); return; }
    } catch {
      // Redis unavailable — fall through to hardcoded fallback
    }
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
    res.status(404).json({ error: 'Config not found' });
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

  // ── Agent routes — all go through the adapter ───────────────────────────────
  app.use('/api/agent/', attachAdapter);

  app.get('/api/agent/menu-context', async (req: Request, res: Response) => {
    const tenantId = req.tenantConfig?.tenantId;
    try {
      // Check Redis cache first (6 h TTL keyed by tenantId)
      if (tenantId) {
        try {
          const redis  = getRedis();
          const cached = await redis.get<string>(redisKey.menuContext(tenantId));
          if (cached) {
            console.log(`[MENU] Cache hit for tenant ${tenantId}`);
            res.type('text/plain').send(cached);
            return;
          }
        } catch {
          // Redis unavailable — fall through to adapter
        }
      }

      const text = await req.adapter!.getMenuContext();

      if (tenantId) {
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
    try {
      const result = await req.adapter!.resolveItem({
        sessionId: b.session_id,
        dishQuery:  b.dish_query,
        modifiers:  b.modifiers,
        quantity:   b.quantity,
        notes:      b.notes,
      });
      res.json(result);
    } catch (err) { adapterError(res, err); }
  });

  app.post('/api/agent/remove-item', async (req: Request, res: Response) => {
    const b = req.body as { session_id: string; cart_item_id: string };
    try {
      await req.adapter!.removeItem(b.session_id, b.cart_item_id);
      res.json({ ok: true });
    } catch (err) { adapterError(res, err); }
  });

  app.post('/api/agent/clear-cart', async (req: Request, res: Response) => {
    const b = req.body as { session_id: string };
    try {
      await req.adapter!.clearCart(b.session_id);
      res.json({ ok: true });
    } catch (err) { adapterError(res, err); }
  });

  app.get('/api/agent/cart/:sessionId', async (req: Request, res: Response) => {
    if (!UUID_RE.test(req.params.sessionId)) {
      res.status(400).json({ error: 'Invalid session ID format' }); return;
    }
    try {
      const cart = await req.adapter!.getCart(req.params.sessionId);
      res.json(cart);
    } catch (err) { adapterError(res, err); }
  });

  app.post('/api/agent/submit-order', async (req: Request, res: Response) => {
    const b = req.body as {
      session_id: string; customer_name?: string; customer_phone?: string;
      order_type?: string; payment_method?: string; delivery_fee?: number;
      discount?: number; instructions?: string | null; notes?: string | null;
    };
    try {
      const result = await req.adapter!.submitOrder({
        sessionId:      b.session_id,
        customerName:   b.customer_name,
        customerPhone:  b.customer_phone,
        orderType:      b.order_type,
        paymentMethod:  b.payment_method,
        deliveryFee:    b.delivery_fee,
        discount:       b.discount,
        instructions:   b.instructions,
        notes:          b.notes,
      });
      res.status(201).json(result);
    } catch (err) { adapterError(res, err); }
  });

  // ── Menu + Orders routes — also through adapter ─────────────────────────────
  app.use('/api/menu',   attachAdapter);
  app.use('/api/orders', attachAdapter);

  app.get('/api/menu', async (req: Request, res: Response) => {
    try {
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
    const q = req.query as Record<string, string>;
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
