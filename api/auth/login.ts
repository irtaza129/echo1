import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';

// SHA-256 of ".env.example" — plaintext never lives in the process
const AUTH_USERNAME      = 'agent1101';
const AUTH_PASSWORD_HASH =
  process.env.AUTH_PASSWORD_HASH ??
  'a3046da0d15a27e89f2afe639b25748a7ad4d9290af3e7b1b6c1a5533c8f0a8c';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function getSecret(): string | null {
  return process.env.SESSION_SECRET ?? null;
}

function issueToken(username: string, secret: string): string {
  const payload = JSON.stringify({ sub: username, exp: Date.now() + TOKEN_TTL_MS });
  const b64 = Buffer.from(payload).toString('base64');
  const sig  = crypto.createHmac('sha256', secret).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw) as Record<string, unknown>); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  const secret = getSecret();
  if (!secret) {
    // SESSION_SECRET must be set in Vercel environment variables
    console.error('[AUTH] SESSION_SECRET is not set — refusing to issue tokens');
    json(res, 503, { error: 'Auth is not configured — contact the administrator' });
    return;
  }

  const body = await readBody(req);
  const { username, password } = body;

  if (typeof username !== 'string' || typeof password !== 'string') {
    json(res, 400, { error: 'Invalid request' });
    return;
  }

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  if (username !== AUTH_USERNAME || hash !== AUTH_PASSWORD_HASH) {
    json(res, 401, { error: 'Invalid credentials' });
    return;
  }

  json(res, 200, { token: issueToken(username, secret) });
}
