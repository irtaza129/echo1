import { getRedis, redisKey, TTL } from './redis.js';
import type { LocalOrder } from './localMenuUtils.js';
import { mapStatus } from '../../payments/PaddleProvider.js';
import { fromPaddleAmount } from '../../payments/paddleCurrency.js';
import type { PaymentTransaction } from '../../payments/IPaymentProvider.js';

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
// Order state lives in Redis, not the Supabase billing mirror. Keeping diner
// payments out of billing_transactions is deliberate: that table feeds SaaS
// revenue reporting, and mixing per-order food revenue into it would make MRR
// meaningless.
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
  const redis  = getRedis();
  const now    = new Date().toISOString();

  // The payment record is keyed on the Paddle transaction id, which is exactly
  // what providerRef was set to at checkout.
  const txnKey = redisKey.payment(data.id);
  const txn    = await redis.get<PaymentTransaction>(txnKey);

  if (txn) {
    txn.status    = status;
    txn.updatedAt = now;
    if (data.details?.totals) {
      const raw = data.details.totals.grand_total ?? data.details.totals.total;
      if (raw !== undefined) txn.amountPaisa = fromPaddleAmount(raw, data.currency_code ?? 'USD');
    }
    await redis.set(txnKey, txn, { ex: TTL.PAYMENT });
  } else {
    console.warn(`[BILLING] order payment ${data.id} has no stored payment txn — ` +
                 `updating order ${orderId} anyway`);
  }

  const order = await redis.get<LocalOrder>(redisKey.localOrder(orderId));
  if (!order) {
    // The order expired (30-day TTL) or never existed. The money is still
    // Paddle's record of truth; nothing here can be fixed by a retry, so report
    // it as handled rather than forcing 3 days of redeliveries.
    return { applied: false, reason: `order ${orderId} not found`, orderId, status };
  }

  order.payment_status = status;
  order.payment_ref    = data.id;
  order.payment_method = 'paddle';
  order.updated_at     = now;

  // Only a captured payment advances the kitchen. A `pending` order that has
  // been paid becomes `confirmed` so it shows up on the dashboard as a real,
  // paid order — mirroring exactly what the Safepay webhook path does.
  if (status === 'captured' && order.status === 'pending') {
    order.status = 'confirmed';
  }

  await redis.set(redisKey.localOrder(orderId), order, { ex: TTL.LOCAL_ORDER });

  console.log(`[BILLING] order payment ${data.id} → order ${orderId} ` +
              `payment=${status} status=${order.status}`);

  return { applied: true, reason: `order ${orderId} → ${status}`, orderId, status };
}
