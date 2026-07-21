// Post-deploy smoke test: asserts the SHAPE of every endpoint the frontend
// consumes, against a running server.
//
//   npx tsx --env-file=.env scripts/smoke.mts [baseUrl] [tenantId]
//
// Types cannot catch what this catches. `npm run lint` proves the code agrees
// with itself; this proves the deployed server, the live Redis data and the
// Postgres schema agree with the code. The dashboard outage that motivated this
// was invisible to tsc — both sides compiled fine, they just disagreed at
// runtime about whether /api/orders returned an array or an envelope.
//
// Exit code 0 = all checks passed, 1 = at least one failed (CI-friendly).

import { checkSchema } from '../src/lib/supabaseAdmin.js';

const BASE      = process.argv[2] ?? process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const TENANT_ID = process.argv[3] ?? process.env.SMOKE_TENANT_ID ?? '';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); return; }
  failures.push(detail ? `${name} — ${detail}` : name);
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (TENANT_ID) headers['X-Tenant-ID'] = TENANT_ID;
  const res = await fetch(`${BASE}${path}`, { headers });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON body stays null */ }
  return { status: res.status, body };
}

// An endpoint that returns a collection must return a BARE ARRAY. An envelope
// is the exact regression this suite exists to catch, so assert it explicitly
// rather than tolerating both.
function assertBareArray(label: string, status: number, body: unknown): void {
  check(`${label} → 200`, status === 200, `got ${status}`);
  const isArray = Array.isArray(body);
  check(
    `${label} → bare array (not an envelope)`,
    isArray,
    isArray ? undefined : `got ${body === null ? 'null' : typeof body}: ${JSON.stringify(body)?.slice(0, 120)}`,
  );
}

// Assert every element carries the fields the dashboard actually reads. Catches
// the `total` vs `total_amount` class of drift, which renders as Rs 0 rather
// than as an error.
function assertOrderShape(orders: unknown[]): void {
  if (!orders.length) {
    console.log('  · no orders to shape-check (not a failure)');
    return;
  }
  const o = orders[0] as Record<string, unknown>;
  for (const field of ['id', 'status', 'total_amount', 'subtotal', 'created_at', 'items']) {
    check(`order.${field} present`, field in o, `keys: ${Object.keys(o).join(', ')}`);
  }
  check('order.total_amount is numeric', !Number.isNaN(parseFloat(String(o.total_amount))), `got ${JSON.stringify(o.total_amount)}`);

  const items = o.items as unknown[] | undefined;
  if (Array.isArray(items) && items.length) {
    const i = items[0] as Record<string, unknown>;
    for (const field of ['dish_name', 'quantity', 'unit_price', 'item_total']) {
      check(`order.items[0].${field} present`, field in i, `keys: ${Object.keys(i).join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`Smoke test against ${BASE}${TENANT_ID ? ` (tenant ${TENANT_ID})` : ' (no tenant header)'}\n`);

  console.log('GET /api/orders');
  const statuses = ['pending', 'confirmed', 'preparing', 'ready'];
  for (const status of statuses) {
    const { status: code, body } = await get(`/api/orders?status=${status}&per_page=50`);
    assertBareArray(`  status=${status}`, code, body);
    if (status === 'pending' && Array.isArray(body)) assertOrderShape(body);
  }

  console.log('\nGET /api/menu');
  const menu = await get('/api/menu');
  check('/api/menu → 200', menu.status === 200, `got ${menu.status}`);
  check('/api/menu → non-empty body', menu.body !== null && menu.body !== undefined);

  console.log('\nGET /api/agent/cart/:sessionId');
  // A well-formed but unused session must be an empty array, never an error and
  // never an envelope.
  const cart = await get('/api/agent/cart/00000000-0000-4000-8000-0000000000ff');
  assertBareArray('  unused session', cart.status, cart.body);

  console.log('\nGET /api/agent/cart/:sessionId (malformed id)');
  const badCart = await get('/api/agent/cart/not-a-uuid');
  check('malformed session id → 400', badCart.status === 400, `got ${badCart.status}`);

  console.log('\nPostgres schema');
  try {
    const problems = await checkSchema();
    check('all written columns exist', problems.length === 0,
      problems.map(p => `${p.table}: missing ${p.missing.join('/')}`).join('; '));
  } catch (err) {
    check('schema reachable', false, err instanceof Error ? err.message : String(err));
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Smoke test crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
