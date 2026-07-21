import axios, { type AxiosInstance } from 'axios';
import crypto from 'crypto';
import type { AdapterCredentials } from '../src/lib/tenantConfig.js';
import type {
  IPaymentProvider, CheckoutParams, CheckoutResult,
  WebhookVerifyResult, PaymentStatusResult, PaymentStatus,
} from './IPaymentProvider.js';
import { paisaToGatewayAmount } from './money.js';

// ─────────────────────────────────────────────────────────────────────────────
// Safepay (https://getsafepay.pk) — Pakistan-native card / wallet / 3DS gateway.
//
// Flow implemented (hosted checkout):
//   1. createCheckout → POST {apiBase}/order/v1/init → tracker token
//      → build a hosted checkout redirect URL the customer completes 3DS on.
//   2. Safepay POSTs a signed webhook to /api/payments/safepay/webhook on the
//      payment outcome → verifyWebhook() validates the HMAC and extracts status.
//   3. getStatus() polls the tracker as a reconciliation fallback for missed
//      webhooks (cold start, network blip).
//
// Cardholder data NEVER touches this process — the customer enters card + 3DS on
// Safepay's PCI-scoped page. We only ever hold the tracker token and outcome,
// keeping us in SAQ-A scope.
//
// Credentials (from the encrypted store; see AdapterCredentials):
//   paymentApiKey       — Safepay API key ("client")            [required]
//   paymentWebhookSecret— shared secret used to sign webhooks    [required for verify]
//   paymentApiBase      — override API base (sandbox vs prod)    [optional]
//   paymentCheckoutBase — override hosted-checkout base          [optional]
//   paymentEnvironment  — 'sandbox' | 'production'               [optional]
// ─────────────────────────────────────────────────────────────────────────────

const SANDBOX_API_BASE      = 'https://sandbox.api.getsafepay.com';
const SANDBOX_CHECKOUT_BASE = 'https://sandbox.api.getsafepay.com';
const PROD_API_BASE         = 'https://api.getsafepay.com';
const PROD_CHECKOUT_BASE    = 'https://getsafepay.com';

export class SafepayProvider implements IPaymentProvider {
  readonly id = 'safepay' as const;

  private readonly client:        AxiosInstance;
  private readonly apiKey:        string;
  private readonly webhookSecret: string;
  private readonly checkoutBase:  string;
  private readonly environment:   string;

  constructor(credentials: AdapterCredentials) {
    this.apiKey        = credentials.paymentApiKey ?? '';
    this.webhookSecret = credentials.paymentWebhookSecret ?? '';
    this.environment   = credentials.paymentEnvironment ?? 'sandbox';

    const isProd  = this.environment === 'production';
    const apiBase = credentials.paymentApiBase ?? (isProd ? PROD_API_BASE : SANDBOX_API_BASE);
    this.checkoutBase = credentials.paymentCheckoutBase ?? (isProd ? PROD_CHECKOUT_BASE : SANDBOX_CHECKOUT_BASE);

    if (!this.apiKey) throw new Error('[SAFEPAY] paymentApiKey is not configured for this tenant');

    this.client = axios.create({ baseURL: apiBase, timeout: 15_000 });
  }

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    const amount = paisaToGatewayAmount(params.amountPaisa);
    // Create a payment tracker. Safepay returns a token we attach to the
    // hosted-checkout URL.
    const res = await this.client.post('/order/v1/init', {
      client:      this.apiKey,
      amount,
      currency:    params.currency,
      environment: this.environment,
    });

    const token = extractToken(res.data);
    if (!token) throw new Error('[SAFEPAY] init response did not contain a tracker token');

    const url = new URL(`${this.checkoutBase.replace(/\/$/, '')}/checkout/pay`);
    url.searchParams.set('beacon', token);
    url.searchParams.set('env', this.environment);
    url.searchParams.set('source', 'custom');
    url.searchParams.set('order_id', params.orderId);
    if (params.redirectUrl) url.searchParams.set('redirect_url', params.redirectUrl);
    if (params.cancelUrl)   url.searchParams.set('cancel_url', params.cancelUrl);

    return { providerRef: token, status: 'initiated', redirectUrl: url.toString() };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerifyResult {
    const provided = headerValue(headers, 'x-sfpy-signature') ?? headerValue(headers, 'x-sfpy-signature-v2');

    // HMAC-SHA256 of the exact raw bytes, hex-encoded, compared in constant time.
    let signatureValid = false;
    if (this.webhookSecret && provided) {
      const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
      signatureValid = timingSafeEqualHex(expected, provided);
    }

    // Parse the payload defensively — Safepay nests the tracker + state under
    // `data`, and the event type varies across API versions.
    let parsed: unknown = {};
    try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { /* leave as {} */ }
    const body  = (parsed ?? {}) as Record<string, unknown>;
    const data  = (body.data ?? {}) as Record<string, unknown>;
    const event = typeof body.type === 'string' ? body.type : undefined;

    const providerRef = String(
      data.tracker ?? data.token ?? data.reference ?? body.tracker ?? body.token ?? '',
    );
    const stateStr = String(data.state ?? data.status ?? body.state ?? body.status ?? '');

    return {
      signatureValid,
      providerRef,
      status: mapState(stateStr, event),
      event,
    };
  }

  async getStatus(providerRef: string): Promise<PaymentStatusResult> {
    const res = await this.client.get(`/order/v1/${encodeURIComponent(providerRef)}`);
    const data    = (res.data as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    const stateStr = String(data?.state ?? data?.status ?? '');
    return { providerRef, status: mapState(stateStr) };
  }

  async refund(providerRef: string, amountPaisa: number): Promise<PaymentStatusResult> {
    await this.client.post(`/order/v1/${encodeURIComponent(providerRef)}/refund`, {
      client: this.apiKey,
      amount: paisaToGatewayAmount(amountPaisa),
    });
    return { providerRef, status: 'refunded', amountPaisa };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function extractToken(data: unknown): string | undefined {
  const d = data as Record<string, unknown> | undefined;
  const inner = (d?.data ?? d) as Record<string, unknown> | undefined;
  const token = inner?.token ?? inner?.tracker ?? d?.token;
  return typeof token === 'string' && token ? token : undefined;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

// Constant-time compare of two hex strings; never throws on length mismatch.
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Map a gateway state/event string to our internal PaymentStatus.
function mapState(state: string, event?: string): PaymentStatus {
  const s = `${state} ${event ?? ''}`.toUpperCase();
  if (s.includes('PAID') || s.includes('CAPTURE') || s.includes('SUCCESS') || s.includes('COMPLETE')) return 'captured';
  if (s.includes('AUTHORIZ')) return 'authorized';
  if (s.includes('REFUND'))   return 'refunded';
  if (s.includes('CANCEL'))   return 'cancelled';
  if (s.includes('FAIL') || s.includes('DECLINE') || s.includes('ERROR')) return 'failed';
  return 'initiated';
}
