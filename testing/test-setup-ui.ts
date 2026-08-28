// The endpoints behind the Setup screens, driven over real HTTP.
//
//   npx tsx --env-file=.env testing/test-setup-ui.ts --tenant <uuid>
//
// These replaced terminal scripts, so the risk is that a screen exists but the
// endpoint behind it does not do what the screen promises. Everything created
// here is deleted in a finally.

import assert from 'node:assert';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import { posRouter } from '../routes/pos.js';
import * as db from '../src/lib/supabaseAdmin.js';
import { expandLabels } from '../src/pos/SetupTables.js';

const tenantId = process.argv[process.argv.indexOf('--tenant') + 1];
if (!tenantId || tenantId.startsWith('--')) {
  console.error('Usage: npx tsx --env-file=.env testing/test-setup-ui.ts --tenant <uuid>');
  process.exit(1);
}

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const app = express();
app.use(express.json());
app.use('/api/pos', (req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { tenantConfig?: unknown; jwtPayload?: unknown }).tenantConfig = {
    tenantId, slug: 'setuptest', restaurantName: 'Setup Test',
    businessRules: { gstRate: 0.15, currencySymbol: 'PKR', pos: { serviceChargeRate: 0 } },
  };
  (req as Request & { jwtPayload?: unknown }).jwtPayload = {
    sub: 'setup-test', tenantId, role: 'tenant_admin', slug: 'setuptest',
  };
  next();
}, posRouter);

