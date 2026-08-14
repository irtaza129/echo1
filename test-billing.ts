// Integration checks for the Paddle billing layer — the security-critical and
// delivery-critical parts that must hold without a live Paddle account:
// signature verification, the status-code contract, idempotency, out-of-order
// delivery, and access gating.
//
// The DB is a local stand-in for Supabase's PostgREST endpoint, so the real
// repo/axios code paths run end to end and we can assert on the exact rows the
// handlers write. Nothing here touches the real Paddle account or the real DB.
//
// Run:  npx tsx test-billing.ts
import assert from 'node:assert';
import crypto from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const SECRET = 'pdl_ntfset_01test_secret_value';

// Configure the environment BEFORE importing anything that reads it at module
// load. The Paddle SDK instance and the PostgREST client are both lazy, but the
// env has to be right the first time either is touched.
process.env.PADDLE_ENV = 'sandbox';
process.env.PADDLE_API_KEY = 'pdl_sdbx_apikey_01test';
process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET = SECRET;
process.env.SUPABASE_KEY = 'test-service-role-key';

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// ── Fake PostgREST ───────────────────────────────────────────────────────────
// Speaks just enough of the protocol for supabaseAdmin.ts: GET returns matching
// rows, POST upserts on the table's primary key. Rows land in `store` where the
// assertions can read them.

const store = new Map<string, Map<string, Record<string, unknown>>>();
const PK: Record<string, string> = {
  billing_customers:      'customer_id',
  billing_subscriptions:  'subscription_id',
  billing_transactions:   'transaction_id',
  billing_webhook_events: 'event_id',
  platform_users:         'id',
};

function table(name: string) {
  if (!store.has(name)) store.set(name, new Map());
  return store.get(name)!;
}

