import crypto from 'crypto';
import type { TenantConfig } from '../src/lib/tenantConfig.js';
import { getRedis, redisKey, TTL } from '../src/lib/redis.js';
import {
  fetchPosMenu, ordersRepo,
  type PosMenu, type OrderRow, type OrderItemRow, type NewOrderItem,
} from '../src/lib/posRepo.js';
import { fuzzyMatchItem, matchModifiers, buildMenuMarkdown } from './posMatching.js';
import { withCartLock } from '../src/lib/cartLock.js';
import { publish } from '../src/lib/posEvents.js';
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

// The native point-of-sale adapter: menu, cart and orders served from this
// app's own Postgres, with no upstream at all.
//
// This replaces the `if (await getLocalMenu(tenantId)) { …40 lines… }` branch
// that was copy-pasted through six routes in server.ts. Those routes now call
// req.adapter unconditionally; which implementation they get is decided once,
// in AdapterFactory, from config.adapter.type.
//
// Storage split, and why:
//   • Orders  → Postgres. Permanent. The Redis path this replaces expired sales
//     after 30 days (TTL.LOCAL_ORDER) and kept only the last 500 per tenant.
//   • Cart    → Redis. Genuinely ephemeral: it exists between "add item" and
//     "pay", and a TTL is the correct way to clean up an abandoned kiosk
//     session. Nothing is lost if it evaporates.

export interface PosCartItem {
  cart_item_id: string;
  dish_id:      number;
  name:         string;
  category:     string;
  summary:      string;
  quantity:     number;
  unit_price:   number;
  modifiers:    { option_name: string; choice_name: string }[];
  notes:        string | null;
}

// Menu reads happen on every kiosk connect and every POS boot; four Postgres
// queries each time would be wasteful and slow. Cached under a key distinct
// from the admin panel's `menu:data:<id>` so neither can poison the other —
// the same separation getSupabaseMenu() already relies on in server.ts.
const MENU_CACHE_TTL = 5 * 60;
const menuCacheKey = (tenantId: string) => `menu:pos:${tenantId}`;

export class PosAdapter implements IRestaurantAdapter {
  private readonly tenantId: string;

  constructor(private readonly config: TenantConfig) {
    this.tenantId = config.tenantId;
  }

  // ── Menu ───────────────────────────────────────────────────────────────────

  private async menu(): Promise<PosMenu> {
    try {
      const cached = await getRedis().get<PosMenu>(menuCacheKey(this.tenantId));
      if (cached) return cached;
    } catch { /* Redis down — read through to Postgres */ }

    const fresh = await fetchPosMenu(this.tenantId);

    try {
      await getRedis().set(menuCacheKey(this.tenantId), fresh, { ex: MENU_CACHE_TTL });
    } catch { /* non-fatal */ }

    return fresh;
  }

  // Invalidate after a menu edit in the admin panel.
  static async invalidateMenu(tenantId: string): Promise<void> {
    try {
      await getRedis().del(menuCacheKey(tenantId), redisKey.menuContext(tenantId));
    } catch { /* non-fatal — the 5 min TTL will catch up */ }
  }

  async getMenuContext(): Promise<string> {
    return buildMenuMarkdown(await this.menu(), this.config);
  }

  async getMenuForUI(): Promise<unknown> {
    const menu = await this.menu();
    const cur  = this.config.businessRules.currencySymbol;

    return [...menu.categories]
      .sort((a, b) => b.priority - a.priority)
      .map(cat => ({
        id:    `cat:${cat.id}`,
        name:  cat.name,
        items: menu.dishes
          .filter(d => d.categoryId === cat.id)
          .map(d => ({
            id:             `dish:${d.id}`,
            dish_id:        d.id,
            name:           d.name,
            description:    d.description,
            price:          d.price,
            available:      d.available,
            category:       cat.name,
            currencySymbol: cur,
            // The POS ModifierSheet renders straight from this; the voice kiosk
            // ignores it. Sending it always keeps one menu endpoint for both.
            optionGroups:   d.optionGroups,
          })),
      }));
  }

