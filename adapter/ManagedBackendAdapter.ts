import axios, { type AxiosInstance } from 'axios';
import type { TenantConfig } from '../src/lib/tenantConfig.js';
import type {
  IRestaurantAdapter,
  ResolveItemParams,
  ResolveItemResult,
  SubmitOrderParams,
  OrderResult,
  OrderFilter,
} from './IRestaurantAdapter.js';

// Calls our own Render backend, scoped by X-Tenant-ID header.
// This is the default adapter for all clients who let us manage their backend.
export class ManagedBackendAdapter implements IRestaurantAdapter {
  private readonly client: AxiosInstance;
  private readonly tenantId: string;

  constructor(config: TenantConfig, backendUrl: string) {
    this.tenantId = config.tenantId;
    this.client   = axios.create({
      baseURL: backendUrl,
      timeout: 15_000,
      headers: { 'X-Tenant-ID': config.tenantId },
    });
  }

  // ── Menu ───────────────────────────────────────────────────────────────────

  async getMenuContext(): Promise<string> {
    const res = await this.client.get<string>('/api/v1/agent/menu-context');
    // Backend returns plain text markdown
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  }

  async getMenuForUI(): Promise<unknown> {
    const res = await this.client.get('/api/v1/menu');
    return res.data;
  }

  // ── Cart ───────────────────────────────────────────────────────────────────

  async resolveItem(params: ResolveItemParams): Promise<ResolveItemResult> {
    const res = await this.client.post<ResolveItemResult>('/api/v1/agent/resolve-item', {
      session_id:  params.sessionId,
      dish_query:  params.dishQuery,
      modifiers:   params.modifiers ?? [],
      quantity:    params.quantity  ?? 1,
      notes:       params.notes     ?? null,
    });
    return res.data;
  }

  async removeItem(sessionId: string, cartItemId: string): Promise<void> {
    await this.client.post('/api/v1/agent/remove-item', {
      session_id:   sessionId,
      cart_item_id: cartItemId,
    });
  }

  async clearCart(sessionId: string): Promise<void> {
    await this.client.post('/api/v1/agent/clear-cart', { session_id: sessionId });
  }

  async getCart(sessionId: string): Promise<unknown> {
    const res = await this.client.get(`/api/v1/agent/cart/${sessionId}`);
    return res.data;
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  async submitOrder(params: SubmitOrderParams): Promise<OrderResult> {
    const res = await this.client.post<OrderResult>('/api/v1/agent/submit-order', {
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
    return res.data;
  }

  async getOrders(filter?: OrderFilter): Promise<unknown> {
    const params: Record<string, string> = {};
    if (filter?.status)  params.status   = filter.status;
    if (filter?.perPage) params.per_page = String(filter.perPage);
    const res = await this.client.get('/api/v1/orders', { params });
    return res.data;
  }

  async updateOrderStatus(orderId: string, status: string): Promise<unknown> {
    const res = await this.client.patch(`/api/v1/orders/${orderId}/status`, { status });
    return res.data;
  }
}
