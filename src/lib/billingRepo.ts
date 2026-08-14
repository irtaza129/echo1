import * as db from './supabaseAdmin.js';

// Repository layer for the Paddle mirror (migrations/008_billing_paddle.sql).
// Same shape and rules as repo.ts: thin wrappers over PostgREST, snake_case
// rows in, typed rows out, no business logic in server.ts.
//
// Unlike the platform repos, these writes are NOT best-effort. A failed write
// here means the webhook handler must return non-2xx so Paddle redelivers —
// swallowing the error would silently lose the only copy of that state change.
// Callers therefore let exceptions propagate.

// ── row types ────────────────────────────────────────────────────────────────

export interface BillingCustomerRow {
  customer_id: string;
  tenant_id:   string | null;
  email:       string | null;
  status:      string | null;
  created_at:  string;
  updated_at:  string;
}

export interface BillingSubscriptionRow {
  subscription_id:         string;
  customer_id:             string;
  tenant_id:               string | null;
  status:                  string;
  price_id:                string;
  product_id:              string;
  items:                   unknown[];
  collection_mode:         string | null;
  currency_code:           string | null;
  scheduled_change_action: string | null;
  scheduled_change_at:     string | null;
  current_period_ends_at:  string | null;
  canceled_at:             string | null;
  last_event_at:           string | null;
  created_at:              string;
  updated_at:              string;
}

export interface BillingTransactionRow {
  transaction_id:  string;
  customer_id:     string | null;
  subscription_id: string | null;
  tenant_id:       string | null;
  status:          string;
  currency_code:   string | null;
  total:           string | null;
  tax:             string | null;
  billed_at:       string | null;
  invoice_number:  string | null;
}

// ── access gating ────────────────────────────────────────────────────────────

// The statuses that entitle a tenant to paid features.
//
// `trialing` is included: a 7-day trial is a paid plan that has not billed yet,
// and locking trial users out of the product defeats the trial.
//
// `past_due` is included as a GRACE period. The most recent payment failed and
// Paddle Retain is retrying; cutting service off on the first failed charge
// churns customers over an expired card. Show a banner, keep the lights on.
// Move it to REVOKING_STATUSES if the business wants a hard cutoff instead.
export const ACCESS_GRANTING_STATUSES = ['active', 'trialing', 'past_due'] as const;

// `paused` means billing stopped by agreement — no charge, no service.
// `canceled` is terminal: the subscription has actually ended.
export const REVOKING_STATUSES = ['paused', 'canceled'] as const;

export interface AccessDecision {
  granted:   boolean;
  status:    string | null;
  /** True while access is granted only by the past_due grace window. */
  inGrace:   boolean;
  /** A pending cancel/pause the UI should warn about. Never affects `granted`. */
  scheduled: { action: string; effectiveAt: string | null } | null;
  reason:    string;
}

// Does this subscription currently entitle the tenant to paid features?
//
// The critical rule: a scheduled change is NOT a revocation. When a customer
// cancels mid-period, Paddle keeps status `active` and sets scheduled_change;
// they have paid through the end of the period and keep access until Paddle
// flips the status itself. Reading scheduled_change as "cancelled" would cut
// off a customer who is still paid up — and would do it the instant they click
// cancel, which is the worst possible moment to break the product.
export function subscriptionGrantsAccess(sub: BillingSubscriptionRow | null): AccessDecision {
  if (!sub) {
    return { granted: false, status: null, inGrace: false, scheduled: null, reason: 'no subscription' };
  }

  const scheduled = sub.scheduled_change_action
    ? { action: sub.scheduled_change_action, effectiveAt: sub.scheduled_change_at }
    : null;

  const status  = sub.status;
  const granted = (ACCESS_GRANTING_STATUSES as readonly string[]).includes(status);
  const inGrace = status === 'past_due';

  let reason: string;
  if (granted && inGrace)      reason = 'payment failed — access retained during dunning grace period';
  else if (granted && scheduled) reason = `access retained until scheduled ${scheduled.action}`;
  else if (granted)            reason = `status ${status}`;
  else if (status === 'canceled') reason = 'subscription ended';
  else if (status === 'paused')   reason = 'subscription paused';
  else                         reason = `unrecognised status ${status} — denied by default`;

  return { granted, status, inGrace, scheduled, reason };
}

