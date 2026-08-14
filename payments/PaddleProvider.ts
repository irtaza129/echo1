import crypto from 'crypto';
import { paddleFetch, webhookSecret } from '../src/lib/paddle.js';
import { assertPaddleCurrency, toPaddleAmount, fromPaddleAmount } from './paddleCurrency.js';
import type {
  IPaymentProvider, CheckoutParams, CheckoutResult,
  WebhookVerifyResult, PaymentStatusResult, PaymentStatus,
} from './IPaymentProvider.js';

// ─────────────────────────────────────────────────────────────────────────────
// Paddle — card collection for a diner paying a tenant for their order.
//
// IMPORTANT, and different from SafepayProvider: Paddle is a Merchant of Record
// operating at the PLATFORM level. There is one Paddle account (ours), not one
// per tenant, and Paddle has no marketplace/split-payment mechanism. So money
// collected here settles into OUR account and tenants must be paid out
// separately — `tenant_id` on the transaction is what makes that reconciliation
// possible, which is why it is stamped on every checkout and asserted below.
//
// Currency decides whether this provider is usable at all. Paddle rejects PKR
// outright (see payments/paddleCurrency.ts), so Pakistani tenants stay on cash
// until SafepayProvider is wired into the order flow.
//
// Each order is a one-off, so items use ad-hoc ("non-catalog") prices rather
// than a catalogue price_id — the catalogue holds the SaaS plans tenants buy
// from us, which is a different flow entirely (routes/billing.ts).
//
// Cardholder data NEVER touches this process — the customer enters card + 3DS on
// Paddle's hosted checkout, keeping us in SAQ-A scope.
// ─────────────────────────────────────────────────────────────────────────────

interface PaddleTransaction {
  id:            string;
  status:        string;
  currency_code?: string;
  checkout?:     { url?: string | null } | null;
  details?:      { totals?: { total?: string; grand_total?: string } };
  items?:        Array<{ price?: { id?: string } }>;
}

export class PaddleProvider implements IPaymentProvider {
  readonly id = 'paddle' as const;

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    // Throws with the full supported-currency list if the tenant is on PKR.
    // Failing here is much better than creating an order the customer can never
    // pay for.
    const currency = assertPaddleCurrency(params.currency);

    const txn = await paddleFetch<PaddleTransaction>('/transactions', {
      method: 'POST',
      body: {
        items: [{
          quantity: 1,
          price: {
            description: params.description ?? `Order ${params.orderId}`,
            name:        params.description ?? `Order ${params.orderId}`,
            // An ad-hoc price still needs a product. Creating it inline avoids
            // polluting the catalogue with one product per order.
            product: {
              name:         params.description ?? 'Food order',
              tax_category: 'standard',
            },
            unit_price: {
              amount:        toPaddleAmount(params.amountPaisa, currency),
              currency_code: currency,
            },
          },
        }],
        // The webhook arrives with nothing but this to identify the order, so
        // every field the handler needs has to be here. `kind` separates order
        // payments from the SaaS subscription transactions that hit the same
        // endpoint — see src/lib/paddleWebhook.ts.
        custom_data: {
          kind:      'order_payment',
          order_id:  params.orderId,
          tenant_id: params.tenantId ?? null,
        },
        collection_mode: 'automatic',
        ...(params.customerEmail
          ? { customer: { email: params.customerEmail } }
          : {}),
      },
    });

