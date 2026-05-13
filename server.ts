import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_DEV = process.env.NODE_ENV !== 'production';
const BACKEND_URL = process.env.BACKEND_URL || 'https://voiceai-hzyb.onrender.com';

// ── Auth ──────────────────────────────────────────────────────────────────────
const AUTH_USERNAME      = 'agent1101';
const AUTH_PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH
  ?? 'a3046da0d15a27e89f2afe639b25748a7ad4d9290af3e7b1b6c1a5533c8f0a8c';
const SESSION_SECRET = process.env.SESSION_SECRET
  ?? crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function issueToken(username: string): string {
  const payload = JSON.stringify({ sub: username, exp: Date.now() + TOKEN_TTL_MS });
  const b64 = Buffer.from(payload).toString('base64');
  const sig  = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

function verifyToken(token: string): boolean {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const b64 = token.slice(0, dot);
    const sig  = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('hex');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.byteLength !== expBuf.byteLength) return false;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    const { exp } = JSON.parse(Buffer.from(b64, 'base64').toString()) as { exp: number };
    return exp > Date.now();
  } catch {
    return false;
  }
}

const backendClient = axios.create({ timeout: 15000 });

// ── Proxy helpers ─────────────────────────────────────────────────────────────

const proxyGet = async (backendPath: string, req: Request, res: Response, maxAttempts = 1) => {
  const url = new URL(BACKEND_URL + backendPath);
  Object.entries(req.query as Record<string, string>).forEach(([k, v]) =>
    url.searchParams.set(k, v)
  );

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt === 1) console.log(`[PROXY] GET ${url.pathname}`);
    else console.warn(`[PROXY] GET ${url.pathname} retry ${attempt}/${maxAttempts}`);
    try {
      const response = await backendClient.get(url.toString());
      const ct = String(response.headers['content-type'] || '');
      if (ct.includes('text/plain') || typeof response.data === 'string') {
        res.type('text/plain').send(response.data);
      } else {
        res.status(response.status).json(response.data);
      }
      return;
    } catch (err: unknown) {
      lastErr = err;
      const status = axios.isAxiosError(err) ? (err.response?.status ?? 0) : 0;
      const isTransient = status === 0 || status >= 500;
      if (!isTransient || attempt === maxAttempts) break;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }

  if (axios.isAxiosError(lastErr)) {
    console.error(`[PROXY] GET ${backendPath} error:`, lastErr.response?.data ?? lastErr.message);
    res.status(lastErr.response?.status ?? 500).json(lastErr.response?.data ?? { error: lastErr.message });
  } else {
    console.error(`[PROXY] GET ${backendPath} unexpected error:`, lastErr);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const proxyPost = async (
  backendPath: string,
  req: Request,
  res: Response,
  successStatus = 200
) => {
  if (IS_DEV) console.log(`[PROXY] POST ${backendPath}`, req.body);
  try {
    const response = await backendClient.post(BACKEND_URL + backendPath, req.body);
    if (IS_DEV) console.log(`[PROXY] <- ${response.status} ${backendPath}`);
    res.status(successStatus).json(response.data);
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      console.error(`[PROXY] POST ${backendPath} error:`, err.response?.data ?? err.message);
      res.status(err.response?.status ?? 500).json(err.response?.data ?? { error: err.message });
    } else {
      console.error(`[PROXY] POST ${backendPath} unexpected error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

const proxyPatch = async (backendPath: string, req: Request, res: Response) => {
  if (IS_DEV) console.log(`[PROXY] PATCH ${backendPath}`, req.body);
  try {
    const response = await backendClient.patch(BACKEND_URL + backendPath, req.body);
    res.status(response.status).json(response.data);
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      console.error(`[PROXY] PATCH ${backendPath} error:`, err.response?.data ?? err.message);
      res.status(err.response?.status ?? 500).json(err.response?.data ?? { error: err.message });
    } else {
      console.error(`[PROXY] PATCH ${backendPath} unexpected error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

// ── Server bootstrap ──────────────────────────────────────────────────────────

async function startServer() {
  const app = express();
  const PORT = 3000;

  if (!process.env.SESSION_SECRET) {
    console.warn(
      '[AUTH] SESSION_SECRET is not set — sessions will be lost on every server restart.\n' +
      '       Set SESSION_SECRET in .env (local) and in your hosting environment (production).'
    );
  }

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));

  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  const agentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again later.' },
  });

  // Strict limit on token endpoint — one token per kiosk press is fine, but
  // prevent automated abuse (each token costs a Google API roundtrip).
  const tokenLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many token requests.' },
  });

  app.use('/api/', generalLimiter);
  app.use('/api/agent/', agentLimiter);
  app.use('/api/auth/', authLimiter);

  // Warm-up pings
  backendClient.get(`${BACKEND_URL}/api/v1/menu`).catch(() =>
    console.warn('[WARMUP] Render backend cold-starting — first request may be slow')
  );
  backendClient.get(`${BACKEND_URL}/api/v1/agent/menu-context`).catch(() =>
    console.warn('[WARMUP] menu-context cold-starting')
  );

  // ── Gemini ephemeral token endpoint ───────────────────────────────────────
  // The browser POSTs here just before opening its Gemini Live WebSocket.
  // The server exchanges the real API key for a short-lived ephemeral token
  // (TTL: 60 s). The browser uses the ephemeral token as the apiKey for
  // GoogleGenAI — the real key never appears in any network response.
  // Even if a token is intercepted it expires within one minute.
  app.post('/api/gemini-token', tokenLimiter, async (_req: Request, res: Response) => {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      console.error('[TOKEN] GEMINI_API_KEY is not set');
      res.status(500).json({ error: 'Server configuration error' });
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: geminiApiKey, httpOptions: { apiVersion: 'v1alpha' } });
      const token = await ai.authTokens.create({});
      if (!token.name) throw new Error('SDK returned no token name');
      console.log('[TOKEN] Ephemeral token issued');
      res.json({ ephemeralToken: token.name });
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? ((err.response?.data as { error?: { message?: string } })?.error?.message ?? err.message)
        : String(err);
      console.error('[TOKEN] Failed to generate ephemeral token:', message);
      res.status(500).json({ error: `Token generation failed: ${message}` });
    }
  });

  // ── Auth endpoints ────────────────────────────────────────────────────────
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (username !== AUTH_USERNAME || hash !== AUTH_PASSWORD_HASH) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.json({ token: issueToken(username) });
  });

  app.post('/api/auth/verify', (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    if (typeof token !== 'string' || !verifyToken(token)) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    res.json({ ok: true });
  });

  // ── Agent routes (Gemini tool call handlers) ──────────────────────────────
  app.get('/api/agent/menu-context', (req: Request, res: Response) =>
    proxyGet('/api/v1/agent/menu-context', req, res, 4)
  );
  app.post('/api/agent/resolve-item', (req: Request, res: Response) =>
    proxyPost('/api/v1/agent/resolve-item', req, res)
  );
  app.post('/api/agent/remove-item', (req: Request, res: Response) =>
    proxyPost('/api/v1/agent/remove-item', req, res)
  );
  app.post('/api/agent/clear-cart', (req: Request, res: Response) =>
    proxyPost('/api/v1/agent/clear-cart', req, res)
  );
  app.get('/api/agent/cart/:sessionId', (req: Request, res: Response) => {
    if (!UUID_RE.test(req.params.sessionId)) {
      res.status(400).json({ error: 'Invalid session ID format' });
      return;
    }
    proxyGet(`/api/v1/agent/cart/${req.params.sessionId}`, req, res);
  });
  app.post('/api/agent/submit-order', (req: Request, res: Response) =>
    proxyPost('/api/v1/agent/submit-order', req, res, 201)
  );

  app.post('/api/orders', (req: Request, res: Response) =>
    proxyPost('/api/v1/orders', req, res, 201)
  );

  // ── Menu + Orders routes ──────────────────────────────────────────────────
  app.get('/api/menu', (req: Request, res: Response) =>
    proxyGet('/api/v1/menu', req, res)
  );
  app.get('/api/orders', (req: Request, res: Response) =>
    proxyGet('/api/v1/orders', req, res)
  );
  app.patch('/api/orders/:orderId/status', (req: Request, res: Response) => {
    if (!UUID_RE.test(req.params.orderId)) {
      res.status(400).json({ error: 'Invalid order ID format' });
      return;
    }
    proxyPatch(`/api/v1/orders/${req.params.orderId}/status`, req, res);
  });

  // ── Static / SPA ──────────────────────────────────────────────────────────
  if (IS_DEV) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
