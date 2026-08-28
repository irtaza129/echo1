import axios, { type AxiosInstance } from 'axios';
import type { TenantConfig } from '../src/lib/tenantConfig.js';
import {
  ordersRepo,
  type OrderItemRow, type NewOrderItem,
} from '../src/lib/posRepo.js';
import { publish } from '../src/lib/posEvents.js';
import { toWireOrder } from './PosAdapter.js';
import type {
  IRestaurantAdapter,
  ResolveItemParams,
  ResolveItemResult,
  SubmitOrderParams,
  OrderResult,
  OrderFilter,
  WireOrder,
  WireCartItem,
} from './IRestaurantAdapter.js';
import { unwrapCollection } from './IRestaurantAdapter.js';

// Menu and cart from our own Render/FastAPI backend, scoped by X-Tenant-ID.
// Orders from our own Postgres, like every other adapter.
//
// This used to POST orders to the upstream's /api/v1/agent/submit-order, which
// made it the one adapter that did not write to the order ledger. That is what
// non-negotiable #1 in CLAUDE.md rules out — "one order ledger, every channel
// submits through req.adapter.submitOrder" — and it was not true for `managed`
// tenants, whose orders were written by a different service entirely.
//
// The cost of that split, before this change:
//
//   * Two services wrote `orders` with independently maintained column lists,
//     which drifted to 36 columns against the 29 either side believed in.
//   * The upstream never wrote `orders.source`, so every voice order took the
//     column's default and reported as 'kiosk'. Channel attribution — the whole
//     reason `source` exists — was wrong for those tenants.
//   * It never wrote `order_number` either, leaving it null on 58 of 61 rows
//     while an allocator (pos_next_order_number) sat there uncalled.
//   * Order creation upstream was a hand-rolled two-phase commit over HTTP:
//     insert the order, verify the items, delete the order if they failed.
//     ordersRepo.create does both tables in one transaction.
//
// What stays upstream is what the upstream actually owns: the menu hierarchy,
// and the cart, because resolving "a large pulao with two sides" against that
// menu is its matcher's job. Only the write of the finished order moves.
export class ManagedBackendAdapter implements IRestaurantAdapter {
  private readonly client: AxiosInstance;
  private readonly tenantId: string;
  private readonly config: TenantConfig;

  constructor(config: TenantConfig, backendUrl: string) {
    this.tenantId = config.tenantId;
    this.config   = config;
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

  async getCart(sessionId: string): Promise<WireCartItem[]> {
    const res = await this.client.get(`/api/v1/agent/cart/${sessionId}`);
    return unwrapCollection<WireCartItem>(res.data, 'getCart');
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  /**
   * Write the finished order to OUR ledger, from the cart the upstream holds.
   *
   * The cart is read upstream because that is where it lives and where the
   * matcher that built it lives. The order is written here because this app owns
   * `orders` — so it gets a real order_number, the right `source`, and both
   * tables in one transaction, none of which the upstream path did.
   *
   * The upstream cart is cleared only after the write succeeds. Clearing first
   * would lose the basket if the write failed, and the customer would have to
   * order again from nothing.
   */
  async submitOrder(params: SubmitOrderParams): Promise<OrderResult> {
    // Prefer the upstream cart; fall back to an inline cart from the request so
    // an upstream blip degrades detail rather than losing the sale, exactly as
    // PosAdapter falls back when Redis is unavailable.
    let items: NewOrderItem[];
    try {
      const cart = await this.getCart(params.sessionId);
      items = cart.map(i => ({
        // dish_id is threaded through when the upstream returns one: it is what
        // kitchen station routing joins on, and both services read the same
        // `dishes` table, so its ids are valid here.
        dishId:    i.dish_id ?? null,
        dishName:  i.dish_name,
        quantity:  i.quantity,
        unitPrice: Number(i.unit_price),
        notes:     i.notes ?? null,
      }));
    } catch (err) {
      console.warn(`[MANAGED] could not read upstream cart for ${params.sessionId}:`,
        (err as Error).message);
      items = [];
    }

    if (items.length === 0) {
      items = (params.cartItems ?? []).map(i => ({
        dishId:    i.dishId ?? null,
        dishName:  i.dishName,
        quantity:  i.quantity,
        unitPrice: i.unitPrice,
        notes:     i.notes ?? null,
      }));
    }

    if (items.length === 0) return { error: 'Cart is empty' };

    const { order, totals } = await ordersRepo.create({
      tenantId:          this.tenantId,
      items,
      gstRate:           this.config.businessRules.gstRate,
      serviceChargeRate: this.config.businessRules.pos.serviceChargeRate,
      discount:          params.discount,
      deliveryFee:       params.deliveryFee,
      customerName:      params.customerName,
      customerPhone:     params.customerPhone,
      orderType:         params.orderType,
      paymentMethod:     params.paymentMethod,
      instructions:      params.instructions,
      notes:             params.notes,
      tableId:           params.tableId,
      source:            params.source ?? 'kiosk',
    });

    // Best-effort, and deliberately after the sale is committed: a cart the
    // upstream failed to clear is a stale basket, not a lost order, and
    // returning non-2xx here would invite the caller to submit twice.
    this.clearCart(params.sessionId).catch(err =>
      console.warn(`[MANAGED] upstream cart not cleared for ${params.sessionId}:`,
        (err as Error).message));

    publish(this.tenantId, 'order.created', {
      orderId:     order.id,
      orderNumber: order.order_number,
      tableId:     order.table_id,
      orderType:   order.order_type,
      total:       totals.total,
      source:      params.source ?? 'kiosk',
    });

    return {
      order_id:     order.id,
      order_number: order.order_number ?? undefined,
      total:        totals.total,
      summary:      `Order #${order.order_number}`,
    };
  }

  // Orders are read from the same place they are now written. Reading them
  // upstream while writing them here would show the till an order book that
  // never contains the orders it just took.
  async getOrders(filter?: OrderFilter): Promise<WireOrder[]> {
    const orders = await ordersRepo.list(this.tenantId, {
      status: filter?.status,
      limit:  filter?.perPage ?? 100,
    });
    if (orders.length === 0) return [];

    const items   = await Promise.all(orders.map(o => ordersRepo.items(o.id)));
    const byOrder = new Map<string, OrderItemRow[]>();
    orders.forEach((o, idx) => byOrder.set(o.id, items[idx]));

    return orders.map(o => toWireOrder(o, byOrder.get(o.id) ?? []));
  }

  async updateOrderStatus(orderId: string, status: string): Promise<unknown> {
    const updated = await ordersRepo.setStatus(this.tenantId, orderId, status);
    if (!updated) throw new Error(`[MANAGED] order ${orderId} not found`);
    publish(this.tenantId, 'order.status', {
      orderId, orderNumber: updated.order_number, status,
    });
    return updated;
  }
}
