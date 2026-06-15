import type {
  IPaymentProvider, CheckoutParams, CheckoutResult,
  WebhookVerifyResult, PaymentStatusResult,
} from './IPaymentProvider.js';

// ─────────────────────────────────────────────────────────────────────────────
// Cash / pay-at-counter — the default. Preserves today's behaviour: an order is
// "captured" the moment it's placed because money changes hands in person. No
// gateway calls, no webhooks. Keeping it behind the IPaymentProvider interface
// means submit-order can treat every tenant uniformly.
// ─────────────────────────────────────────────────────────────────────────────

export class CashProvider implements IPaymentProvider {
  readonly id = 'cash' as const;

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    // Nothing to collect online — settle immediately at the counter.
    return { providerRef: `cash-${params.orderId}`, status: 'captured' };
  }

  verifyWebhook(): WebhookVerifyResult {
    // Cash never sends webhooks; treat as invalid so a stray call can't flip state.
    return { signatureValid: false, providerRef: '', status: 'failed' };
  }

  async getStatus(providerRef: string): Promise<PaymentStatusResult> {
    return { providerRef, status: 'captured' };
  }

  async refund(providerRef: string, amountPaisa: number): Promise<PaymentStatusResult> {
    // Cash refunds are handled at the counter; record the intent only.
    return { providerRef, status: 'refunded', amountPaisa };
  }
}
