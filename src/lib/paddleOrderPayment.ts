import { loadPaymentTxn, updatePaymentStatus } from './paymentStore.js';
import { ordersRepo } from './posRepo.js';
import { mapStatus } from '../../payments/PaddleProvider.js';
import { fromPaddleAmount } from '../../payments/paddleCurrency.js';

// ─────────────────────────────────────────────────────────────────────────────
// Diner order payments made through Paddle.
//
// These arrive at the SAME endpoint as the SaaS subscription webhooks
// (/api/billing/webhook), because a Paddle account has one notification
// destination and it cannot filter by payload. The two flows are told apart by
// custom_data.kind, stamped in PaddleProvider.createCheckout:
//
//   kind === 'order_payment'  → a diner paying a tenant for food  (here)
//   otherwise                 → a tenant paying US for a plan     (paddleWebhook.ts)
//
// The order itself lives in Postgres `orders` (the single ledger every channel
// writes to) and the payment attempt in Postgres `payment_transactions`, cached
// in Redis under `payment:<ref>`. Neither goes into the Supabase billing mirror,
// deliberately: that table feeds SaaS revenue reporting, and mixing per-order
// food revenue into it would make MRR meaningless.
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderPaymentResult {
  applied: boolean;
  reason:  string;
  orderId?: string;
  status?:  string;
}

interface PaddleTransactionData {
  id:            string;
  status?:       string;
  currency_code?: string;
  customData?:   unknown;
  custom_data?:  unknown;
  details?:      { totals?: { total?: string; grand_total?: string } };
}

/** Does this transaction event belong to the diner-order flow? */
export function isOrderPayment(customData: unknown): boolean {
  if (!customData || typeof customData !== 'object') return false;
  return (customData as Record<string, unknown>).kind === 'order_payment';
}

export function orderIdFrom(customData: unknown): string | undefined {
  if (!customData || typeof customData !== 'object') return undefined;
  const raw = (customData as Record<string, unknown>).order_id;
  return typeof raw === 'string' && raw ? raw : undefined;
}

/**
 * Apply a verified Paddle transaction event to the order it paid for.
 *
 * Idempotent by construction: it writes an absolute status derived from the
 * event rather than mutating relatively, so a redelivery converges on the same
 * result. Paddle retries for up to 3 days, so this WILL be called twice.
 */
export async function applyOrderPayment(
  data: PaddleTransactionData,
  eventType: string,
): Promise<OrderPaymentResult> {
  const customData = data.customData ?? data.custom_data;
  const orderId    = orderIdFrom(customData);

  if (!orderId) {
    // Nothing to attach the payment to. Not an error worth retrying — the
    // transaction simply was not created by our order flow.
    return { applied: false, reason: 'transaction carries no order_id' };
  }

  const status = mapStatus(String(data.status ?? ''), eventType);

  // The payment record is keyed on the Paddle transaction id, which is exactly
  // what providerRef was set to at checkout. Resolved from the cache, falling
  // back to payment_transactions — Paddle retries for up to three days, well
  // past the point where a cache entry may have expired.
  const txn = await loadPaymentTxn(data.id);

  if (txn) {
    let amountPaisa: number | undefined;
    if (data.details?.totals) {
      const raw = data.details.totals.grand_total ?? data.details.totals.total;
      if (raw !== undefined) amountPaisa = fromPaddleAmount(raw, data.currency_code ?? 'USD');
    }
    await updatePaymentStatus(txn, status, amountPaisa);
  } else {
    console.warn(`[BILLING] order payment ${data.id} has no stored payment txn — ` +
                 `updating order ${orderId} anyway`);
  }

  // The order lives in Postgres. applyPayment writes absolute values and only
  // advances a still-pending order to 'confirmed' on capture, mirroring exactly
  // what the Safepay webhook path does.
  const updated = await ordersRepo.applyPayment(orderId, {
    paymentStatus: status,
    paymentRef:    data.id,
    paymentMethod: 'paddle',
  });

  if (!updated) {
    // Nothing here can be fixed by a retry — the order was never ours, or it
    // predates the Postgres ledger. Report it handled rather than forcing three
    // days of Paddle redeliveries. The money remains Paddle's record of truth.
    return { applied: false, reason: `order ${orderId} not found`, orderId, status };
  }

  console.log(`[BILLING] order payment ${data.id} → order ${orderId} ` +
              `payment=${status} status=${updated.status}`);

  return { applied: true, reason: `order ${orderId} → ${status}`, orderId, status };
}
