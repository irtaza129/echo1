// ─────────────────────────────────────────────────────────────────────────────
// SaaS plan tiers — the plans TENANTS buy from US.
//
// Do not confuse this with the diner-facing card payments in
// paddleOrderPayment.ts: that is a restaurant's customer paying the restaurant.
// This is a restaurant paying us. They are different Paddle transactions with
// different custom_data, and they only share a notification destination.
//
// Marketing copy lives here; PRICES DO NOT. Price ids are fetched from Paddle at
// runtime by GET /api/billing/plans, for the same reason the client token is
// served rather than bundled: sandbox and live are separate accounts with
// different pri_ ids, so a hardcoded id silently breaks the moment PADDLE_ENV
// flips. Selling a new tier means adding it in the Paddle dashboard and adding
// copy here — never editing an id.
//
// Pure, import-free — safe in the browser wizard.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tier ids, matched to Paddle product names case-insensitively (Paddle
 * "Starter" → 'starter'). `growth` and `enterprise` are legacy ids that
 * predate the Paddle catalog; they remain valid in stored configs and in the
 * TenantConfig enum so existing tenants keep parsing, but they are not sold.
 */
export type PlanId = 'starter' | 'pro' | 'advanced';

export interface PlanCopy {
  id:       PlanId;
  name:     string;
  desc:     string;
  features: readonly string[];
}

export const PLAN_COPY: readonly PlanCopy[] = [
  {
    id:   'starter',
    name: 'Starter',
    desc: 'For a single-location restaurant getting started with voice ordering.',
    features: ['1 kiosk URL', 'Managed backend', 'Basic AI persona', 'Email support'],
  },
  {
    id:   'pro',
    name: 'Pro',
    desc: 'For growing restaurants that need custom branding and multi-language support.',
    features: ['3 kiosk URLs', 'Custom API adapter', 'All AI persona options', 'Transcript screen', 'Priority support'],
  },
  {
    id:   'advanced',
    name: 'Advanced',
    desc: 'Full platform access for chains, franchises, and enterprise deployments.',
    features: ['Unlimited kiosks', 'Webhook adapter', 'White-label branding', 'Dedicated support', 'SLA guarantee'],
  },
] as const;

/** One purchasable price — a tier/interval pair, resolved from Paddle. */
export interface PlanPrice {
  priceId:  string;
  /** Lowest denomination, verbatim from Paddle ("1000" = $10.00). Never a float. */
  amount:   string;
  currency: string;
}

export interface PlanOffer {
  id:      PlanId;
  name:    string;
  monthly?: PlanPrice;
  annual?:  PlanPrice;
}

export type BillingInterval = 'month' | 'year';

/**
 * Format a Paddle amount for display.
 *
 * Paddle sends the LOWEST denomination for every currency, but for JPY/KRW/CLP
 * the lowest denomination IS the major unit — dividing those by 100 shows a
 * price 100× too small. Kept in sync with ZERO_DECIMAL_CURRENCIES in
 * payments/paddleCurrency.ts, duplicated rather than imported so this module
 * stays import-free for the browser.
 */
export function formatPlanPrice(amount: string, currency: string): string {
  const zeroDecimal = ['JPY', 'KRW', 'CLP'].includes(currency.toUpperCase());
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${currency} ${amount}`;
  const major = zeroDecimal ? n : n / 100;
  return `${currency} ${major.toLocaleString(undefined, {
    minimumFractionDigits: zeroDecimal ? 0 : 2,
    maximumFractionDigits: zeroDecimal ? 0 : 2,
  })}`;
}
