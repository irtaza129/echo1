import crypto from 'crypto';
import { getRedis, redisKey, TTL } from './src/lib/redis.js';
import type { LocalOrder } from './src/lib/localMenuUtils.js';
import type { PaymentTransaction } from './payments/IPaymentProvider.js';

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end test of the Paddle ORDER-payment webhook path, against a locally
// running server and the real Redis. Proves, without needing a browser or a
// deployed endpoint:
//
//   1. a correctly signed delivery is accepted (2xx)
//   2. a tampered / wrongly signed delivery is rejected (non-2xx)
//   3. transaction.completed with kind=order_payment marks the order paid and
//      advances it pending → confirmed
//   4. transaction.payment_failed leaves the order unpaid and NOT advanced
//   5. redelivery of the same event is idempotent
//
// Run:  npx tsx --env-file=.env test-paddle-order.mts   (server must be running)
// ─────────────────────────────────────────────────────────────────────────────

const BASE   = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
const SECRET = process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET!;
const TENANT = '00000000-0000-4000-8000-000000000001';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else    { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Paddle signs `${ts}:${rawBody}` with HMAC-SHA256 and sends
// `Paddle-Signature: ts=<unix>;h1=<hex>`. Reproducing it exactly is the only way
// to test the handler without a live delivery.
function sign(body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

function txnEvent(opts: {
  eventId: string; eventType: string; txnId: string; orderId: string; status: string;
}) {
  return JSON.stringify({
    event_id:    opts.eventId,
    event_type:  opts.eventType,
    occurred_at: new Date().toISOString(),
    notification_id: 'ntf_' + opts.eventId,
    data: {
      id:            opts.txnId,
      status:        opts.status,
      customer_id:   'ctm_test_diner',
      currency_code: 'USD',
      custom_data:   { kind: 'order_payment', order_id: opts.orderId, tenant_id: TENANT },
      details:       {
        totals:         { total: '85000', grand_total: '85000' },
        // TransactionDetails maps over both of these unconditionally too.
        tax_rates_used: [],
        line_items:     [],
      },
      // The SDK's Transaction entity maps over both of these unconditionally,
      // so they must be present arrays — real Paddle payloads always include
      // them, and a payload missing either throws inside unmarshal().
      items:         [],
      payments:      [],
      billed_at:     new Date().toISOString(),
    },
  });
}

async function post(body: string, signature: string) {
  const res = await fetch(`${BASE}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Paddle-Signature': signature },
    body,
  });
  return { status: res.status, text: await res.text() };
}

async function seedOrder(redis: ReturnType<typeof getRedis>, orderId: string, txnId: string) {
  const now = new Date().toISOString();
  const order: LocalOrder = {
    id: orderId, order_number: 9001, tenant_id: TENANT, status: 'pending',
    items: [], subtotal: 850, total: 850,
    customer_name: 'Test Diner', customer_phone: '', order_type: 'dine_in',
    payment_method: 'paddle', payment_status: 'initiated', payment_ref: txnId,
    notes: null, created_at: now, updated_at: now,
  };
  const txn: PaymentTransaction = {
    providerRef: txnId, provider: 'paddle', tenantId: TENANT, orderId,
    amountPaisa: 85000, currency: 'USD', status: 'initiated', method: 'card',
    createdAt: now, updatedAt: now,
  };
  await redis.set(redisKey.localOrder(orderId), order, { ex: TTL.LOCAL_ORDER });
  await redis.set(redisKey.payment(txnId), txn, { ex: TTL.PAYMENT });
}

const redis = getRedis();
const stamp = Date.now();

// ── 1. successful payment ────────────────────────────────────────────────────
console.log('\n1. transaction.completed → order paid and confirmed');
{
  const orderId = `test-order-ok-${stamp}`;
  const txnId   = `txn_ok_${stamp}`;
  await seedOrder(redis, orderId, txnId);

  const body = txnEvent({
    eventId: `evt_ok_${stamp}`, eventType: 'transaction.completed',
    txnId, orderId, status: 'completed',
  });
  const res = await post(body, sign(body));
  check('handler returned 2xx', res.status >= 200 && res.status < 300, `got ${res.status} ${res.text}`);

  const order = await redis.get<LocalOrder>(redisKey.localOrder(orderId));
  check('payment_status = captured', order?.payment_status === 'captured', `got ${order?.payment_status}`);
  check('order advanced pending → confirmed', order?.status === 'confirmed', `got ${order?.status}`);
  check('payment_ref recorded', order?.payment_ref === txnId);

  const txn = await redis.get<PaymentTransaction>(redisKey.payment(txnId));
  check('payment txn status = captured', txn?.status === 'captured', `got ${txn?.status}`);
  check('amount preserved (85000 minor units)', txn?.amountPaisa === 85000, `got ${txn?.amountPaisa}`);
}

// ── 2. bad signature ─────────────────────────────────────────────────────────
console.log('\n2. forged signature → rejected, order untouched');
{
  const orderId = `test-order-forged-${stamp}`;
  const txnId   = `txn_forged_${stamp}`;
  await seedOrder(redis, orderId, txnId);

  const body = txnEvent({
    eventId: `evt_forged_${stamp}`, eventType: 'transaction.completed',
    txnId, orderId, status: 'completed',
  });
  const res = await post(body, sign(body, 'pdl_ntfset_wrong_secret_entirely'));
  check('handler returned non-2xx', res.status < 200 || res.status >= 300, `got ${res.status}`);

  const order = await redis.get<LocalOrder>(redisKey.localOrder(orderId));
  check('order still pending', order?.status === 'pending', `got ${order?.status}`);
  check('order still unpaid', order?.payment_status === 'initiated', `got ${order?.payment_status}`);
}

// ── 3. declined payment ──────────────────────────────────────────────────────
console.log('\n3. transaction.payment_failed → order stays unpaid');
{
  const orderId = `test-order-decline-${stamp}`;
  const txnId   = `txn_decline_${stamp}`;
  await seedOrder(redis, orderId, txnId);

  const body = txnEvent({
    eventId: `evt_decline_${stamp}`, eventType: 'transaction.payment_failed',
    txnId, orderId, status: 'past_due',
  });
  const res = await post(body, sign(body));
  check('handler returned 2xx', res.status >= 200 && res.status < 300, `got ${res.status} ${res.text}`);

  const order = await redis.get<LocalOrder>(redisKey.localOrder(orderId));
  check('payment_status = failed', order?.payment_status === 'failed', `got ${order?.payment_status}`);
  check('order NOT advanced to confirmed', order?.status === 'pending', `got ${order?.status}`);
}

// ── 4. idempotency ───────────────────────────────────────────────────────────
console.log('\n4. redelivery of the same event is idempotent');
{
  const orderId = `test-order-dup-${stamp}`;
  const txnId   = `txn_dup_${stamp}`;
  await seedOrder(redis, orderId, txnId);

  const body = txnEvent({
    eventId: `evt_dup_${stamp}`, eventType: 'transaction.completed',
    txnId, orderId, status: 'completed',
  });
  const first  = await post(body, sign(body));
  const second = await post(body, sign(body));

  check('first delivery 2xx',  first.status  >= 200 && first.status  < 300, `got ${first.status}`);
  check('redelivery also 2xx', second.status >= 200 && second.status < 300, `got ${second.status}`);

  const order = await redis.get<LocalOrder>(redisKey.localOrder(orderId));
  check('order state unchanged by replay', order?.status === 'confirmed' && order?.payment_status === 'captured',
        `got ${order?.status}/${order?.payment_status}`);
}

// ── 5. subscription events still reach the SaaS mirror ───────────────────────
console.log('\n5. a non-order transaction is NOT treated as an order payment');
{
  const body = JSON.stringify({
    event_id: `evt_saas_${stamp}`, event_type: 'transaction.completed',
    occurred_at: new Date().toISOString(),
    data: {
      id: `txn_saas_${stamp}`, status: 'completed', customer_id: 'ctm_saas_test',
      currency_code: 'USD', subscription_id: 'sub_test',
      custom_data: { tenant_id: TENANT },   // no `kind` → SaaS path
      details: { totals: { total: '4000', grand_total: '4000' }, tax_rates_used: [], line_items: [] },
      items: [], payments: [],
    },
  });
  const res = await post(body, sign(body));
  check('handler returned 2xx', res.status >= 200 && res.status < 300, `got ${res.status} ${res.text}`);
}

console.log(`\n${'─'.repeat(60)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