// ── billing_customers ────────────────────────────────────────────────────────

export const billingCustomersRepo = {
  // Upsert keyed on the Paddle customer id, which makes redelivery a no-op.
  // Undefined fields are stripped so a stub row written by the subscription
  // handler is never overwritten with nulls by a later partial update.
  async upsert(c: {
    customer_id: string;
    tenant_id?:  string | null;
    email?:      string | null;
    status?:     string | null;
  }): Promise<void> {
    await db.upsert('billing_customers', stripUndefined({
      customer_id: c.customer_id,
      tenant_id:   c.tenant_id,
      email:       c.email,
      status:      c.status,
      updated_at:  new Date().toISOString(),
    }), 'customer_id');
  },

  findById(customerId: string): Promise<BillingCustomerRow | null> {
    return db.selectOne<BillingCustomerRow>('billing_customers', { customer_id: `eq.${customerId}` });
  },

  findByTenant(tenantId: string): Promise<BillingCustomerRow | null> {
    return db.selectOne<BillingCustomerRow>('billing_customers', {
      tenant_id: `eq.${tenantId}`,
      order:     'created_at.desc',
    });
  },

  // Email is the fallback bridge for customers created by a checkout that did
  // not carry a tenant_id in custom_data. Matched case-insensitively because
  // Paddle preserves whatever case the customer typed.
  findByEmail(email: string): Promise<BillingCustomerRow | null> {
    return db.selectOne<BillingCustomerRow>('billing_customers', {
      email: `ilike.${email}`,
    });
  },
};

// ── billing_subscriptions ────────────────────────────────────────────────────

export const billingSubscriptionsRepo = {
  async upsert(s: {
    subscription_id:          string;
    customer_id:              string;
    tenant_id?:               string | null;
    status:                   string;
    price_id?:                string;
    product_id?:              string;
    items?:                   unknown[];
    collection_mode?:         string | null;
    currency_code?:           string | null;
    scheduled_change_action?: string | null;
    scheduled_change_at?:     string | null;
    current_period_ends_at?:  string | null;
    canceled_at?:             string | null;
    last_event_at?:           string | null;
  }): Promise<void> {
    await db.upsert('billing_subscriptions', stripUndefined({
      ...s,
      updated_at: new Date().toISOString(),
    }), 'subscription_id');
  },

  findById(subscriptionId: string): Promise<BillingSubscriptionRow | null> {
    return db.selectOne<BillingSubscriptionRow>('billing_subscriptions', {
      subscription_id: `eq.${subscriptionId}`,
    });
  },

  listByCustomer(customerId: string): Promise<BillingSubscriptionRow[]> {
    return db.selectMany<BillingSubscriptionRow>('billing_subscriptions', {
      customer_id: `eq.${customerId}`,
      order:       'created_at.desc',
    });
  },

  listByTenant(tenantId: string): Promise<BillingSubscriptionRow[]> {
    return db.selectMany<BillingSubscriptionRow>('billing_subscriptions', {
      tenant_id: `eq.${tenantId}`,
      order:     'created_at.desc',
    });
  },
};

// ── billing_transactions ─────────────────────────────────────────────────────

export const billingTransactionsRepo = {
  async upsert(t: BillingTransactionRow): Promise<void> {
    await db.upsert('billing_transactions', stripUndefined({
      ...t,
      updated_at: new Date().toISOString(),
    }), 'transaction_id');
  },
};

// ── billing_webhook_events (idempotency ledger) ──────────────────────────────

export const billingEventsRepo = {
  async seen(eventId: string): Promise<boolean> {
    const row = await db.selectOne<{ event_id: string }>('billing_webhook_events', {
      event_id: `eq.${eventId}`,
    });
    return row !== null;
  },

  async record(e: { event_id: string; event_type: string; occurred_at?: string | null }): Promise<void> {
    await db.upsert('billing_webhook_events', stripUndefined({
      event_id:    e.event_id,
      event_type:  e.event_type,
      occurred_at: e.occurred_at,
    }), 'event_id');
  },
};

// PostgREST writes an explicit null for any key present in the body, so an
// undefined field has to be removed rather than sent. Without this, a
// customer.updated carrying no tenant_id would blank the tenant link.
function stripUndefined<T extends object>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).filter(([, v]) => v !== undefined),
  ) as T;
}
