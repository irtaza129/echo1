import { getRedis, redisKey, TTL } from './redis.js';
import { paymentsRepo, mustWrite } from './repo.js';
import type { PaymentTransaction, PaymentStatus } from '../../payments/IPaymentProvider.js';

// ─────────────────────────────────────────────────────────────────────────────
// Diner card payment records.
//
// public.payment_transactions is the durable record; Redis `payment:<ref>` is a
// hot copy in front of it. Until this module existed there was no durable half:
// savePaymentTxn() in server.ts wrote Redis and only Redis, under a 30-day TTL,
// so the record of a customer's card payment deleted itself a month after they
// made it. The Postgres table had been provisioned for exactly this in
// migrations/002_payments.sql and never received a single row.
//
// Why the cache stays: the gateway webhook arrives knowing only a provider
// reference, and it needs the tenant off this record before it can pick which
// tenant's secret to verify the signature against. That lookup is on the
// critical path of every payment notification.
//
// NEVER stores PAN / card / EMV data — only the gateway's reference and the
// outcome, which is all reconciliation against a settlement file needs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a payment attempt: Postgres first, then the cache.
 *
 * Throws if Postgres rejects the write, and callers must let that fail the
 * request. At the point this is called the gateway session exists but the
 * customer has not been handed its URL, so aborting loses an unused checkout —
 * whereas continuing would take money against a record that only lives in a
 * cache with a TTL on it.
 *
 * order_id carries a foreign key into public.orders, so only call this where
 * the order is known to exist.
 */
export async function savePaymentTxn(txn: PaymentTransaction): Promise<void> {
  await mustWrite('payment_transactions.record', paymentsRepo.record(txn));
  await cache(txn);
}

/**
 * Find a payment attempt by its gateway reference: cache, then Postgres.
 *
 * The Postgres fallback is what makes a webhook or status poll still resolvable
 * after the cache entry has expired. Previously an expired key meant the webhook
 * answered "Unknown payment reference" and the payment could never be reconciled
 * against the order at all.
 */
export async function loadPaymentTxn(providerRef: string): Promise<PaymentTransaction | null> {
  try {
    const cached = await getRedis().get<PaymentTransaction>(redisKey.payment(providerRef));
    if (cached) return cached;
  } catch {
    // Cache unavailable — fall through to the durable record.
  }

  const stored = await paymentsRepo.findByRef(providerRef);
  if (stored) void cache(stored);
  return stored;
}

/**
 * Advance an attempt's outcome in both stores.
 *
 * Postgres is updated first and is allowed to throw. On the webhook path that
 * surfaces as a non-2xx, which makes the gateway redeliver — the correct
 * outcome when we failed to record a status change, and the reason this is not
 * best-effort like an audit write. The write is idempotent (absolute status,
 * not a relative mutation), so a redelivery converges.
 */
export async function updatePaymentStatus(
  txn:          PaymentTransaction,
  status:       PaymentStatus,
  amountPaisa?: number,
): Promise<PaymentTransaction> {
  await paymentsRepo.updateStatus(txn.providerRef, status, amountPaisa);

  const next: PaymentTransaction = {
    ...txn,
    status,
    amountPaisa: amountPaisa ?? txn.amountPaisa,
    updatedAt:   new Date().toISOString(),
  };
  await cache(next);
  return next;
}

/** Refresh the hot copy. Never throws — Postgres already holds the record. */
async function cache(txn: PaymentTransaction): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(redisKey.payment(txn.providerRef), txn, { ex: TTL.PAYMENT });
    // orderId → providerRef pointer, so a status poll that knows only the order
    // can find the attempt. Skipped when the attempt is not tied to an order.
    if (txn.orderId) {
      await redis.set(redisKey.orderPayment(txn.orderId), txn.providerRef, { ex: TTL.PAYMENT });
    }
  } catch {
    // Non-fatal by definition.
  }
}
