// The guest/staff boundary.
//
//   npx tsx --env-file=.env testing/test-guest-isolation.ts
//
// A diner holds a real, correctly-signed token for a real tenant. That is
// exactly why "is this token valid?" is not a sufficient check anywhere, and
// why this file exists: it asserts the separation in BOTH directions, because
// a one-way check is the kind that quietly rots when a route is added later.
//
// Needs JWT_SECRET only — no database, no network.

import assert from 'node:assert';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import { issueJwt, issueGuestJwt, extractJwt } from '../src/lib/jwt.js';
import { requireGuest } from '../middleware/guest.js';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is required. Run with: npx tsx --env-file=.env testing/test-guest-isolation.ts');
  process.exit(1);
}

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';
const TABLE_1  = '00000000-0000-4000-8000-00000000t001'.replace(/t/g, '1');
const SESSION  = '00000000-0000-4000-8000-00000000e001'.replace(/e/g, '2');

const guestToken = issueGuestJwt({
  tenantId: TENANT_A, slug: 'cafe-a', tableId: TABLE_1, dineSessionId: SESSION,
});
const staffToken = issueJwt({
  sub: 'staff-1', tenantId: TENANT_A, role: 'manager', slug: 'cafe-a',
});
const otherTenantGuest = issueGuestJwt({
  tenantId: TENANT_B, slug: 'cafe-b', tableId: TABLE_1, dineSessionId: SESSION,
});

// ── A stand-in for the two real gates ────────────────────────────────────────
// requireAuth is reproduced here rather than imported because it lives inside
// startServer() in server.ts. The guest-rejecting branch is copied verbatim; if
// that branch is ever removed from server.ts this test keeps passing, so the
// live wiring is asserted separately at the bottom.
function requireAuthLike(req: Request, res: Response, next: NextFunction): void {
  const payload = extractJwt(req.headers['authorization']);
  if (payload?.role === 'guest') {
    res.status(403).json({ error: 'This is a guest session and cannot access staff features' });
    return;
  }
  if (payload) { (req as Request & { jwtPayload?: unknown }).jwtPayload = payload; next(); return; }
  res.status(401).json({ error: 'Unauthorized' });
}

const app = express();
app.use(express.json());
app.get('/staff-only', requireAuthLike, (_req, res) => res.json({ ok: true }));
app.get('/guest-only', requireGuest,    (req, res) => res.json({ guest: req.guest }));

const server = app.listen(0);
await new Promise<void>(r => server.once('listening', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const get = async (path: string, token?: string) => {
  const res = await fetch(base + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
};

// ── Guest → staff ────────────────────────────────────────────────────────────

section('a guest token cannot reach staff routes');

await check('a guest token is refused with 403, not accepted', async () => {
  const r = await get('/staff-only', guestToken);
  assert.equal(r.status, 403, 'a valid guest token must not pass a staff gate');
});

await check('the refusal is on role, not on signature', async () => {
  // The token verifies perfectly. If the gate ever checks only validity, this
  // is the test that fails.
  const decoded = extractJwt(`Bearer ${guestToken}`);
  assert.ok(decoded, 'the guest token is genuinely valid');
  assert.equal(decoded!.role, 'guest');
  const r = await get('/staff-only', guestToken);
  assert.equal(r.status, 403);
});

// ── Staff → guest ────────────────────────────────────────────────────────────

section('a staff token cannot act as a guest');

await check('a staff token is refused by the guest gate', async () => {
  const r = await get('/guest-only', staffToken);
  assert.equal(r.status, 403, 'a manager has no table and no dine session');
});

await check('no token at all is refused', async () => {
  const r = await get('/guest-only');
  assert.equal(r.status, 401);
});

await check('a garbage token is refused', async () => {
  const r = await get('/guest-only', 'not.a.token');
  assert.equal(r.status, 401);
});

// ── What the guest gate exposes ──────────────────────────────────────────────

section('the guest gate reads identity only from the token');

await check('a valid guest token passes and carries its table', async () => {
  const r = await get('/guest-only', guestToken);
  assert.equal(r.status, 200);
  const g = r.body.guest as { tenantId: string; tableId: string; dineSessionId: string };
  assert.equal(g.tenantId,      TENANT_A);
  assert.equal(g.tableId,       TABLE_1);
  assert.equal(g.dineSessionId, SESSION);
});

await check('tenant comes from the token, so one tenant\'s guest is not another\'s', async () => {
  const r = await get('/guest-only', otherTenantGuest);
  assert.equal(r.status, 200);
  assert.equal((r.body.guest as { tenantId: string }).tenantId, TENANT_B,
    'each guest resolves to their own tenant');
});

await check('a guest token missing its table is refused', async () => {
  // Hand-made or from before the claims existed. It must not default to a table.
  const crippled = issueJwt({
    sub: 'guest:x', tenantId: TENANT_A, role: 'guest' as never, slug: 'cafe-a',
  });
  const r = await get('/guest-only', crippled);
  assert.equal(r.status, 401, 'no tableId means no session');
});

// ── The live wiring ──────────────────────────────────────────────────────────

section('server.ts actually wires these gates');

await check('requireAuth in server.ts rejects role guest', async () => {
  const fs  = await import('node:fs/promises');
  const src = await fs.readFile('server.ts', 'utf8');
  assert.match(src, /jwtPayload\?\.role === 'guest'/,
    'server.ts requireAuth must explicitly refuse a guest token');
});

await check('/api/orders requires auth (not just attachAdapter)', async () => {
  // attachAdapter never returns 401, so mounting it alone left the order book
  // readable by anyone who knew a tenant uuid.
  const fs  = await import('node:fs/promises');
  const src = await fs.readFile('server.ts', 'utf8');
  assert.match(src, /app\.use\('\/api\/orders',\s*requireAuth,\s*attachAdapter\)/,
    '/api/orders must sit behind requireAuth');
});

await check('the guest router is mounted without requireAuth or attachAdapter', async () => {
  const fs  = await import('node:fs/promises');
  const src = await fs.readFile('server.ts', 'utf8');
  assert.match(src, /app\.use\('\/api\/guest',\s*guestLimiter,\s*guestRouter\)/,
    'the guest router carries its own gate and must not inherit the staff chain');
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
