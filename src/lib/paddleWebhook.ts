import {
  EventName,
  type EventEntity,
  type CustomerCreatedEvent,
  type CustomerUpdatedEvent,
  type SubscriptionCreatedEvent,
  type SubscriptionUpdatedEvent,
  type SubscriptionCanceledEvent,
  type TransactionCompletedEvent,
} from '@paddle/paddle-node-sdk';
import {
  billingCustomersRepo,
  billingSubscriptionsRepo,
  billingTransactionsRepo,
  billingEventsRepo,
} from './billingRepo.js';
import { isOrderPayment, applyOrderPayment } from './paddleOrderPayment.js';

// Turns a VERIFIED Paddle event into rows in the mirror. Signature verification
// happens in routes/billing.ts before anything here runs — nothing in this file
// may be reached by an unauthenticated caller.
//
// Two delivery facts drive every decision below:
//
//   1. At-least-once. The same eventId arrives on every retry, so each handler
//      is upsert-shaped and keyed on the Paddle resource id. Re-running a
//      handler converges on the same row rather than duplicating it.
//   2. Unordered. subscription.updated can arrive before subscription.created,
//      and an old event can be redelivered after a newer one has been applied.
//      Handlers are convergent, and the subscription handler additionally drops
//      events older than the last one applied (see isStale).
//
// Anything slow belongs in a queue, not here: Paddle times a delivery out at 5
// seconds and burns a retry attempt. Every handler below is a single DB write.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SubscriptionEvent =
  | SubscriptionCreatedEvent
  | SubscriptionUpdatedEvent
  | SubscriptionCanceledEvent;

export interface ProcessResult {
  handled: boolean;
  /** True when the ledger already had this eventId — a redelivery we skipped. */
  duplicate: boolean;
}

// Pull our tenant id out of Paddle custom_data. Checkout is responsible for
// setting it ({ custom_data: { tenant_id } }); anything else is untrusted input
// that reached us through Paddle, so it is validated as a UUID before it can be
// written into a column with a foreign key to tenants.
function tenantIdFrom(customData: unknown): string | undefined {
  if (!customData || typeof customData !== 'object') return undefined;
  const raw = (customData as Record<string, unknown>).tenant_id
           ?? (customData as Record<string, unknown>).tenantId;
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return undefined;
  return raw;
}

export async function processEvent(event: EventEntity): Promise<ProcessResult> {
  // The ledger guards side effects that are not naturally idempotent. The state
  // mirrors below would survive a replay on their own, but a redelivery should
  // not, for example, re-send a receipt once that is added here.
  if (await billingEventsRepo.seen(event.eventId)) {
    console.log(`[BILLING] duplicate delivery ${event.eventId} (${event.eventType}) — skipped`);
    return { handled: true, duplicate: true };
  }

  let handled = true;

  switch (event.eventType) {
    case EventName.SubscriptionCreated:
    case EventName.SubscriptionUpdated:
    case EventName.SubscriptionCanceled:
      await upsertSubscription(event as SubscriptionEvent);
      break;

    case EventName.CustomerCreated:
    case EventName.CustomerUpdated:
      await upsertCustomer(event as CustomerCreatedEvent | CustomerUpdatedEvent);
      break;

    // Both diner order payments and tenant subscription charges land here —
    // one Paddle account has one notification destination, and it cannot filter
    // by payload. custom_data.kind tells them apart (see paddleOrderPayment.ts).
    case EventName.TransactionCompleted:
    case EventName.TransactionPaymentFailed: {
      const txn = (event as TransactionCompletedEvent).data;
      if (isOrderPayment(txn.customData)) {
        await applyOrderPayment(
          txn as unknown as Parameters<typeof applyOrderPayment>[0],
          event.eventType,
        );
      } else if (event.eventType === EventName.TransactionCompleted) {
        // Only completed subscription charges belong in the SaaS mirror; a
        // failed one is Retain's problem and shows up as subscription.past_due.
        await recordTransaction(event as TransactionCompletedEvent);
      }
      break;
    }

    default:
      // A destination can be subscribed to more events than we handle. Ignoring
      // them is correct — throwing would make Paddle retry an event forever
      // that we are never going to do anything with.
      handled = false;
      break;
  }

  // Recorded only after the handler succeeded. If the write above threw, the
  // route returns non-2xx, Paddle redelivers, and the ledger miss lets the
  // retry run the handler again rather than skipping it as a duplicate.
  await billingEventsRepo.record({
    event_id:    event.eventId,
    event_type:  event.eventType,
    occurred_at: event.occurredAt,
  });

  return { handled, duplicate: false };
}

