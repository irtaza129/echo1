import axios, { type AxiosInstance } from 'axios';
import type { TenantConfig, AdapterCredentials } from '../src/lib/tenantConfig.js';
import type {
  IRestaurantAdapter,
  ResolveItemParams,
  ResolveItemResult,
  SubmitOrderParams,
  OrderResult,
  OrderFilter,
} from './IRestaurantAdapter.js';

// Sends order events to the tenant's configured webhook URL via HTTP POST.
//
// Cart operations are intentionally stub-only here: webhook tenants should
// configure a local menu via Admin Dashboard → Menu so server.ts uses the
// Redis cart path instead. These stubs are only reached when no local menu
// is present (e.g. on first setup).
//
// Credential fields (from encrypted store):
//   baseUrl     — optional: if set, getMenuContext/getMenuForUI try fetching from it
//   webhookUrl  — where order events are POSTed (falls back to baseUrl if absent)
//   apiKey      — added as Authorization: Bearer header
//   apiSecret   — added as X-Api-Secret header

export class WebhookAdapter implements IRestaurantAdapter {
  private readonly config:     TenantConfig;
  private readonly webhookUrl: string;
  private readonly baseUrl:    string;
  private readonly client:     AxiosInstance;

  constructor(config: TenantConfig, credentials: AdapterCredentials) {
    this.config      = config;
    this.webhookUrl  = credentials.webhookUrl ?? credentials.baseUrl ?? '';
    this.baseUrl     = credentials.baseUrl    ?? '';

    const headers: Record<string, string> = { 'X-Tenant-ID': config.tenantId };
    if (credentials.apiKey)    headers['Authorization'] = `Bearer ${credentials.apiKey}`;
    if (credentials.apiSecret) headers['X-Api-Secret']  = credentials.apiSecret;

    this.client = axios.create({ timeout: 12_000, headers });
  }

  // ── Menu ──────────────────────────────────────────────────────────────────

  async getMenuContext(): Promise<string> {
    if (this.baseUrl) {
      try {
        const r = await this.client.get(`${this.baseUrl.replace(/\/$/, '')}/api/v1/agent/menu-context`);
        if (typeof r.data === 'string' && r.data.trim()) return r.data;
      } catch { /* fall through to placeholder */ }
    }
    return `# ${this.config.restaurantName} Menu\n\n` +
      `(Add menu items via Admin Dashboard → Menu to enable voice ordering)`;
  }

  async getMenuForUI(): Promise<unknown> {
    if (this.baseUrl) {
      try {
        const r = await this.client.get(`${this.baseUrl.replace(/\/$/, '')}/api/v1/menu`);
        const d = r.data as Record<string, unknown>;
        if (Array.isArray(r.data) || Array.isArray(d?.categories)) return r.data;
      } catch { /* fall through */ }
    }
    return [];
  }

  // ── Cart stubs ────────────────────────────────────────────────────────────

  async resolveItem(p: ResolveItemParams): Promise<ResolveItemResult> {
    const mods    = (p.modifiers ?? []).filter(Boolean);
    const summary = mods.length
      ? `${p.dishQuery} × ${p.quantity ?? 1} (${mods.join(', ')})`
      : `${p.dishQuery} × ${p.quantity ?? 1}`;
    return {
      status:       'ok',
      summary,
      unit_price:   0,
      cart_item_id: `wh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    };
  }

  async removeItem(_sessionId: string, _cartItemId: string): Promise<void> { /* no-op */ }
  async clearCart(_sessionId: string):                        Promise<void> { /* no-op */ }
  async getCart(_sessionId: string):                         Promise<unknown> { return []; }

  // ── Orders ────────────────────────────────────────────────────────────────

  async submitOrder(p: SubmitOrderParams): Promise<OrderResult> {
    if (!this.webhookUrl) {
      throw new Error(
        `[WEBHOOK] No webhook URL configured for tenant "${this.config.slug}". ` +
        `Set it via Admin Dashboard → Connection → Backend URL.`
      );
    }
    const r    = await this.client.post(this.webhookUrl, {
      event:     'order.submitted',
      timestamp: new Date().toISOString(),
      tenantId:  this.config.tenantId,
      ...p,
    });
    const data = ((r.data ?? {}) as Record<string, unknown>);
    return {
      id:           data.id           as number | undefined,
      order_id:     String(data.order_id ?? data.id ?? `wh-${Date.now()}`),
      order_number: data.order_number as string | number | undefined,
      total:        Number(data.total ?? 0),
      summary:      String(data.summary ?? 'Order submitted to webhook'),
    };
  }

  async getOrders(_filter?: OrderFilter): Promise<unknown> { return []; }

  async updateOrderStatus(orderId: string, status: string): Promise<unknown> {
    if (!this.webhookUrl) return { id: orderId, status };
    try {
      await this.client.post(this.webhookUrl, {
        event:     'order.status_updated',
        orderId,
        status,
        timestamp: new Date().toISOString(),
        tenantId:  this.config.tenantId,
      });
    } catch (err) {
      console.warn(`[WEBHOOK] status POST failed for order ${orderId}:`, (err as Error).message);
    }
    return { id: orderId, status };
  }
}
