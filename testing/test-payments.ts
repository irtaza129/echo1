// Unit checks for the payment layer — the deterministic, security-critical parts
// that don't need a live Safepay sandbox: HMAC webhook verification, PKR money
// math, provider selection, and gateway-state mapping.
//
// Run:  npx tsx testing/test-payments.ts
import assert from 'node:assert';
import crypto from 'node:crypto';
import { rupeesToPaisa, paisaToRupees, paisaToGatewayAmount, formatPaisa } from '../payments/money.js';
import { PaymentProviderFactory } from '../payments/PaymentProviderFactory.js';
import { SafepayProvider } from '../payments/SafepayProvider.js';
import { CashProvider } from '../payments/CashProvider.js';
import type { TenantConfig } from '../src/lib/tenantConfig.js';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const WHSEC = 'whsec_test_secret_123';
const sign = (body: string) => crypto.createHmac('sha256', WHSEC).update(Buffer.from(body, 'utf8')).digest('hex');
const safepay = () => new SafepayProvider({ paymentApiKey: 'sk_test', paymentWebhookSecret: WHSEC });

console.log('money helpers');
check('rupeesToPaisa rounds to integer paisa', () => {
  assert.equal(rupeesToPaisa(850), 85000);
  assert.equal(rupeesToPaisa(123.45), 12345);
  assert.equal(rupeesToPaisa(0.1 + 0.2), 30); // float-safe (0.30000000000000004 → 30)
});
check('paisaToRupees + gateway amount round-trip', () => {
  assert.equal(paisaToRupees(12345), 123.45);
  assert.equal(paisaToGatewayAmount(85000), 850);
});
check('formatPaisa renders PKR with 2 dp', () => {
  assert.ok(formatPaisa(123450).startsWith('PKR'));
  assert.ok(formatPaisa(123450).includes('1,234.50'));
});
check('rupeesToPaisa rejects non-finite', () => {
  assert.throws(() => rupeesToPaisa(Number.NaN));
});

console.log('provider factory');
check('createById cash → CashProvider', () => {
  assert.ok(PaymentProviderFactory.createById('cash', {}) instanceof CashProvider);
});
check('createById safepay → SafepayProvider', () => {
  assert.ok(PaymentProviderFactory.createById('safepay', { paymentApiKey: 'k' }) instanceof SafepayProvider);
});
check('safepay without api key throws', () => {
  assert.throws(() => PaymentProviderFactory.createById('safepay', {}));
});
check('config with no payments block → cash + isOnline false', () => {
  const cfg = { businessRules: {} } as unknown as TenantConfig;
  assert.ok(PaymentProviderFactory.create(cfg, {}) instanceof CashProvider);
  assert.equal(PaymentProviderFactory.isOnline(cfg), false);
});
check('config with safepay → isOnline true', () => {
  const cfg = { payments: { provider: 'safepay' } } as unknown as TenantConfig;
  assert.equal(PaymentProviderFactory.isOnline(cfg), true);
});

console.log('cash provider');
check('cash checkout is immediately captured', async () => {
  const r = await new CashProvider().createCheckout({ orderId: 'o1', amountPaisa: 100, currency: 'PKR' });
  assert.equal(r.status, 'captured');
});

console.log('safepay webhook signature verification');
check('valid signature + PAID state → captured', () => {
  const body = JSON.stringify({ type: 'payment:created', data: { tracker: 'trk_1', state: 'PAID' } });
  const r = safepay().verifyWebhook(Buffer.from(body), { 'x-sfpy-signature': sign(body) });
  assert.equal(r.signatureValid, true);
  assert.equal(r.providerRef, 'trk_1');
  assert.equal(r.status, 'captured');
});
check('tampered body → signature invalid', () => {
  const body = JSON.stringify({ data: { tracker: 'trk_1', state: 'PAID' } });
  const sig  = sign(body);
  const tampered = JSON.stringify({ data: { tracker: 'trk_1', state: 'PAID', amount: 999999 } });
  const r = safepay().verifyWebhook(Buffer.from(tampered), { 'x-sfpy-signature': sig });
  assert.equal(r.signatureValid, false);
});
check('wrong secret → signature invalid', () => {
  const body = JSON.stringify({ data: { tracker: 'trk_1', state: 'PAID' } });
  const wrong = crypto.createHmac('sha256', 'someone_elses_secret').update(body).digest('hex');
  const r = safepay().verifyWebhook(Buffer.from(body), { 'x-sfpy-signature': wrong });
  assert.equal(r.signatureValid, false);
});
check('missing signature header → invalid (never throws)', () => {
  const body = JSON.stringify({ data: { tracker: 'trk_1', state: 'PAID' } });
  const r = safepay().verifyWebhook(Buffer.from(body), {});
  assert.equal(r.signatureValid, false);
});
check('state mapping: FAILED → failed, CANCELLED → cancelled', () => {
  const mk = (state: string) => {
    const body = JSON.stringify({ data: { tracker: 't', state } });
    return safepay().verifyWebhook(Buffer.from(body), { 'x-sfpy-signature': sign(body) }).status;
  };
  assert.equal(mk('FAILED'), 'failed');
  assert.equal(mk('CANCELLED'), 'cancelled');
  assert.equal(mk('REFUNDED'), 'refunded');
});

console.log(`\n${passed} checks passed`);