const server = app.listen(0);
await new Promise<void>(r => server.once('listening', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/pos`;

async function call(method: string, path: string, body?: unknown) {
  const res  = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body:    body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

// ── Label expansion (pure, drives the "add tables" box) ─────────────────────

section('table name shorthand');

await check('a range expands', () => {
  assert.deepEqual(expandLabels('1-5'), ['1', '2', '3', '4', '5']);
});

await check('a list is kept as typed', () => {
  assert.deepEqual(expandLabels('A1, A2, Patio'), ['A1', 'A2', 'Patio']);
});

await check('ranges and names mix', () => {
  assert.deepEqual(expandLabels('1-3, Bar'), ['1', '2', '3', 'Bar']);
});

await check('duplicates collapse', () => {
  assert.deepEqual(expandLabels('1,1,2'), ['1', '2']);
});

await check('an absurd range is treated as a name, not obeyed', () => {
  // "1-9999" is a typo, not a request for nine thousand tables.
  assert.deepEqual(expandLabels('1-9999'), ['1-9999']);
});

await check('a backwards range is not silently reversed', () => {
  assert.deepEqual(expandLabels('9-2'), ['9-2']);
});

await check('empty input yields nothing', () => {
  assert.deepEqual(expandLabels(''), []);
  assert.deepEqual(expandLabels('  , ,'), []);
});

// ── Tables and QR over HTTP ─────────────────────────────────────────────────

const created: string[] = [];

try {
  section('tables and QR codes');

  await check('a table can be created from the UI payload', async () => {
    const r = await call('POST', '/tables', { area: 'SETUPTEST', label: 'T1', seats: 4 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    created.push(String((r.body as { id: string }).id));
  });

  await check('a table with no code reports that honestly', async () => {
    const r = await call('GET', `/tables/${created[0]}/qr`);
    assert.equal(r.status, 200);
    assert.equal(r.body.issued, false, 'must not invent a code that was never issued');
  });

  let firstToken = '';
  let firstPin   = '';

  await check('issuing returns a scannable QR, a PIN and an absolute URL', async () => {
    const r = await call('POST', `/tables/${created[0]}/qr`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const b = r.body as { qrToken: string; pin: string; url: string; qrSvg: string };
    assert.ok(b.qrToken);
    assert.match(b.pin, /^\d{4}$/, 'a 4-digit PIN');
    assert.match(b.qrSvg, /^<\?xml|^<svg/, 'an SVG the browser can render inline');
    // Absolute, or a printed card only works on the machine that made it.
    assert.match(b.url, /^https?:\/\/.+\/t\/setuptest\//, `expected an absolute guest URL, got ${b.url}`);
    assert.ok(b.qrSvg.includes('<path') || b.qrSvg.includes('<rect'), 'the SVG should have content');

    firstToken = b.qrToken;
    firstPin   = b.pin;
  });

  await check('the PIN is never readable afterwards', async () => {
    // It is stored as a scrypt hash. If it has been lost the answer is to
    // re-issue, and the UI says so.
    const r = await call('GET', `/tables/${created[0]}/qr`);
    assert.equal(r.body.issued, true);
    assert.equal(r.body.hasPin, true);
    assert.equal('pin' in r.body, false, 'reading back a code must NOT expose the PIN');
  });

  await check('viewing a code does not rotate it', async () => {
    // The dangerous mistake: if "Show code" re-issued, every printed card in the
    // restaurant would stop working the moment someone looked at one.
    const a = await call('GET', `/tables/${created[0]}/qr`);
    const b = await call('GET', `/tables/${created[0]}/qr`);
    assert.equal(a.body.url, b.body.url, 'the URL must be stable across views');
    assert.ok(String(a.body.url).includes(firstToken), 'and still the original token');
  });

  await check('re-issuing DOES change the code and the PIN', async () => {
    const r = await call('POST', `/tables/${created[0]}/qr`);
    const b = r.body as { qrToken: string; pin: string };
    assert.notEqual(b.qrToken, firstToken, 're-issue must mint a new token');
    assert.notEqual(b.pin, firstPin, 'and a new PIN');
  });

  section('staff PINs and permissions');

  await check('the staff list loads', async () => {
    const r = await call('GET', '/staff');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray((r.body as { staff: unknown[] }).staff));
  });

  await check('a weak PIN is refused with a readable reason', async () => {
    const list  = (await call('GET', '/staff')).body as { staff: Array<{ email: string }> };
    if (list.staff.length === 0) { console.log('      (no staff on this tenant — skipped)'); return; }

    const email = list.staff[0].email;
    const r = await call('PUT', `/staff/${encodeURIComponent(email)}/pin`, { pin: '1234' });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /easy to guess/i,
      'the message has to explain itself — the manager is not a developer');
  });

  await check('permissions round-trip and unknown keys are dropped', async () => {
    const list = (await call('GET', '/staff')).body as { staff: Array<{ email: string }> };
    if (list.staff.length === 0) { console.log('      (no staff on this tenant — skipped)'); return; }

    const email = list.staff[0].email;
    const r = await call('PUT', `/staff/${encodeURIComponent(email)}/permissions`, {
      can_void: true, can_discount: true, max_discount_pct: 15, can_fly: true,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const p = (r.body as { permissions: Record<string, unknown> }).permissions;
    assert.equal(p.can_void, true);
    assert.equal(p.max_discount_pct, 15);
    assert.equal('can_fly' in p, false, 'an undesigned capability must not be stored');

    // Put it back so this test does not hand someone permissions permanently.
    await call('PUT', `/staff/${encodeURIComponent(email)}/permissions`, {});
  });

  await check('a discount ceiling above 100% is REFUSED, not silently clamped', async () => {
    // Quietly turning a manager's 500 into 100 is worse than refusing it: they
    // would walk away believing they had set something they had not. The input
    // box clamps too, so this is the second line of defence rather than the only
    // one.
    const list = (await call('GET', '/staff')).body as { staff: Array<{ email: string }> };
    if (list.staff.length === 0) { console.log('      (no staff on this tenant — skipped)'); return; }

    const email = list.staff[0].email;
    const r = await call('PUT', `/staff/${encodeURIComponent(email)}/permissions`, {
      max_discount_pct: 500,
    });
    assert.equal(r.status, 400, 'an out-of-range ceiling must be rejected');
    assert.equal('permissions' in r.body, false, 'and nothing stored');
  });
} finally {
  for (const id of created) {
    await db.remove('venue_tables', { id: `eq.${id}` });
  }
  if (created.length) console.log(`  · cleaned up ${created.length} test table(s)`);
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