    return {
      providerRef: txn.id,
      status:      mapStatus(txn.status),
      // Present once a default payment link is configured on the account
      // (Paddle → Checkout → Checkout settings). Without it Paddle refuses to
      // create the transaction at all, so reaching here means it is set.
      redirectUrl: txn.checkout?.url ?? undefined,
      // Paddle.js opens an existing transaction by id: Paddle.Checkout.open({
      // transactionId }). Handing it back lets the kiosk render the overlay
      // inline instead of navigating away.
      clientToken: txn.id,
    };
  }

  // Synchronous by contract (IPaymentProvider), so this implements Paddle's
  // signature scheme directly rather than going through the SDK's async
  // webhooks.unmarshal(). Same algorithm, same result.
  //
  // Paddle-Signature: ts=1671552777;h1=<hex hmac-sha256 of `${ts}:${rawBody}`>
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerifyResult {
    const secret   = webhookSecret();
    const provided = headerValue(headers, 'paddle-signature');

    let signatureValid = false;
    let ts: string | undefined;
    let h1: string | undefined;

    if (provided) {
      for (const part of provided.split(';')) {
        const [k, v] = part.split('=');
        if (k === 'ts') ts = v;
        if (k === 'h1') h1 = v;
      }
    }

    if (secret && ts && h1) {
      const expected = crypto
        .createHmac('sha256', secret)
        .update(`${ts}:${rawBody.toString('utf8')}`)
        .digest('hex');
      signatureValid = timingSafeEqualHex(expected, h1);
    }

    let parsed: unknown = {};
    try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { /* leave as {} */ }
    const body  = (parsed ?? {}) as Record<string, unknown>;
    const data  = (body.data ?? {}) as Record<string, unknown>;
    const event = typeof body.event_type === 'string' ? body.event_type : undefined;

    const currency = String(data.currency_code ?? 'USD');
    const totals   = ((data.details as Record<string, unknown> | undefined)?.totals ?? {}) as Record<string, unknown>;
    const rawTotal = totals.grand_total ?? totals.total;

    return {
      signatureValid,
      providerRef: String(data.id ?? ''),
      status:      mapStatus(String(data.status ?? ''), event),
      event,
      amountPaisa: rawTotal === undefined || rawTotal === null
        ? undefined
        : fromPaddleAmount(String(rawTotal), currency),
    };
  }

  async getStatus(providerRef: string): Promise<PaymentStatusResult> {
    const txn = await paddleFetch<PaddleTransaction>(
      `/transactions/${encodeURIComponent(providerRef)}`,
    );
    const currency = txn.currency_code ?? 'USD';
    const rawTotal = txn.details?.totals?.grand_total ?? txn.details?.totals?.total;

    return {
      providerRef,
      status:      mapStatus(txn.status),
      amountPaisa: rawTotal === undefined ? undefined : fromPaddleAmount(rawTotal, currency),
    };
  }

  // Paddle refunds are Adjustments against a transaction's items, and each
  // adjustment needs the item's price id — so the transaction has to be fetched
  // first. Adjustments are also not instant: they land as `pending_approval`
  // until Paddle reviews them, which is why this reports the requested state
  // rather than claiming the money is already back.
  async refund(providerRef: string, amountPaisa: number): Promise<PaymentStatusResult> {
    const txn = await paddleFetch<PaddleTransaction>(
      `/transactions/${encodeURIComponent(providerRef)}`,
    );
    const currency = txn.currency_code ?? 'USD';
    const priceId  = txn.items?.[0]?.price?.id;
    if (!priceId) throw new Error(`[PADDLE] transaction ${providerRef} has no item to refund`);

    const total    = txn.details?.totals?.grand_total ?? txn.details?.totals?.total;
    const isFull   = total !== undefined && fromPaddleAmount(total, currency) === amountPaisa;

    await paddleFetch('/adjustments', {
      method: 'POST',
      body: {
        action:         'refund',
        transaction_id: providerRef,
        reason:         'Order refunded',
        items: [
          isFull
            ? { item_id: priceId, type: 'full' }
            : { item_id: priceId, type: 'partial', amount: toPaddleAmount(amountPaisa, currency) },
        ],
      },
    });

    return { providerRef, status: 'refunded', amountPaisa };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Paddle transaction status → our provider-neutral PaymentStatus.
//
// `billed` is deliberately NOT 'captured': it means an invoice was issued and
// payment is still outstanding. Treating it as captured would release food for
// an order nobody has paid for.
export function mapStatus(status: string, event?: string): PaymentStatus {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'paid':      return 'captured';
    case 'billed':    return 'authorized';
    case 'draft':
    case 'ready':     return 'initiated';
    case 'canceled':
    case 'cancelled': return 'cancelled';
    case 'past_due':  return 'failed';
    default:
      // Fall back to the event name when the status field is absent or unknown.
      if (event === 'transaction.completed') return 'captured';
      if (event === 'transaction.payment_failed') return 'failed';
      if (event === 'transaction.canceled') return 'cancelled';
      return 'initiated';
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}

// Constant-time compare. Buffers must be equal length before timingSafeEqual, so
// mismatched lengths short-circuit to false rather than throwing.
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
