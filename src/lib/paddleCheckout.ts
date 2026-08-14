import { initializePaddle, type Paddle, type CheckoutEventsData } from '@paddle/paddle-js';

// ─────────────────────────────────────────────────────────────────────────────
// Paddle.js — the browser half of card payments.
//
// Two things open a checkout in this app, and they are different flows:
//
//   openOrderCheckout()        a diner paying a tenant for food. The server has
//                              already created the transaction (PaddleProvider),
//                              so this only opens the existing transactionId.
//   openSubscriptionCheckout() a tenant subscribing to a plan with us, opened
//                              from a catalogue priceId.
//
// The environment and token come from GET /api/billing/client-config rather
// than a build-time constant, so switching PADDLE_ENV never requires a rebuild
// and a live token cannot be baked into a sandbox bundle.
//
// The instance is cached: initializePaddle injects a script tag, and calling it
// per checkout would add one on every click.
// ─────────────────────────────────────────────────────────────────────────────

let paddlePromise: Promise<Paddle> | null = null;

export interface PaddleClientConfig {
  environment: 'sandbox' | 'production';
  token:       string;
}

async function fetchClientConfig(): Promise<PaddleClientConfig> {
  const res = await fetch('/api/billing/client-config');
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `client-config returned HTTP ${res.status}`);
  }
  return await res.json() as PaddleClientConfig;
}

export async function getPaddle(): Promise<Paddle> {
  if (paddlePromise) return paddlePromise;

  paddlePromise = (async () => {
    const cfg = await fetchClientConfig();

    // Belt and braces: the server already refuses to serve a mismatched token,
    // but a live token reaching a sandbox kiosk would charge a real card, so
    // check again on the side that actually opens the payment form.
    if (cfg.environment === 'sandbox' && !cfg.token.startsWith('test_')) {
      throw new Error('[PADDLE] refusing to initialise: sandbox environment with a non-test_ token');
    }

    const paddle = await initializePaddle({
      environment: cfg.environment,
      token:       cfg.token,
    });
    if (!paddle) throw new Error('[PADDLE] initializePaddle returned undefined');

    console.log(`[PADDLE] initialised in ${cfg.environment}`);
    return paddle;
  })();

  // Don't cache a failed init — otherwise one transient network error leaves
  // checkout permanently broken for the life of the page.
  paddlePromise.catch(() => { paddlePromise = null; });

  return paddlePromise;
}

export interface CheckoutCallbacks {
  onCompleted?: (data: CheckoutEventsData | undefined) => void;
  onClosed?:    () => void;
}

/**
 * Open the overlay checkout for an order the server already created.
 *
 * NOTE the payment is NOT confirmed when onCompleted fires — that only means
 * the customer finished the form. The order is marked paid by the verified
 * transaction.completed webhook (src/lib/paddleOrderPayment.ts). Treating
 * onCompleted as proof of payment would let anyone mark an order paid by
 * closing an overlay.
 */
export async function openOrderCheckout(
  transactionId: string,
  callbacks: CheckoutCallbacks = {},
): Promise<void> {
  const paddle = await getPaddle();

  paddle.Update({
    eventCallback: (event) => {
      if (event.name === 'checkout.completed') callbacks.onCompleted?.(event.data);
      if (event.name === 'checkout.closed')    callbacks.onClosed?.();
    },
  });

  paddle.Checkout.open({
    transactionId,
    settings: { displayMode: 'overlay', theme: 'light' },
  });
}

/**
 * Open the overlay checkout for a tenant subscribing to one of our plans.
 *
 * `tenantId` is passed as custom_data because it is the bridge the webhook
 * handler uses to attribute the resulting customer and subscription to a tenant
 * (src/lib/paddleWebhook.ts tenantIdFrom). Without it the customer lands
 * unattributed and only the email fallback can recover it.
 */
export async function openSubscriptionCheckout(
  priceId: string,
  opts: { tenantId?: string; email?: string } & CheckoutCallbacks = {},
): Promise<void> {
  const paddle = await getPaddle();

  paddle.Update({
    eventCallback: (event) => {
      if (event.name === 'checkout.completed') opts.onCompleted?.(event.data);
      if (event.name === 'checkout.closed')    opts.onClosed?.();
    },
  });

  paddle.Checkout.open({
    items: [{ priceId, quantity: 1 }],
    ...(opts.tenantId ? { customData: { tenant_id: opts.tenantId } } : {}),
    ...(opts.email ? { customer: { email: opts.email } } : {}),
    settings: { displayMode: 'overlay', theme: 'light' },
  });
}
