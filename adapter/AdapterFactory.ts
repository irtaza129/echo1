import type { TenantConfig, AdapterCredentials } from '../src/lib/tenantConfig.js';
import type { IRestaurantAdapter } from './IRestaurantAdapter.js';
import { ManagedBackendAdapter } from './ManagedBackendAdapter.js';
import { CustomApiAdapter }      from './CustomApiAdapter.js';

const DEFAULT_BACKEND_URL = process.env.BACKEND_URL ?? 'https://voiceai-hzyb.onrender.com';

export class AdapterFactory {
  static create(
    config: TenantConfig,
    credentials: AdapterCredentials,
  ): IRestaurantAdapter {
    switch (config.adapter.type) {
      case 'managed':
        return new ManagedBackendAdapter(config, DEFAULT_BACKEND_URL);

      case 'custom_api':
        return new CustomApiAdapter(config, credentials);

      case 'webhook':
        // Phase 6 — WebhookAdapter (push events to tenant URL)
        throw new Error(`[ADAPTER] webhook adapter not yet implemented for tenant ${config.slug}`);
    }
  }
}
