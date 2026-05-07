import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';

function getSecret(): string | null {
  return process.env.SESSION_SECRET ?? null;
}

function verifyToken(token: string, secret: string): boolean {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const b64 = token.slice(0, dot);
    const sig  = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', secret).update(b64).digest('hex');
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
    json(res, 401, { error: 'Invalid or expired token' });
    return;
  }

  const body = await readBody(req);
  const { token } = body;

  if (typeof token !== 'string' || !verifyToken(token, secret)) {
    json(res, 401, { error: 'Invalid or expired token' });
    return;
  }

  json(res, 200, { ok: true });
}
