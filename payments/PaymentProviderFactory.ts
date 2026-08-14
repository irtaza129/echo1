import type { TenantConfig, AdapterCredentials } from '../src/lib/tenantConfig.js';
import type { IPaymentProvider, PaymentProviderId } from './IPaymentProvider.js';
import { SafepayProvider } from './SafepayProvider.js';
import { CashProvider }    from './CashProvider.js';
import { PaddleProvider }  from './PaddleProvider.js';

// ─────────────────────────────────────────────────────────────────────────────
// Selects the payment provider for a tenant. Mirrors adapter/AdapterFactory.ts.
//
// Provider id lives in TenantConfig.payments.provider (non-secret); keys live in
// the encrypted AdapterCredentials. A tenant with no payments block falls back to
// cash, so existing tenants behave exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

export class PaymentProviderFactory {
  static create(config: TenantConfig, credentials: AdapterCredentials): IPaymentProvider {
    return PaymentProviderFactory.createById(config.payments?.provider ?? 'cash', credentials);
  }

  // Build a provider directly from its id — used by the webhook handler, which
  // resolves the provider from the stored transaction (it has no TenantConfig).
  static createById(provider: PaymentProviderId, credentials: AdapterCredentials): IPaymentProvider {
    switch (provider) {
      case 'safepay':
        return new SafepayProvider(credentials);
      // Paddle takes no per-tenant credentials: it is a single platform-level
      // merchant-of-record account keyed by the server's PADDLE_API_KEY, unlike
      // Safepay where each tenant brings their own merchant keys.
      case 'paddle':
        return new PaddleProvider();
      case 'cash':
      default:
        return new CashProvider();
    }
  }

  /** True when the tenant collects money online (i.e. not plain cash). */
  static isOnline(config: TenantConfig): boolean {
    return (config.payments?.provider ?? 'cash') !== 'cash';
  }
}
