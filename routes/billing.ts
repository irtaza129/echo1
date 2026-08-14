import { Router, type Request, type Response } from 'express';
import {
  getPaddle, webhookSecret, isBillingConfigured, paddleEnv,
  clientToken, assertClientTokenMatchesEnv,
} from '../src/lib/paddle.js';
import { processEvent } from '../src/lib/paddleWebhook.js';
import {
  billingCustomersRepo,
  billingSubscriptionsRepo,
  subscriptionGrantsAccess,
  type BillingSubscriptionRow,
} from '../src/lib/billingRepo.js';
import { usersRepo } from '../src/lib/repo.js';

// Paddle billing. Two routers because the two halves have opposite trust models
// and must sit on opposite sides of the rate limiters in server.ts:
//
//   webhookRouter — public, unauthenticated, proves itself with an HMAC
//     signature. Mounted BEFORE the general limiter: Paddle can burst several
//     deliveries at once, and a 429 reads as a failed delivery and burns a
//     retry attempt. It carries its own, looser webhook limiter instead.
//
//   billingRouter — session-authenticated tenant routes. Mounted after the
//     limiters with the rest of the API.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Webhook ──────────────────────────────────────────────────────────────────

export const webhookRouter = Router();

// Inbound Paddle webhook. Authenticity comes from the signature, never from a
// session — this endpoint is public by design.
//
// Status code contract, which is the whole reason this handler is shaped the
// way it is: Paddle treats ONLY a 2xx as "delivered". Every other status is
// retried (sandbox ~3 attempts / 15 min, live ~60 attempts / 3 days). So a 2xx
// on a failure is the one unrecoverable mistake — the event is marked delivered
// and never comes back. Anything that fails here must answer non-2xx.
// Mounted at /api/billing/webhook in server.ts.
webhookRouter.post('/', async (req: Request, res: Response) => {
  const signature = req.headers['paddle-signature'];

  // The RAW bytes Paddle signed. This comes from the global express.json()
  // verify hook in server.ts, which stashes the untouched buffer on req.rawBody.
  //
  // Do NOT add express.raw() to this route: the global json() parser has
  // already consumed the stream by the time route middleware runs, so raw()
  // would hand back an empty buffer and every signature would fail. The
  // WhatsApp webhook has the same note for the same reason.
  //
  // Re-serialising req.body would also fail — JSON.stringify does not reproduce
  // Paddle's exact byte sequence (key order, spacing, unicode escapes), and the
  // HMAC is over those exact bytes.
  const rawBody = req.rawBody;

  if (!isBillingConfigured() || !webhookSecret()) {
    // Misconfiguration, not a bad request. 503 keeps the event in Paddle's
    // retry queue so nothing is lost while the secret is being set.
    console.error('[BILLING] webhook received but PADDLE_API_KEY / PADDLE_NOTIFICATION_WEBHOOK_SECRET is not set');
    res.status(503).json({ error: 'Billing not configured' });
    return;
  }

  if (typeof signature !== 'string' || !signature || !rawBody?.length) {
    console.warn('[BILLING] webhook missing signature header or body');
    res.status(400).json({ error: 'Missing signature or body' });
    return;
  }

  try {
    const paddle = getPaddle();

    // Verifies the HMAC over the raw body, rejects stale timestamps, and
    // returns a typed event. Throws on any failure.
    const event = await paddle.webhooks.unmarshal(
      rawBody.toString('utf8'),
      webhookSecret()!,
      signature,
    );

    if (!event) {
      console.warn('[BILLING] webhook unmarshal returned no event');
      res.status(400).json({ error: 'Unprocessable event' });
      return;
    }

    const result = await processEvent(event);
    if (!result.handled) {
      console.log(`[BILLING] ignoring unsubscribed event type ${event.eventType}`);
    }

    res.json({ received: true });
  } catch (err) {
    // unmarshal throws indistinguishably for a forged signature, a rotated
    // secret, an expired timestamp and a malformed payload — there is no way to
    // tell them apart, so there is no point splitting the status. One non-2xx
    // for the whole catch: a genuinely forged request is harmless to retry, and
    // a secret rotation recovers on its own once the new secret is deployed.
    console.error('[BILLING] webhook processing failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── Public client configuration ──────────────────────────────────────────────

export const billingPublicRouter = Router();

// What Paddle.js needs to boot: the environment and the client-side token.
//
// This is deliberately unauthenticated. The client token is PUBLISHABLE by
// design — it can only open checkouts, never read or mutate account data — and
// the kiosk needs it before anyone has signed in. The API key, which is not
// publishable, is never touched here.
//
// Served from the server rather than baked in at build time so that flipping
// PADDLE_ENV does not require a rebuild, and so a live token can never end up
// in a bundle shipped to a sandbox deployment.
billingPublicRouter.get('/client-config', (_req: Request, res: Response) => {
  const token = clientToken();
  if (!token) {
    res.status(503).json({ error: 'Billing not configured', code: 'no_client_token' });
    return;
  }

  try {
    // Refuses to serve a live token from a sandbox server and vice versa. A
    // mismatch here is the one bug that takes real money off a real card during
    // what everyone believes is a test.
    assertClientTokenMatchesEnv(token);
  } catch (err) {
    console.error('[BILLING]', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Billing environment misconfigured' });
    return;
  }

  res.json({ environment: paddleEnv(), token });
});

// ── Authenticated tenant routes ──────────────────────────────────────────────

// Mounted at /api/billing in server.ts, behind requireAuth.
export const billingRouter = Router();

// Resolve the signed-in caller's Paddle customer id SERVER-SIDE.
//
// This is the security core of the portal flow. The customer id is derived from
// the session's tenant, never accepted from the request — otherwise any
// authenticated tenant could mint a portal session for another tenant's
// customer id and read their invoices and payment methods.
async function resolveCustomerId(req: Request): Promise<string | null> {
  const tenantId = req.jwtPayload?.tenantId;
  if (!tenantId) return null;

  // Primary bridge: the tenant_id carried through checkout custom_data.
  const byTenant = await billingCustomersRepo.findByTenant(tenantId);
  if (byTenant) return byTenant.customer_id;

  // Fallback bridge: match the signed-in user's email to the Paddle customer.
  // Covers checkouts that were completed without custom_data.
  //
  // The legacy Savour session sets a non-UUID `sub` ("legacy-agent1101"), which
  // Postgres would reject as invalid uuid input rather than simply not match —
  // so only look up subs that are actually UUIDs.
  const sub = req.jwtPayload?.sub;
  if (!sub || !UUID_RE.test(sub)) return null;
  const user = await usersRepo.findById(sub);
  if (!user?.email) return null;

  const byEmail = await billingCustomersRepo.findByEmail(user.email);
  return byEmail?.customer_id ?? null;
}

// Mint a one-time Paddle-hosted customer portal URL and hand back only the URL.
//
// POST, not GET: this creates a session on Paddle's side, and a GET would be
// prefetchable and cacheable.
billingRouter.post('/portal-session', async (req: Request, res: Response) => {
  if (!isBillingConfigured()) {
    res.status(503).json({ error: 'Billing not configured' });
    return;
  }

  try {
    const customerId = await resolveCustomerId(req);
    if (!customerId) {
      // Signed in, but never checked out — there is no Paddle customer to open
      // a portal for. Passing an empty id to the SDK would 400 with a much less
      // useful message, so answer explicitly and let the UI say "subscribe first".
      res.status(404).json({ error: 'No billing account', code: 'no_paddle_customer' });
      return;
    }

    // Deep links come back one per subscription id passed in. An empty array is
    // valid — the portal overview still works, there are just no per-sub links.
    const subs = await billingSubscriptionsRepo.listByCustomer(customerId);
    const subscriptionIds = subs.map(s => s.subscription_id);

    const session = await getPaddle().customerPortalSessions.create(customerId, subscriptionIds);

    // Return ONLY the overview URL. The raw session also carries the customer
    // id, the session id and the full deep-link table, none of which the client
    // needs to perform a redirect.
    //
    // These URLs are one-time use and time-limited: never cache them, mint a
    // fresh one per click.
    res.json({ url: session.urls.general.overview });
  } catch (err) {
    console.error('[BILLING] portal session failed:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'Could not open billing portal' });
  }
});

// Subscription state for the account screen, read from our own mirror rather
// than the Paddle API — the mirror is what access gating reads, so showing it
// keeps the screen honest about what the app actually believes.
billingRouter.get('/subscription', async (req: Request, res: Response) => {
  const tenantId = req.jwtPayload?.tenantId;
  if (!tenantId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const customerId = await resolveCustomerId(req);
    const subs: BillingSubscriptionRow[] = customerId
      ? await billingSubscriptionsRepo.listByCustomer(customerId)
      : [];

    // The newest access-granting subscription wins; if none grants access, fall
    // back to the newest row so the UI can explain why (canceled vs paused).
    const current = subs.find(s => subscriptionGrantsAccess(s).granted) ?? subs[0] ?? null;
    const access  = subscriptionGrantsAccess(current);

    res.json({
      environment: paddleEnv(),
      hasBillingAccount: Boolean(customerId),
      access,
      subscription: current && {
        subscription_id:        current.subscription_id,
        status:                 current.status,
        price_id:               current.price_id,
        product_id:             current.product_id,
        items:                  current.items,
        currency_code:          current.currency_code,
        current_period_ends_at: current.current_period_ends_at,
        scheduled_change:       access.scheduled,
      },
    });
  } catch (err) {
    console.error('[BILLING] subscription lookup failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Could not load subscription' });
  }
});
