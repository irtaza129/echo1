import type { TenantConfig } from '../src/lib/tenantConfig.js';
import type { AdapterCredentials } from '../src/lib/tenantConfig.js';
import type { IRestaurantAdapter } from './IRestaurantAdapter.js';
import { ManagedBackendAdapter } from './ManagedBackendAdapter.js';

const DEFAULT_BACKEND_URL = process.env.BACKEND_URL ?? 'https://voiceai-hzyb.onrender.com';

export class AdapterFactory {
  static create(
    config: TenantConfig,
    _credentials: AdapterCredentials,
  ): IRestaurantAdapter {
    switch (config.adapter.type) {
      case 'managed':
        return new ManagedBackendAdapter(config, DEFAULT_BACKEND_URL);

      case 'custom_api':
        // Phase 5 — CustomApiAdapter implementation
        throw new Error(`[ADAPTER] custom_api adapter not yet implemented for tenant ${config.slug}`);

      case 'webhook':
        // Phase 5 — WebhookAdapter implementation
        throw new Error(`[ADAPTER] webhook adapter not yet implemented for tenant ${config.slug}`);
    }
  }
}