  // ── Cart ───────────────────────────────────────────────────────────────────

  private cartKey(sessionId: string): string {
    return redisKey.localCart(this.tenantId, sessionId);
  }

  private async readCart(sessionId: string): Promise<PosCartItem[]> {
    try {
      return (await getRedis().get<PosCartItem[]>(this.cartKey(sessionId))) ?? [];
    } catch {
      return [];
    }
  }

  private async writeCart(sessionId: string, items: PosCartItem[]): Promise<void> {
    try {
      await getRedis().set(this.cartKey(sessionId), items, { ex: TTL.LOCAL_CART });
    } catch {
      // Non-fatal: the kiosk keeps its own copy in React state and submitOrder
      // accepts an inline cart, so a Redis blip cannot block a sale.
    }
  }

  async resolveItem(params: ResolveItemParams): Promise<ResolveItemResult> {
    const menu  = await this.menu();
    const match = fuzzyMatchItem(params.dishQuery, menu.dishes);

    if (!match) {
      return {
        status:         'requires_input',
        ai_instruction: `I couldn't find '${params.dishQuery}' on the menu. Could you clarify what you'd like?`,
      };
    }

    const spoken = (params.modifiers ?? []).filter(Boolean);
    const { choices, missingGroup } = matchModifiers(match, spoken);

    // A required option group with no answer must stop here. Adding the item
    // anyway is how a kiosk sells a pizza with no size — the backend would
    // then have to guess, and the customer finds out at the counter.
    if (missingGroup) {
      const options = missingGroup.choices.map(c => c.name).join(', ');
      return {
        status:         'requires_input',
        ai_instruction:
          `${match.name} needs a ${missingGroup.name.toLowerCase()} choice. ` +
          `Ask the customer to pick one of: ${options}. ` +
          `Then call add_item again for '${match.name}' with their answer included in modifiers.`,
      };
    }

    const qty       = params.quantity && params.quantity > 0 ? params.quantity : 1;
    const unitPrice = match.price + choices.reduce((s, c) => s + c.price, 0);
    const modLabels = choices.map(c => c.choiceName);
    const summary   = modLabels.length > 0
      ? `${match.name} × ${qty} (${modLabels.join(', ')})`
      : `${match.name} × ${qty}`;

    const item: PosCartItem = {
      cart_item_id: crypto.randomUUID(),
      dish_id:      match.id,
      name:         match.name,
      category:     match.categoryName,
      summary,
      quantity:     qty,
      unit_price:   unitPrice,
      modifiers:    choices.map(c => ({ option_name: c.groupName, choice_name: c.choiceName })),
      notes:        params.notes ?? null,
    };

    // Read-modify-write under the lock. A model that emits two add_item calls in
    // one turn would otherwise have both read the same pre-state, and the second
    // write would drop the first item.
    await withCartLock(this.cartKey(params.sessionId), async () => {
      await this.writeCart(params.sessionId, [...await this.readCart(params.sessionId), item]);
    });

    return {
      status:           'ok',
      summary,
      unit_price:       unitPrice,
      cart_item_id:     item.cart_item_id,
      dish_id:          match.id,
      // Same {option_id, sub_option_id} shape ManagedBackendAdapter returns —
      // the two adapters are interchangeable on the wire.
      selected_options: choices.map(c => ({ option_id: c.groupId, sub_option_id: c.choiceId })),
    };
  }

  async removeItem(sessionId: string, cartItemId: string): Promise<void> {
    await withCartLock(this.cartKey(sessionId), async () => {
      const cart = await this.readCart(sessionId);
      await this.writeCart(sessionId, cart.filter(i => i.cart_item_id !== cartItemId));
    });
  }

  async clearCart(sessionId: string): Promise<void> {
    try {
      await getRedis().del(this.cartKey(sessionId));
    } catch { /* non-fatal */ }
  }

