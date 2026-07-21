// ─────────────────────────────────────────────────────────────────────────────
// Payment provider contract.
//
// Mirrors the adapter/IRestaurantAdapter.ts pattern: one interface, many
// implementations (Safepay, Cash, …future Paymob / bank IPG), selected per
// tenant by PaymentProviderFactory. Routes in server.ts call ONLY these methods.
//
// All amounts are integer **paisa** (see payments/money.ts). Currency is PKR for
// the Pakistan market but kept as a field so the contract stays general.
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentProviderId = 'cash' | 'safepay';

// Lifecycle of a single payment attempt. Distinct from the kitchen order status
// machine — money state ≠ preparation state.
export type PaymentStatus =
  | 'initiated'   // checkout created, awaiting customer action
  | 'authorized'  // funds held, not yet captured
  | 'captured'    // money taken — order can proceed
  | 'failed'      // declined / errored
  | 'cancelled'   // customer abandoned
  | 'refunded';

export type PaymentMethod = 'cash' | 'card' | 'wallet' | 'raast' | 'tap_to_pay';

export interface CheckoutParams {
  orderId:      string;
  amountPaisa:  number;
  currency:     string;        // 'PKR'
  customerName?:  string;
  customerPhone?: string;
  /** Where the gateway returns the customer after they pay (kiosk success page). */
  redirectUrl?: string;
  /** Where the gateway returns the customer if they cancel. */
  cancelUrl?:   string;
}

export interface CheckoutResult {
  /** Gateway's own reference (tracker / intent id) — the key we reconcile on. */
  providerRef: string;
  status:      PaymentStatus;
  /** Hosted-checkout URL to send the customer to (for redirect-based flows). */
  redirectUrl?: string;
  /** Client token for embedded/drop-in flows, if the provider returns one. */
  clientToken?: string;
}

export interface WebhookVerifyResult {
  signatureValid: boolean;
  providerRef:    string;
  status:         PaymentStatus;
  /** Raw event name from the gateway, for logging. */
  event?:         string;
  /** Amount the gateway reports captured, if present (paisa). */
  amountPaisa?:   number;
}

export interface PaymentStatusResult {
  providerRef: string;
  status:      PaymentStatus;
  amountPaisa?: number;
}

export interface IPaymentProvider {
  readonly id: PaymentProviderId;

  /** Create a checkout / payment intent. Returns the redirect URL or token. */
  createCheckout(params: CheckoutParams): Promise<CheckoutResult>;

  /** Verify an inbound webhook's signature and extract its outcome. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookVerifyResult;

  /** Poll the gateway for the current status — reconciliation fallback. */
  getStatus(providerRef: string): Promise<PaymentStatusResult>;

  /** Refund a captured payment (full or partial). */
  refund(providerRef: string, amountPaisa: number): Promise<PaymentStatusResult>;
}

// ── Persistence shape (Redis today; Postgres ledger is the durable target) ─────
// One row per payment attempt. PAN / card data is NEVER stored here — only the
// gateway's reference and outcome.
export interface PaymentTransaction {
  providerRef:  string;
  provider:     PaymentProviderId;
  tenantId:     string;
  orderId:      string;
  amountPaisa:  number;
  currency:     string;
  status:       PaymentStatus;
  method:       PaymentMethod;
  createdAt:    string;  // ISO-8601
  updatedAt:    string;  // ISO-8601
}
