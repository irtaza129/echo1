import axios, { type AxiosInstance } from 'axios';
import type { TenantConfig, AdapterCredentials, EndpointMapping } from '../src/lib/tenantConfig.js';
import type {
  IRestaurantAdapter,
  ResolveItemParams,
  ResolveItemResult,
  SubmitOrderParams,
  OrderResult,
  OrderFilter,
} from './IRestaurantAdapter.js';

// Default paths — these mirror what our managed Render backend exposes.
// Tenants whose own API matches this shape need zero configuration.
const DEFAULTS: Record<string, { method: string; path: string }> = {
  getMenuContext:  { method: 'GET',   path: '/api/v1/agent/menu-context' },
  getMenuForUI:   { method: 'GET',   path: '/api/v1/menu' },
  resolveItem:    { method: 'POST',  path: '/api/v1/agent/resolve-item' },
  removeItem:     { method: 'POST',  path: '/api/v1/agent/remove-item' },
  clearCart:      { method: 'POST',  path: '/api/v1/agent/clear-cart' },
  getCart:        { method: 'GET',   path: '/api/v1/agent/cart' },
  submitOrder:    { method: 'POST',  path: '/api/v1/agent/submit-order' },
  getOrders:      { method: 'GET',   path: '/api/v1/orders' },
  updateOrderStatus: { method: 'PATCH', path: '/api/v1/orders' },
};

// Resolves a simple dot-notation path within an object: "data.items.0.name"
function getPath(obj: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

// Applies fieldMappings to remap their response shape to our shape.
// Only remaps keys listed in the mapping; unlisted keys are kept as-is.
function applyFieldMappings(raw: unknown, mappings?: Record<string, string>): unknown {
  if (!mappings || Object.keys(mappings).length === 0 || typeof raw !== 'object' || raw === null) return raw;
  const result: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [ourField, theirPath] of Object.entries(mappings)) {
    result[ourField] = getPath(raw, theirPath);
  }
  return result;
}

// Generic HTTP client driven by TenantConfig.adapter.endpointMappings.
// Credentials (baseUrl, apiKey) are loaded from the encrypted credential store —
// never stored in TenantConfig so they never appear in audit logs or config exports.
export class CustomApiAdapter implements IRestaurantAdapter {
  private readonly client: AxiosInstance;
  private readonly mappings: EndpointMapping[];

  constructor(config: TenantConfig, credentials: AdapterCredentials) {
    const baseUrl = credentials.baseUrl ?? '';
    if (!baseUrl) throw new Error(`[ADAPTER] custom_api tenant ${config.slug} has no baseUrl in credentials`);

    const headers: Record<string, string> = { 'X-Tenant-ID': config.tenantId };
    if (credentials.apiKey)    headers['Authorization'] = `Bearer ${credentials.apiKey}`;
    if (credentials.apiSecret) headers['X-Api-Secret']  = credentials.apiSecret;

    this.client   = axios.create({ baseURL: baseUrl, timeout: 15_000, headers });
    this.mappings = config.adapter.endpointMappings ?? [];
  }

  // Find the configured path for an operation, or fall back to default.
  private resolve(op: string): { path: string; fieldMappings?: Record<string, string> } {
    const m = this.mappings.find(x => x.operation === op);
    return {
      path:          m?.path ?? DEFAULTS[op]?.path ?? `/${op}`,
      fieldMappings: m?.fieldMappings,
    };
  }

  // ── Menu ─────────────────────────────────────────────────────────────────────

  async getMenuContext(): Promise<string> {
    const { path } = this.resolve('getMenuContext');
    const res = await this.client.get<string>(path);
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  }

  async getMenuForUI(): Promise<unknown> {
    const { path } = this.resolve('getMenuForUI');
    const res = await this.client.get(path);
    return res.data;
  }

  // ── Cart ─────────────────────────────────────────────────────────────────────

  async resolveItem(params: ResolveItemParams): Promise<ResolveItemResult> {
    const { path, fieldMappings } = this.resolve('resolveItem');
    const res = await this.client.post(path, {
      session_id:  params.sessionId,
      dish_query:  params.dishQuery,
      modifiers:   params.modifiers ?? [],
      quantity:    params.quantity  ?? 1,
      notes:       params.notes     ?? null,
    });
    return applyFieldMappings(res.data, fieldMappings) as ResolveItemResult;
  }

  async removeItem(sessionId: string, cartItemId: string): Promise<void> {
    const { path } = this.resolve('removeItem');
    await this.client.post(path, { session_id: sessionId, cart_item_id: cartItemId });
  }

  async clearCart(sessionId: string): Promise<void> {
    const { path } = this.resolve('clearCart');
    await this.client.post(path, { session_id: sessionId });
  }

  async getCart(sessionId: string): Promise<unknown> {
    const { path } = this.resolve('getCart');
    const res = await this.client.get(`${path}/${sessionId}`);
    return res.data;
  }

  // ── Orders ───────────────────────────────────────────────────────────────────

  async submitOrder(params: SubmitOrderParams): Promise<OrderResult> {
    const { path, fieldMappings } = this.resolve('submitOrder');
    const res = await this.client.post(path, {
      session_id:     params.sessionId,
      customer_name:  params.customerName  ?? null,
      customer_phone: params.customerPhone ?? null,
      order_type:     params.orderType     ?? 'dine_in',
      payment_method: params.paymentMethod ?? 'cash',
      delivery_fee:   params.deliveryFee   ?? 0,
      discount:       params.discount      ?? 0,
      instructions:   params.instructions  ?? null,
      notes:          params.notes         ?? null,
    });
    return applyFieldMappings(res.data, fieldMappings) as OrderResult;
  }

  async getOrders(filter?: OrderFilter): Promise<unknown> {
    const { path } = this.resolve('getOrders');
    const params: Record<string, string> = {};
    if (filter?.status)  params.status   = filter.status;
    if (filter?.perPage) params.per_page = String(filter.perPage);
    const res = await this.client.get(path, { params });
    return res.data;
  }

  async updateOrderStatus(orderId: string, status: string): Promise<unknown> {
    const { path } = this.resolve('updateOrderStatus');
    const res = await this.client.patch(`${path}/${orderId}/status`, { status });
    return res.data;
  }
}