  async getCart(sessionId: string): Promise<WireCartItem[]> {
    return (await this.readCart(sessionId)).map(i => ({
      cart_item_id: i.cart_item_id,
      dish_name:    i.name,
      quantity:     i.quantity,
      unit_price:   i.unit_price,
      summary:      i.summary,
      notes:        i.notes,
    }));
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  async submitOrder(params: SubmitOrderParams): Promise<OrderResult> {
    // Prefer the Redis cart (full detail: dish_id, modifiers, category). Fall
    // back to an inline cart from the request body so a Redis outage degrades
    // the receipt's detail rather than losing the sale outright.
    //
    // Snapshot under the lock: an add_item still in flight must land before we
    // read, or the customer is charged for an order missing its last item.
    const stored = await withCartLock(this.cartKey(params.sessionId),
      () => this.readCart(params.sessionId));
    const items: NewOrderItem[] = stored.length > 0
      ? stored.map(i => ({
          dishId:          i.dish_id,
          dishName:        i.name,
          quantity:        i.quantity,
          unitPrice:       i.unit_price,
          selectedOptions: i.modifiers,
          notes:           i.notes,
        }))
      : (params.cartItems ?? []);

    if (items.length === 0) {
      return { error: 'Cart is empty' };
    }

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
      // Defaults to 'kiosk' because that is the caller that predates the field;
      // every other channel passes its own.
      source:            params.source ?? 'kiosk',
    });

    await this.clearCart(params.sessionId);

    // Kiosk, phone, WhatsApp and QR orders all arrive through this method, so
    // this is the one place that makes them appear on the POS floor and the
    // kitchen board without each channel having to remember to announce itself.
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

  async getOrders(filter?: OrderFilter): Promise<WireOrder[]> {
    const orders = await ordersRepo.list(this.tenantId, {
      status: filter?.status,
      limit:  filter?.perPage ?? 100,
    });
    if (orders.length === 0) return [];

    // One query for all lines rather than N — a busy board polls this every
    // 60 s and would otherwise issue a hundred round trips per poll.
    const items = await Promise.all(orders.map(o => ordersRepo.items(o.id)));
    const byOrder = new Map<string, OrderItemRow[]>();
    orders.forEach((o, idx) => byOrder.set(o.id, items[idx]));

    return orders.map(o => toWireOrder(o, byOrder.get(o.id) ?? []));
  }

  async updateOrderStatus(orderId: string, status: string): Promise<unknown> {
    const updated = await ordersRepo.setStatus(this.tenantId, orderId, status);
    if (!updated) throw new Error(`[POS] order ${orderId} not found`);
    publish(this.tenantId, 'order.status', {
      orderId, orderNumber: updated.order_number, status,
    });
    return updated;
  }
}

// ── Postgres row → canonical wire shape ──────────────────────────────────────
// The dashboard and the Render backend agree on total_amount / dish_name /
// item_total. Returning the storage shape directly is what once rendered every
// local order as "Rs 0" with blank item names — see src/lib/types.ts.
export function toWireOrder(o: OrderRow, items: OrderItemRow[]): WireOrder {
  const n = (v: unknown) => {
    const x = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
    return Number.isFinite(x) ? x : 0;
  };

  return {
    id:             o.id,
    order_number:   o.order_number ?? undefined,
    customer_name:  o.customer_name  ?? 'Guest',
    customer_phone: o.customer_phone ?? '',
    order_type:     o.order_type,
    status:         o.status,
    total_amount:   n(o.total_amount),
    subtotal:       n(o.subtotal),
    notes:          o.notes,
    created_at:     o.created_at,
    items: items
      // A voided line must not appear on the kitchen ticket, but it stays in
      // the database for the Z-report.
      .filter(i => i.voided_at === null)
      .map(i => ({
        dish_name:        i.dish_name,
        quantity:         i.quantity,
        unit_price:       n(i.unit_price),
        item_total:       n(i.item_total),
        notes:            i.notes,
        selected_options: i.selected_options ?? [],
      })),
  };
}
