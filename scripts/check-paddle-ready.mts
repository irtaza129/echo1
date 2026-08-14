import { paddleFetch, paddleEnv, paddleApiBase, clientToken, webhookSecret, isBillingConfigured } from '../src/lib/paddle.js';

// ─────────────────────────────────────────────────────────────────────────────
// Preflight for the Paddle integration. Run before deploying or testing:
//
//   npx tsx --env-file=.env scripts/check-paddle-ready.mts
//
// Every check hits the real API rather than inspecting config, because the
// failures that matter (a payment link that was set on the wrong account, a
// destination pointing at a dead URL) all look fine in a config file.
// ─────────────────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const ok   = (m: string, d = '') => { pass++; console.log(`  ✓ ${m}${d ? ` — ${d}` : ''}`); };
const bad  = (m: string, d = '') => { fail++; console.log(`  ✗ ${m}${d ? `\n      ${d}` : ''}`); };

console.log(`\nPaddle preflight — ${paddleEnv()} (${paddleApiBase()})\n`);

// ── credentials ──────────────────────────────────────────────────────────────
console.log('Credentials');
isBillingConfigured() ? ok('API key set') : bad('API key missing (PADDLE_API_KEY / PADDLE_SANDBOX)');
webhookSecret()       ? ok('webhook signing secret set') : bad('PADDLE_NOTIFICATION_WEBHOOK_SECRET missing');

const token = clientToken();
if (!token) bad('client token missing (PADDLE_CLIENT_TOKEN / CLIENT)');
else if (paddleEnv() === 'sandbox' && !token.startsWith('test_')) {
  bad('client token is not a sandbox token', `expected test_…, got ${token.slice(0, 5)}…`);
} else ok('client token set', `${token.slice(0, 5)}…`);

// ── catalogue ────────────────────────────────────────────────────────────────
console.log('\nCatalogue');
try {
  const prices = await paddleFetch<Array<{ id: string }>>('/prices?per_page=50&status=active');
  prices.length ? ok(`${prices.length} active prices`) : bad('no active prices — run the catalog-setup skill');
} catch (e) { bad('could not list prices', String(e)); }

// ── notification destination ─────────────────────────────────────────────────
console.log('\nWebhook destination');
try {
  const dests = await paddleFetch<Array<{
    id: string; destination: string; active: boolean;
    subscribed_events: Array<{ name: string }>;
  }>>('/notification-settings');

  if (!dests.length) bad('no notification destinations configured');

  for (const d of dests) {
    const events = d.subscribed_events.map(e => e.name);
    d.active ? ok(`destination active`, d.destination) : bad('destination is inactive', d.destination);

    // Every event the handler branches on must actually be subscribed, or that
    // code path is silently never exercised in production.
    for (const required of [
      'transaction.completed', 'transaction.payment_failed',
      'subscription.created', 'subscription.updated', 'subscription.canceled',
      'customer.created', 'customer.updated',
    ]) {
      events.includes(required)
        ? ok(`subscribed: ${required}`)
        : bad(`NOT subscribed: ${required}`, 'the matching handler branch will never fire');
    }

    // A destination pointing at a URL that 404s means every delivery fails.
    try {
      const res = await fetch(d.destination, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Paddle-Signature': 'ts=1;h1=deadbeef' },
        body: JSON.stringify({ event_id: 'evt_preflight', event_type: 'customer.created' }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 404) {
        bad('destination URL returns 404', 'the billing routes are not deployed at that URL');
      } else if (res.status >= 200 && res.status < 300) {
        bad('destination returned 2xx for an INVALID signature',
            'a forged webhook would be accepted — check signature verification');
      } else {
        ok(`destination rejects bad signatures`, `HTTP ${res.status}`);
      }
    } catch (e) {
      bad('destination unreachable', String(e));
    }
  }
} catch (e) { bad('could not read notification settings', String(e)); }

// ── checkout ─────────────────────────────────────────────────────────────────
// The one that keeps biting: no default payment link means Paddle refuses to
// create ANY transaction, so no checkout of any kind can open.
console.log('\nCheckout');
try {
  const txn = await paddleFetch<{ id: string; checkout?: { url?: string | null } }>('/transactions', {
    method: 'POST',
    body: {
      items: [{ quantity: 1, price: {
        description: 'preflight', name: 'preflight',
        product: { name: 'preflight', tax_category: 'standard' },
        unit_price: { amount: '100', currency_code: 'USD' },
      }}],
      custom_data: { kind: 'preflight' },
      collection_mode: 'automatic',
    },
  });
  ok('transactions can be created', txn.id);
  txn.checkout?.url
    ? ok('hosted checkout URL returned')
    : bad('no checkout URL on the transaction', 'set a default payment link');
} catch (e) {
  const msg = String(e);
  if (msg.includes('default_checkout_url_not_set')) {
    bad('no default payment link set on this account',
        `Set it in the ${paddleEnv()} dashboard — these are SEPARATE dashboards:\n` +
        `      sandbox: https://sandbox-vendors.paddle.com/checkout-settings\n` +
        `      live:    https://vendors.paddle.com/checkout-settings\n` +
        `      Paddle → Checkout → Checkout settings → Default payment link`);
  } else {
    bad('could not create a transaction', msg);
  }
}

console.log(`\n${'─'.repeat(64)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
