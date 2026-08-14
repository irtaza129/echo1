import { Environment, LogLevel, Paddle, type PaddleOptions } from '@paddle/paddle-node-sdk';

// Single Paddle SDK instance for the whole process. Constructed lazily so that
// importing this module never throws at boot — the kiosk and POS paths must
// keep working on a deployment that has no billing credentials configured.
//
// Server-side only. PADDLE_API_KEY must never reach the browser; the client
// gets nothing from this file. Checkout in the browser uses a client-side
// token, which is a different credential entirely.

let _paddle: Paddle | null = null;

export type PaddleEnv = 'sandbox' | 'production';

export function paddleEnv(): PaddleEnv {
  return process.env.PADDLE_ENV === 'production' ? 'production' : 'sandbox';
}

// PADDLE_SANDBOX is accepted as a fallback because that is the name the key was
// first stored under in .env. PADDLE_API_KEY is the documented name.
function apiKey(): string | undefined {
  return process.env.PADDLE_API_KEY ?? process.env.PADDLE_SANDBOX;
}

export function isBillingConfigured(): boolean {
  return Boolean(apiKey());
}

export function getPaddle(): Paddle {
  if (_paddle) return _paddle;

  const key = apiKey();
  if (!key) throw new Error('[BILLING] PADDLE_API_KEY is not set');

  const env = paddleEnv();

  // Sandbox and production are entirely separate accounts: a pro_/pri_/ctm_ id
  // from one does not exist in the other. Pointing a sandbox key at the
  // production environment does not fail loudly — it fails as "not found" on
  // every lookup, which is far harder to diagnose. Refuse the mismatch instead.
  if (key.startsWith('pdl_sdbx_') && env === 'production') {
    throw new Error('[BILLING] Sandbox API key used with PADDLE_ENV=production — refusing to start billing');
  }
  if (key.startsWith('pdl_live_') && env === 'sandbox') {
    throw new Error('[BILLING] Live API key used with PADDLE_ENV=sandbox — refusing to start billing');
  }

  const options: PaddleOptions = {
    environment: env === 'production' ? Environment.production : Environment.sandbox,
    logLevel: LogLevel.error,
  };

  _paddle = new Paddle(key, options);
  return _paddle;
}

// The notification destination's signing secret (pdl_ntfset_...). This is NOT
// the API key — it is per-destination, and verifying with the wrong one makes
// every delivery fail signature verification.
export function webhookSecret(): string | undefined {
  return process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET;
}

// ── Client-side token ────────────────────────────────────────────────────────

// The browser token for Paddle.js. Unlike the API key this one is PUBLISHABLE —
// it is designed to ship in the bundle and can only open checkouts, never read
// or mutate account data. Sandbox tokens are `test_`-prefixed, live ones `live_`.
//
// CLIENT is accepted as a fallback for the same reason PADDLE_SANDBOX is above:
// it is the name the token was first stored under in .env.
export function clientToken(): string | undefined {
  return process.env.PADDLE_CLIENT_TOKEN ?? process.env.CLIENT;
}

// Mirrors the API-key guard in getPaddle(). A live client token on a sandbox
// server would open a REAL checkout from a test environment — the one mistake
// here that takes actual money off a real card.
export function assertClientTokenMatchesEnv(token: string): void {
  const env = paddleEnv();
  if (token.startsWith('test_') && env === 'production') {
    throw new Error('[BILLING] Sandbox client token used with PADDLE_ENV=production');
  }
  if (token.startsWith('live_') && env === 'sandbox') {
    throw new Error('[BILLING] Live client token used with PADDLE_ENV=sandbox — refusing to serve it');
  }
}

// ── REST helper ──────────────────────────────────────────────────────────────

// Ad-hoc (non-catalog) transaction items are awkward to express through the
// SDK's generated types, and the order-payment flow needs them on every call —
// each order is a one-off line item, not a catalogue price. This helper talks to
// the same account the SDK does, with the environment resolved the same way, so
// there is exactly one place that decides sandbox vs production.
export function paddleApiBase(): string {
  return paddleEnv() === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';
}

export interface PaddleApiError {
  type?: string;
  code?: string;
  detail?: string;
  errors?: Array<{ field: string; message: string }>;
}

export async function paddleFetch<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error('[BILLING] PADDLE_API_KEY is not set');

  const res = await fetch(paddleApiBase() + path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = (json as { error?: PaddleApiError }).error ?? {};
    // Surface field-level validation errors: Paddle's `detail` is usually just
    // "Invalid request." and the actionable part lives in `errors[]`.
    const fields = (err.errors ?? []).map(e => `${e.field}: ${e.message}`).join('; ');
    throw new Error(
      `[PADDLE] ${init.method ?? 'GET'} ${path} → ${res.status} ` +
      `${err.code ?? ''} ${err.detail ?? ''}${fields ? ` (${fields})` : ''}`.trim(),
    );
  }

  return (json as { data: T }).data;
}