function startFakeDb(): Promise<{ server: Server; url: string }> {
  const app = express();
  app.use(express.json());

  app.get('/rest/v1/:table', (req, res) => {
    const rows = [...table(req.params.table).values()];
    // Only the operators the repos actually use: eq. and ilike.
    const filtered = rows.filter(row =>
      Object.entries(req.query).every(([key, value]) => {
        if (key === 'limit' || key === 'order' || key === 'select') return true;
        const v = String(value);
        if (v.startsWith('eq.'))    return String(row[key]) === v.slice(3);
        if (v.startsWith('ilike.')) return String(row[key] ?? '').toLowerCase() === v.slice(6).toLowerCase();
        return true;
      }),
    );
    res.json(filtered);
  });

  app.post('/rest/v1/:table', (req, res) => {
    const name = req.params.table;
    const pk   = PK[name] ?? 'id';
    const body = req.body as Record<string, unknown>;
    const key  = String(body[pk]);

    // Foreign keys are enforced for the two the handlers depend on, so the test
    // proves the stub-parent writes are actually necessary.
    if (name === 'billing_subscriptions' && !table('billing_customers').has(String(body.customer_id))) {
      res.status(409).json({ message: 'insert violates foreign key constraint on billing_customers' });
      return;
    }

    const existing = table(name).get(key) ?? {};
    table(name).set(key, { ...existing, ...body }); // merge-duplicates
    res.status(201).json([]);
  });

  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ── Paddle signing ───────────────────────────────────────────────────────────
// ts=<unix>;h1=<hex hmac-sha256 of "ts:body" keyed with the destination secret>.
// The SDK rejects a ts more than 5 s old, so tests sign at call time.

function sign(body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)): string {
  const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

function envelope(eventType: string, data: unknown, eventId: string, occurredAt = new Date().toISOString()) {
  return JSON.stringify({
    event_id: eventId, event_type: eventType, occurred_at: occurredAt,
    notification_id: `ntf_${eventId}`, data,
  });
}

const subscriptionPayload = (over: Record<string, unknown> = {}) => ({
  id: 'sub_01test', status: 'trialing', customer_id: 'ctm_01test',
  address_id: 'add_01', business_id: null, currency_code: 'USD',
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  started_at: '2026-08-01T00:00:00Z', first_billed_at: null, next_billed_at: null,
  paused_at: null, canceled_at: null, discount: null, collection_mode: 'automatic',
  billing_details: null,
  current_billing_period: { starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-08-08T00:00:00Z' },
  billing_cycle: { interval: 'month', frequency: 1 },
  scheduled_change: null, management_urls: null,
  custom_data: { tenant_id: '00000000-0000-4000-8000-000000000001' },
  import_meta: null,
  items: [{
    status: 'trialing', quantity: 1, recurring: true,
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
    previously_billed_at: null, next_billed_at: null, trial_dates: null,
    price: { id: 'pri_01test', product_id: 'pro_01test', description: 'Pro monthly' },
    product: { id: 'pro_01test', name: 'Pro' },
  }],
  ...over,
});

async function main() {
  const { server, url } = await startFakeDb();
  process.env.SUPABASE_URL = url;

  // Imported after env is set so the lazy singletons pick it up.
  const { webhookRouter } = await import('./routes/billing.js');
  const { subscriptionGrantsAccess } = await import('./src/lib/billingRepo.js');

  // Mirrors server.ts: the global json() verify hook is what populates
  // req.rawBody, and the webhook router is mounted at the same path.
  const app = express();
  app.use(express.json({
    limit: '100kb',
    verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; },
  }));
  app.use('/api/billing/webhook', webhookRouter);
  const appServer = app.listen(0);
  const port = (appServer.address() as AddressInfo).port;

  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

  console.log('signature verification');

  await check('valid signature is accepted and the event is processed', async () => {
    const body = envelope('subscription.created', subscriptionPayload(), 'evt_valid_01');
    const res  = await post(body, { 'paddle-signature': sign(body) });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.ok(table('billing_subscriptions').has('sub_01test'), 'subscription row was not written');
  });

  await check('tampered body is rejected with a NON-2xx (so Paddle retries)', async () => {
    const body      = envelope('subscription.created', subscriptionPayload(), 'evt_tampered_01');
    const signature = sign(body);
    const tampered  = body.replace('"status":"trialing"', '"status":"active"');
    const res       = await post(tampered, { 'paddle-signature': signature });
    assert.ok(res.status >= 400, `expected non-2xx, got ${res.status}`);
    assert.ok(!table('billing_webhook_events').has('evt_tampered_01'), 'tampered event was recorded');
  });

  await check('wrong secret is rejected with a non-2xx', async () => {
    const body = envelope('subscription.created', subscriptionPayload(), 'evt_wrongsecret_01');
    const res  = await post(body, { 'paddle-signature': sign(body, 'pdl_ntfset_wrong') });
    assert.ok(res.status >= 400, `expected non-2xx, got ${res.status}`);
  });

  await check('missing signature header is rejected', async () => {
    const body = envelope('subscription.created', subscriptionPayload(), 'evt_nosig_01');
    const res  = await post(body);
    assert.equal(res.status, 400);
  });

  await check('expired timestamp is rejected (replay of an old delivery)', async () => {
    const body = envelope('subscription.created', subscriptionPayload(), 'evt_stale_sig');
    const old  = Math.floor(Date.now() / 1000) - 600;
    const res  = await post(body, { 'paddle-signature': sign(body, SECRET, old) });
    assert.ok(res.status >= 400, `expected non-2xx, got ${res.status}`);
  });

  console.log('idempotency and ordering');

  await check('redelivery of the same event_id is a no-op', async () => {
    const body = envelope('customer.created', {
      id: 'ctm_dup', email: 'dup@example.com', status: 'active', name: null,
      marketing_consent: false, locale: 'en', custom_data: null, import_meta: null,
      created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
    }, 'evt_dup_01');

    const first  = await post(body, { 'paddle-signature': sign(body) });
    // Mutate the stored row so a second application would be visible.
    table('billing_customers').get('ctm_dup')!.email = 'sentinel@example.com';
    const second = await post(body, { 'paddle-signature': sign(body) });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200, 'redelivery must still 2xx or Paddle retries forever');
    assert.equal(table('billing_customers').get('ctm_dup')!.email, 'sentinel@example.com',
      'duplicate delivery re-applied the handler');
  });

  await check('subscription.created arriving before customer.created still writes', async () => {
    // The FK is enforced by the fake DB, so this passes only because the
    // handler stubs the parent customer row first.
    const body = envelope('subscription.created',
      subscriptionPayload({ id: 'sub_ooo', customer_id: 'ctm_never_seen' }), 'evt_ooo_01');
    const res = await post(body, { 'paddle-signature': sign(body) });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.ok(table('billing_customers').has('ctm_never_seen'), 'stub parent customer was not created');
    assert.ok(table('billing_subscriptions').has('sub_ooo'));
  });

  await check('a late redelivery of an OLDER event does not roll back newer state', async () => {
    const newer = envelope('subscription.updated',
      subscriptionPayload({ id: 'sub_order', status: 'active' }),
      'evt_order_new', '2026-08-10T12:00:00Z');
    await post(newer, { 'paddle-signature': sign(newer) });
    assert.equal(table('billing_subscriptions').get('sub_order')!.status, 'active');

    const older = envelope('subscription.created',
      subscriptionPayload({ id: 'sub_order', status: 'trialing' }),
      'evt_order_old', '2026-08-09T12:00:00Z');
    const res = await post(older, { 'paddle-signature': sign(older) });

    assert.equal(res.status, 200, 'a stale event should be acknowledged, not retried');
    assert.equal(table('billing_subscriptions').get('sub_order')!.status, 'active',
      'stale event clobbered newer state');
  });

  await check('an unhandled event type is acknowledged, not retried forever', async () => {
    const body = envelope('report.created', { id: 'rep_01' }, 'evt_unhandled_01');
    const res  = await post(body, { 'paddle-signature': sign(body) });
    assert.equal(res.status, 200);
  });

  console.log('mirrored fields');

  await check('scheduled cancel is stored without changing status', async () => {
    const body = envelope('subscription.updated', subscriptionPayload({
      id: 'sub_sched', status: 'active',
      scheduled_change: { action: 'cancel', effective_at: '2026-09-01T00:00:00Z', resume_at: null },
    }), 'evt_sched_01');
    await post(body, { 'paddle-signature': sign(body) });

    const row = table('billing_subscriptions').get('sub_sched')!;
    assert.equal(row.status, 'active', 'a pending cancel must not change status');
    assert.equal(row.scheduled_change_action, 'cancel');
    assert.equal(row.scheduled_change_at, '2026-09-01T00:00:00Z');
  });

  await check('transaction.completed stores the total as an unparsed string', async () => {
    const body = envelope('transaction.completed', {
      id: 'txn_01test', status: 'completed', customer_id: 'ctm_01test',
      subscription_id: 'sub_01test', currency_code: 'USD', invoice_number: 'INV-001',
      billed_at: '2026-08-01T00:00:00Z', address_id: null, business_id: null,
      custom_data: null, origin: 'web', invoice_id: null, collection_mode: 'automatic',
      discount_id: null, billing_details: null, billing_period: null, items: [],
      details: { totals: { subtotal: '4000', tax: '800', total: '4800', discount: '0',
                           credit: '0', balance: '0', grand_total: '4800', fee: null,
                           earnings: null, currency_code: 'USD' },
                 line_items: [], tax_rates_used: [] },
      payments: [], checkout: null, created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    }, 'evt_txn_01');

    const res = await post(body, { 'paddle-signature': sign(body) });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const row = table('billing_transactions').get('txn_01test')!;
    assert.strictEqual(row.total, '4800', 'total must stay the exact string Paddle sent');
    assert.strictEqual(row.subscription_id, 'sub_01test');
  });

  await check('tenant_id from custom_data is mirrored; a bogus one is rejected', async () => {
    assert.equal(table('billing_subscriptions').get('sub_01test')!.tenant_id,
      '00000000-0000-4000-8000-000000000001');

    const body = envelope('subscription.updated',
      subscriptionPayload({ id: 'sub_badtenant', custom_data: { tenant_id: '../../etc/passwd' } }),
      'evt_badtenant_01');
    await post(body, { 'paddle-signature': sign(body) });
    assert.equal(table('billing_subscriptions').get('sub_badtenant')!.tenant_id, undefined,
      'a non-UUID tenant_id must never reach a column with an FK to tenants');
  });

  console.log('access gating');

  const row = (over: Record<string, unknown>) => ({
    subscription_id: 's', customer_id: 'c', tenant_id: null, status: 'active',
    price_id: 'pri', product_id: 'pro', items: [], collection_mode: null,
    currency_code: null, scheduled_change_action: null, scheduled_change_at: null,
    current_period_ends_at: null, canceled_at: null, last_event_at: null,
    created_at: '', updated_at: '', ...over,
  }) as Parameters<typeof subscriptionGrantsAccess>[0];

  await check('active and trialing both grant access', () => {
    assert.equal(subscriptionGrantsAccess(row({ status: 'active' })).granted, true);
    assert.equal(subscriptionGrantsAccess(row({ status: 'trialing' })).granted, true);
  });

  await check('a pending cancel does NOT revoke access', () => {
    const d = subscriptionGrantsAccess(row({
      status: 'active', scheduled_change_action: 'cancel',
      scheduled_change_at: '2026-09-01T00:00:00Z',
    }));
    assert.equal(d.granted, true, 'scheduled cancel must not revoke a paid-up subscription');
    assert.equal(d.scheduled?.action, 'cancel');
  });

  await check('a pending pause does NOT revoke access either', () => {
    assert.equal(subscriptionGrantsAccess(row({
      status: 'active', scheduled_change_action: 'pause',
      scheduled_change_at: '2026-09-01T00:00:00Z',
    })).granted, true);
  });

  await check('canceled and paused revoke access', () => {
    assert.equal(subscriptionGrantsAccess(row({ status: 'canceled' })).granted, false);
    assert.equal(subscriptionGrantsAccess(row({ status: 'paused' })).granted, false);
  });

  await check('past_due keeps access and is flagged as grace', () => {
    const d = subscriptionGrantsAccess(row({ status: 'past_due' }));
    assert.equal(d.granted, true);
    assert.equal(d.inGrace, true);
  });

  await check('no subscription, and an unknown status, are denied', () => {
    assert.equal(subscriptionGrantsAccess(null).granted, false);
    assert.equal(subscriptionGrantsAccess(row({ status: 'something_new' })).granted, false);
  });

  appServer.close();
  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch(err => { console.error(err); process.exit(1); });
