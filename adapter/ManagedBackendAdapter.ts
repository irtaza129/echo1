import crypto from 'crypto';
import axios, { type AxiosInstance } from 'axios';
import type { TenantConfig } from '../src/lib/tenantConfig.js';
import {
  ordersRepo,
  type OrderItemRow, type NewOrderItem,
} from '../src/lib/posRepo.js';
import { publish } from '../src/lib/posEvents.js';
import { backendHeaders } from '../src/lib/backendAuth.js';
import {
  sessionCartKey, readCart, appendCartItem, removeCartItem,
  clearCart as clearSessionCart, snapshotCart, toWireCartItems,
  type SessionCartItem,
} from '../src/lib/sessionCart.js';
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
// and the MATCHING of "a large pulao with two sides" against it, which is its
// matcher's job. The basket that matching fills does not stay — see the cart
// section. The upstream held it in process memory, so a restart returned an
// empty cart rather than an error, mid-call.
export class ManagedBackendAdapter implements IRestaurantAdapter {
  private readonly client: AxiosInstance;
  private readonly tenantId: string;
  private readonly config: TenantConfig;

  constructor(config: TenantConfig, backendUrl: string) {
    this.tenantId = config.tenantId;
    this.config   = config;
    this.client   = axios.create({ baseURL: backendUrl, timeout: 15_000 });
    // Per request rather than fixed at construction: the header set depends on
    // whether BACKEND_JWT_SECRET is configured, and an adapter built before it
    // was set would otherwise keep calling unauthenticated for its lifetime.
    // `kiosk` is the least privilege that reaches the agent and menu routes.
    this.client.interceptors.request.use(req => {
      Object.assign(req.headers, backendHeaders(this.tenantId, 'kiosk'));
      return req;
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
  //
  // The upstream matches the item; this app holds the basket. Matching is the
  // upstream's job — its fuzzy matcher sits on the menu hierarchy it owns — but
  // the basket does not need to live there too, and it was the last piece of
  // this channel's state that this app could not see.
  //
  // Why it moved: the upstream's cart is a module-level dict, so resolve-item
  // and the cart read had to land on the same process. A restart or a second
  // instance returned an empty basket rather than an error, mid-call, with the
  // customer waiting. Redis here is the same store PosAdapter has always used —
  // one cart implementation for the product, not two.
  //
  // The upstream's cart endpoints — remove-item, clear-cart and GET cart — are
  // now 404. Nothing here calls them, and the fallbacks that briefly read them
  // during the changeover are gone: an upstream 404 must never be how an empty
  // cart looks, and getCart is what the diner's phone renders from.
  //
  // The gate is still `dish_name`. A resolve-item response carrying one is
  // enough to build a local line; one without is a response we cannot name a
  // receipt from, and the line is dropped rather than guessed. That is not
  // changeover scaffolding — it is the check that a matcher which stops naming
  // its matches fails loudly here instead of printing "undefined" on a ticket.

  private cartKey(sessionId: string): string {
    return sessionCartKey(this.tenantId, sessionId);
  }

  /**
   * The local line for a resolved item, or null when the response does not say
   * enough to build one.
   *
   * The one thing this must never do is default the name: a guessed dish name
   * reaches a receipt and a kitchen ticket, and the customer finds out at the
   * counter. So a nameless 'ok' response yields no line.
   *
   * That is a real loss, not a no-op — the model has already told the customer
   * the item was added — which is why the caller logs it at error. There is no
   * good silent handling of "the matcher said yes but would not say to what";
   * the only options are a wrong receipt or a visible short cart, and a short
   * cart is the one the customer can correct.
   */
  private static toCartItem(
    res:    ResolveItemResult,
    params: ResolveItemParams,
  ): SessionCartItem | null {
    if (res.status !== 'ok' || !res.dish_name) return null;

    // The upstream's quantity, not the one we asked for: it is the side that
    // resolved the line, and if it ever clamps or splits one its answer is the
    // one that was priced.
    const asked = res.quantity ?? params.quantity;
    const qty   = asked && asked > 0 ? asked : 1;
    return {
      // The upstream's id, not a fresh one: it is what the model was told, and
      // what a later remove_item will name.
      cart_item_id: res.cart_item_id ?? crypto.randomUUID(),
      dish_id:      res.dish_id ?? null,
      name:         res.dish_name,
      category:     null,
      summary:      res.summary ?? `${res.dish_name} \u00d7 ${qty}`,
      quantity:     qty,
      unit_price:   Number(res.unit_price ?? 0),
      // Ids alone cannot be printed, so a line resolved without names carries no
      // modifiers rather than a row of numbers.
      modifiers:    (res.selected_options ?? [])
                      .filter((o): o is { choice_name: string; option_name?: string } =>
                        typeof o.choice_name === 'string')
                      .map(o => ({ option_name: o.option_name, choice_name: o.choice_name })),
      notes:        params.notes ?? null,
    };
  }

  async resolveItem(params: ResolveItemParams): Promise<ResolveItemResult> {
    const res = await this.client.post<ResolveItemResult>('/api/v1/agent/resolve-item', {
      session_id:  params.sessionId,
      dish_query:  params.dishQuery,
      modifiers:   params.modifiers ?? [],
      quantity:    params.quantity  ?? 1,
      notes:       params.notes     ?? null,
    });

    const item = ManagedBackendAdapter.toCartItem(res.data, params);
    if (item) {
      await appendCartItem(this.cartKey(params.sessionId), item);
    } else if (res.data.status === 'ok') {
      // Loud on purpose: the customer has been told this was added and it was
      // not. Silence here is a short order nobody notices until the counter.
      console.error(
        `[MANAGED] resolve-item returned ok with no dish_name for "${params.dishQuery}" ` +
        `(tenant ${this.tenantId}, session ${params.sessionId}) — line dropped, not guessed`);
    }

    // Returned unchanged either way: App.tsx and the voice tools consume this
    // shape directly, and holding the cart here changes nothing they see.
    return res.data;
  }

  async removeItem(sessionId: string, cartItemId: string): Promise<void> {
    await removeCartItem(this.cartKey(sessionId), cartItemId);
  }

  async clearCart(sessionId: string): Promise<void> {
    await clearSessionCart(this.cartKey(sessionId));
  }

  async getCart(sessionId: string): Promise<WireCartItem[]> {
    return toWireCartItems(await readCart(this.cartKey(sessionId)));
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  /**
   * Write the finished order to OUR ledger, from OUR cart.
   *
   * Both halves of that moved, and for the same reason. The order is written
   * here because this app owns `orders` — so it gets a real order_number, the
   * right `source`, and both tables in one transaction, none of which the
   * upstream path did. The cart is read here because a basket held in another
   * service's process memory came back empty after a restart, and an empty
   * basket priced as an order is the failure this whole boundary exists to stop.
   *
   * Two sources, and the order matters: the local cart, snapshotted under its
   * lock so an add_item still in flight lands before the read; then the inline
   * cart on the request, so a Redis outage costs line detail rather than the
   * sale. Exactly as PosAdapter does it, because it is now the same cart.
   *
   * An empty result is a refusal, never a zero-line order. That guard is why a
   * lost basket makes the customer re-order instead of paying for nothing.
   */
  async submitOrder(params: SubmitOrderParams): Promise<OrderResult> {
    let items: NewOrderItem[] = (await snapshotCart(this.cartKey(params.sessionId)))
      .map(i => ({
        dishId:          i.dish_id,
        dishName:        i.name,
        quantity:        i.quantity,
        unitPrice:       i.unit_price,
        selectedOptions: i.modifiers,
        notes:           i.notes,
      }));

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

    // Best-effort, and deliberately after the sale is committed: a cart that
    // failed to clear is a stale basket, not a lost order, and returning non-2xx
    // here would invite the caller to submit twice.
    this.clearCart(params.sessionId).catch(err =>
      console.warn(`[MANAGED] cart not cleared for ${params.sessionId}:`,
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