// Is this event older than the newest one already applied to the row? Paddle
// retries for up to 3 days in live, so a stale create can land long after the
// update that superseded it. Applying it would silently roll the mirror back.
function isStale(lastEventAt: string | null | undefined, occurredAt: string): boolean {
  if (!lastEventAt) return false;
  return new Date(occurredAt).getTime() < new Date(lastEventAt).getTime();
}

async function upsertSubscription(event: SubscriptionEvent): Promise<void> {
  const sub = event.data;

  const existing = await billingSubscriptionsRepo.findById(sub.id);
  if (existing && isStale(existing.last_event_at, event.occurredAt)) {
    console.log(`[BILLING] stale ${event.eventType} for ${sub.id} (occurred ${event.occurredAt}, ` +
                `row at ${existing.last_event_at}) — ignored`);
    return;
  }

  const tenantId = tenantIdFrom(sub.customData);

  // The customer row is the FK parent. On an out-of-order delivery it may not
  // exist yet, so write a stub keyed on the id; customer.created fills in the
  // email when it arrives. Without this the insert below fails the foreign key
  // and the event retries until the customer event happens to land first.
  await billingCustomersRepo.upsert({
    customer_id: sub.customerId,
    tenant_id:   tenantId,
  });

  const firstItem = sub.items[0];

  await billingSubscriptionsRepo.upsert({
    subscription_id:         sub.id,
    customer_id:             sub.customerId,
    tenant_id:               tenantId,
    status:                  sub.status,
    price_id:                firstItem?.price?.id ?? '',
    product_id:              firstItem?.price?.productId ?? '',
    // Hybrid plans (base + addons) have several items; price_id/product_id
    // above only describe the first. Keep the whole array so the account screen
    // can render every line.
    items: sub.items.map(i => ({
      price_id:   i.price?.id ?? null,
      product_id: i.price?.productId ?? null,
      quantity:   i.quantity,
      status:     i.status,
      recurring:  i.recurring,
    })),
    collection_mode:         sub.collectionMode ?? null,
    currency_code:           sub.currencyCode ?? null,
    // Present = a cancel or pause is pending. Recorded for display only; see
    // subscriptionGrantsAccess — it must never gate access.
    scheduled_change_action: sub.scheduledChange?.action ?? null,
    scheduled_change_at:     sub.scheduledChange?.effectiveAt ?? null,
    current_period_ends_at:  sub.currentBillingPeriod?.endsAt ?? null,
    canceled_at:             sub.canceledAt ?? null,
    last_event_at:           event.occurredAt,
  });

  console.log(`[BILLING] ${event.eventType} ${sub.id} → status=${sub.status}` +
              (sub.scheduledChange ? ` scheduled=${sub.scheduledChange.action}@${sub.scheduledChange.effectiveAt}` : ''));
}

async function upsertCustomer(event: CustomerCreatedEvent | CustomerUpdatedEvent): Promise<void> {
  const customer = event.data;

  await billingCustomersRepo.upsert({
    customer_id: customer.id,
    email:       customer.email,
    status:      customer.status ?? null,
    // Only set the tenant link when this event carries one — otherwise leave
    // whatever a previous event established. stripUndefined in the repo makes
    // "undefined" mean "don't touch this column".
    tenant_id:   tenantIdFrom(customer.customData),
  });

  console.log(`[BILLING] ${event.eventType} ${customer.id} (${customer.email})`);
}

async function recordTransaction(event: TransactionCompletedEvent): Promise<void> {
  const txn = event.data;

  // Same FK reasoning as subscriptions: the parent customer may not be mirrored
  // yet. customerId is nullable on a transaction, so only stub when present.
  if (txn.customerId) {
    await billingCustomersRepo.upsert({
      customer_id: txn.customerId,
      tenant_id:   tenantIdFrom(txn.customData),
    });
  }

  await billingTransactionsRepo.upsert({
    transaction_id:  txn.id,
    customer_id:     txn.customerId ?? null,
    subscription_id: txn.subscriptionId ?? null,
    tenant_id:       tenantIdFrom(txn.customData) ?? null,
    status:          txn.status,
    currency_code:   txn.currencyCode ?? null,
    // Kept as the string Paddle sent, in the lowest denomination. Parsing it
    // into a number here is how rounding errors get into revenue reporting.
    total:           txn.details?.totals?.total ?? null,
    tax:             txn.details?.totals?.tax ?? null,
    billed_at:       txn.billedAt ?? null,
    invoice_number:  txn.invoiceNumber ?? null,
  });

  console.log(`[BILLING] transaction.completed ${txn.id} ` +
              `${txn.details?.totals?.total ?? '?'} ${txn.currencyCode ?? ''} sub=${txn.subscriptionId ?? 'none'}`);
}
