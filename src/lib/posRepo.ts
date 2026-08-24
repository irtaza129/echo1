import * as db from './supabaseAdmin.js';

// Repository layer for the point-of-sale. Kept separate from repo.ts, which
// owns *platform* state (tenants, configs, credentials, users, audit) and whose
// writes go through dualWrite() because Redis is still primary there.
//
// The rule is inverted here: Postgres IS primary for the POS. Nothing in this
// file swallows an error. A failed payment insert must reach the caller as a
// rejection so the route can return 5xx — a POS that silently loses a sale is
// worse than one that visibly refuses it.
//
// Schema note: `categories`, `dishes`, `dish_options`, `dish_sub_options`,
// `orders` and `order_items` are SHARED with the FastAPI/Render backend and
// predate this module (see migrations/004). We adopt them rather than building
// a parallel menu/order model, which is why the ids here are integers for menu
// entities and uuids for orders — that split is theirs, not ours.

// PostgREST returns `numeric` columns as JSON numbers, but the existing wire
// types already tolerate `string | number` because the Render backend sends
// strings. Coerce at the boundary so arithmetic downstream is never string
// concatenation — the bug that renders a total as "1010" instead of 20.
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

// ── Menu (shared tables, read-mostly) ────────────────────────────────────────

interface CategoryRow    { id: number; tenant_id: string; name: string; status: number; priority: number }
interface DishRow        { id: number; tenant_id: string; category_id: number; name: string;
                           description: string | null; price: unknown; base_price: unknown;
                           status: number; availability: number }
interface DishOptionRow  { id: number; tenant_id: string; dish_id: number; name: string;
                           required: number; multiselect: number;
                           min_select: number | null; max_select: number | null; priority: number }
interface DishSubOptRow  { id: number; tenant_id: string; option_id: number; dish_id: number;
                           name: string; price: unknown; priority: number }

export interface PosOptionChoice { id: number; name: string; price: number }

export interface PosOptionGroup {
  id:          number;
  name:        string;
  required:    boolean;
  multiselect: boolean;
  minSelect:   number;
  maxSelect:   number;
  choices:     PosOptionChoice[];
}

export interface PosDish {
  id:           number;
  categoryId:   number;
  categoryName: string;
  name:         string;
  description:  string;
  price:        number;
  available:    boolean;
  optionGroups: PosOptionGroup[];
}

export interface PosMenu {
  categories: { id: number; name: string; priority: number }[];
  dishes:     PosDish[];
}

// One assembled menu for a tenant, modifiers included.
//
// Four queries rather than a nested PostgREST embed: the embed syntax for a
// two-level nest (dishes → options → sub_options) with tenant filters at each
// level is fragile, and four flat reads are trivially cacheable. Callers should
// cache the result — see getPosMenuCached in server.ts.
export async function fetchPosMenu(tenantId: string): Promise<PosMenu> {
  const [cats, dishes, options, subOptions] = await Promise.all([
    db.selectMany<CategoryRow>('categories', {
      tenant_id: `eq.${tenantId}`, status: 'eq.1', order: 'priority.desc',
    }),
    db.selectMany<DishRow>('dishes', {
      tenant_id: `eq.${tenantId}`, status: 'eq.1', availability: 'eq.1', order: 'name.asc',
    }),
    db.selectMany<DishOptionRow>('dish_options', {
      tenant_id: `eq.${tenantId}`, order: 'priority.asc',
    }),
    db.selectMany<DishSubOptRow>('dish_sub_options', {
      tenant_id: `eq.${tenantId}`, order: 'priority.asc',
    }),
  ]);

  const catById     = new Map(cats.map(c => [c.id, c]));
  const choicesByOpt = new Map<number, PosOptionChoice[]>();
  for (const s of subOptions) {
    const list = choicesByOpt.get(s.option_id) ?? [];
    list.push({ id: s.id, name: s.name, price: num(s.price) });
    choicesByOpt.set(s.option_id, list);
  }

  const groupsByDish = new Map<number, PosOptionGroup[]>();
  for (const o of options) {
    const list = groupsByDish.get(o.dish_id) ?? [];
    list.push({
      id:          o.id,
      name:        o.name,
      required:    o.required === 1,
      multiselect: o.multiselect === 1,
      minSelect:   o.min_select ?? (o.required === 1 ? 1 : 0),
      maxSelect:   o.max_select ?? (o.multiselect === 1 ? 99 : 1),
      choices:     choicesByOpt.get(o.id) ?? [],
    });
    groupsByDish.set(o.dish_id, list);
  }

  return {
    categories: cats.map(c => ({ id: c.id, name: c.name, priority: c.priority })),
    dishes: dishes.map(d => ({
      id:           d.id,
      categoryId:   d.category_id,
      categoryName: catById.get(d.category_id)?.name ?? '',
      name:         d.name,
      description:  d.description ?? '',
      // `price` is the sell price; `base_price` is the pre-modifier cost the
      // FastAPI backend keeps. Prefer price, fall back to base_price.
      price:        num(d.price) || num(d.base_price),
      available:    d.availability === 1 && d.status === 1,
      optionGroups: groupsByDish.get(d.id) ?? [],
    })),
  };
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface OrderRow {
  id:             string;
  tenant_id:      string;
  order_number:   number | null;
  customer_name:  string | null;
  customer_phone: string | null;
  order_type:     string;
  status:         string;
  payment_method: string | null;
  payment_status: string | null;
  subtotal:       unknown;
  discount:       unknown;
  delivery_fee:   unknown;
  tax_total:      unknown;
  service_charge: unknown;
  total_amount:   unknown;
  table_id:       string | null;
  shift_id:       string | null;
  staff_id:       string | null;
  customer_id:    string | null;
  source:         string;
  notes:          string | null;
  instructions:   string | null;
  opened_at:      string | null;
  closed_at:      string | null;
  voided_at:      string | null;
  void_reason:    string | null;
  created_at:     string;
  updated_at:     string;
}

export interface OrderItemRow {
  id:               string;
  tenant_id:        string;
  order_id:         string;
  dish_id:          number | null;
  dish_name:        string;
  quantity:         number;
  unit_price:       unknown;
  item_total:       unknown;
  line_discount:    unknown;
  selected_options: { option_name?: string; choice_name: string }[] | null;
  notes:            string | null;
  seat_no:          number | null;
  course:           string | null;
  voided_at:        string | null;
  void_reason:      string | null;
}

export interface NewOrderItem {
  dishId?:         number | null;
  dishName:        string;
  quantity:        number;
  unitPrice:       number;
  lineDiscount?:   number;
  selectedOptions?: { option_name?: string; choice_name: string }[];
  notes?:          string | null;
  seatNo?:         number | null;
  course?:         string | null;
}

export interface NewOrder {
  tenantId:       string;
  items:          NewOrderItem[];
  gstRate:        number;
  serviceChargeRate?: number;
  discount?:      number;
  deliveryFee?:   number;
  customerName?:  string;
  customerPhone?: string;
  customerId?:    string | null;
  orderType?:     string;
  paymentMethod?: string;
  tableId?:       string | null;
  shiftId?:       string | null;
  staffId?:       string | null;
  source?:        string;
  notes?:         string | null;
  instructions?:  string | null;
  status?:        string;
}

export interface OrderTotals {
  subtotal:      number;
  discount:      number;
  serviceCharge: number;
  tax:           number;
  total:         number;
}

// Money maths lives here, server-side, and is the only version that counts.
// The kiosk and POS both compute a preview for display; if they disagree with
// this, they are wrong. Rounding to 2dp at each step (rather than once at the
// end) is deliberate — it matches what the receipt shows line by line, so the
// printed lines always sum to the printed total.
export function computeTotals(
  items: NewOrderItem[],
  gstRate: number,
  opts: { discount?: number; deliveryFee?: number; serviceChargeRate?: number } = {},
): OrderTotals {
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const subtotal = r2(items.reduce(
    (s, i) => s + (i.unitPrice * i.quantity - (i.lineDiscount ?? 0)), 0,
  ));
  const discount      = r2(opts.discount ?? 0);
  const net           = Math.max(0, subtotal - discount);
  const serviceCharge = r2(net * (opts.serviceChargeRate ?? 0));
  const tax           = r2((net + serviceCharge) * gstRate);
  const total         = r2(net + serviceCharge + tax + (opts.deliveryFee ?? 0));

  return { subtotal, discount, serviceCharge, tax, total };
}

export const ordersRepo = {
  // Allocates a receipt number atomically, then writes the order and its lines.
  //
  // Not a transaction: PostgREST has no multi-statement transaction, so a crash
  // between the two inserts would leave a header with no lines. That is
  // recoverable (the order shows as empty and can be voided) and visible;
  // the alternative — a stored procedure taking the whole order as jsonb — is
  // the right fix if this ever bites in practice.
  async create(o: NewOrder): Promise<{ order: OrderRow; totals: OrderTotals }> {
    if (o.items.length === 0) throw new Error('[POS] refusing to create an order with no items');

    const totals = computeTotals(o.items, o.gstRate, {
      discount:          o.discount,
      deliveryFee:       o.deliveryFee,
      serviceChargeRate: o.serviceChargeRate,
    });

    const orderNumber = await db.rpc<number>('pos_next_order_number', { p_tenant: o.tenantId });
    const now         = new Date().toISOString();

    const order = await db.insertReturning<OrderRow>('orders', {
      tenant_id:      o.tenantId,
      order_number:   orderNumber,
      customer_name:  o.customerName  ?? 'Guest',
      customer_phone: o.customerPhone ?? '',
      customer_id:    o.customerId    ?? null,
      order_type:     o.orderType     ?? 'dine_in',
      status:         o.status        ?? 'pending',
      payment_method: o.paymentMethod ?? 'cash',
      payment_status: 'unpaid',
      subtotal:       totals.subtotal,
      discount:       totals.discount,
      delivery_fee:   o.deliveryFee ?? 0,
      service_charge: totals.serviceCharge,
      tax_total:      totals.tax,
      total_amount:   totals.total,
      table_id:       o.tableId  ?? null,
      shift_id:       o.shiftId  ?? null,
      staff_id:       o.staffId  ?? null,
      source:         o.source   ?? 'pos',
      notes:          o.notes ?? o.instructions ?? null,
      instructions:   o.instructions ?? null,
      opened_at:      now,
      created_at:     now,
      updated_at:     now,
    });

    await db.insertMany('order_items', o.items.map(i => ({
      tenant_id:        o.tenantId,
      order_id:         order.id,
      dish_id:          i.dishId ?? null,
      dish_name:        i.dishName,
      quantity:         i.quantity,
      unit_price:       i.unitPrice,
      line_discount:    i.lineDiscount ?? 0,
      // item_total is deliberately absent: it is a GENERATED ALWAYS column
      // (quantity * unit_price - line_discount) and Postgres REJECTS an insert
      // that supplies it. Sending it failed every order write with
      // "cannot insert a non-DEFAULT value into column item_total".
      selected_options: i.selectedOptions ?? [],
      notes:            i.notes   ?? null,
      seat_no:          i.seatNo  ?? null,
      course:           i.course  ?? null,
    })));

    return { order, totals };
  },

  findById(tenantId: string, orderId: string): Promise<OrderRow | null> {
    return db.selectOne<OrderRow>('orders', {
      id: `eq.${orderId}`, tenant_id: `eq.${tenantId}`,
    });
  },

  items(orderId: string): Promise<OrderItemRow[]> {
    return db.selectMany<OrderItemRow>('order_items', {
      order_id: `eq.${orderId}`, order: 'id.asc',
    });
  },

  list(tenantId: string, opts: { status?: string; limit?: number } = {}): Promise<OrderRow[]> {
    const filters: Record<string, string> = {
      tenant_id: `eq.${tenantId}`,
      order:     'created_at.desc',
      limit:     String(opts.limit ?? 100),
    };
    if (opts.status) filters.status = `eq.${opts.status}`;
    return db.selectMany<OrderRow>('orders', filters);
  },

  // Open tabs: dine-in orders that have not been closed or voided.
  openForTable(tenantId: string, tableId: string): Promise<OrderRow[]> {
    return db.selectMany<OrderRow>('orders', {
      tenant_id: `eq.${tenantId}`,
      table_id:  `eq.${tableId}`,
      closed_at: 'is.null',
      voided_at: 'is.null',
      order:     'created_at.desc',
    });
  },

  async setStatus(tenantId: string, orderId: string, status: string): Promise<OrderRow | null> {
    const rows = await db.updateReturning<OrderRow>('orders', {
      id: `eq.${orderId}`, tenant_id: `eq.${tenantId}`,
    }, { status, updated_at: new Date().toISOString() });
    return rows[0] ?? null;
  },

  // Voids never delete. A voided order still has to appear in the shift it
  // belonged to, and a refund issued tomorrow still has to find it.
  async void(tenantId: string, orderId: string, reason: string): Promise<void> {
    await db.update('orders', { id: `eq.${orderId}`, tenant_id: `eq.${tenantId}` }, {
      voided_at:  new Date().toISOString(),
      void_reason: reason,
      status:     'voided',
      updated_at: new Date().toISOString(),
    });
  },

  async close(tenantId: string, orderId: string): Promise<void> {
    await db.update('orders', { id: `eq.${orderId}`, tenant_id: `eq.${tenantId}` }, {
      closed_at:  new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  },

  async transferTable(tenantId: string, orderId: string, tableId: string | null): Promise<void> {
    await db.update('orders', { id: `eq.${orderId}`, tenant_id: `eq.${tenantId}` }, {
      table_id: tableId, updated_at: new Date().toISOString(),
    });
  },

  // Tenant-less lookup by primary key, for callers that genuinely have no tenant
  // context. Today that is exactly one: a payment-gateway webhook, which arrives
  // server-to-server with no session and no X-Tenant-ID.
  //
  // Every other read MUST go through findById with its tenant filter. Order ids
  // are uuids, so this cannot be walked, but it is still the one hole in tenant
  // scoping and should not grow more callers.
  findByIdUnscoped(orderId: string): Promise<OrderRow | null> {
    return db.selectOne<OrderRow>('orders', { id: `eq.${orderId}` });
  },

  /**
   * Record the outcome of a gateway payment against an order.
   *
   * Writes absolute values derived from the event rather than mutating
   * relatively, so a webhook redelivery converges on the same result — Paddle
   * retries for up to three days, so this WILL be called more than once.
   *
   * Returns the updated row, or null when no such order exists (an order that
   * predates the Postgres cutover, or a transaction that was never ours).
   */
  async applyPayment(
    orderId: string,
    p: { paymentStatus: string; paymentRef: string; paymentMethod: string },
  ): Promise<OrderRow | null> {
    const existing = await this.findByIdUnscoped(orderId);
    if (!existing) return null;

    const patch: Record<string, unknown> = {
      payment_status: p.paymentStatus,
      payment_ref:    p.paymentRef,
      payment_method: p.paymentMethod,
      updated_at:     new Date().toISOString(),
    };

    // Only a captured payment advances the kitchen. A pending order that has
    // been paid becomes confirmed so it shows on the board as a real, paid
    // order. A voided order is never resurrected by a late webhook.
    if (p.paymentStatus === 'captured' && existing.status === 'pending' && !existing.voided_at) {
      patch.status = 'confirmed';
    }

    const rows = await db.updateReturning<OrderRow>('orders', { id: `eq.${orderId}` }, patch);
    return rows[0] ?? null;
  },

  // ── Amending an open tab ───────────────────────────────────────────────────
  // create() writes an order whole, which suits a kiosk: the customer finishes
  // ordering, then it is saved. A dine-in tab is the opposite — it grows over
  // an hour, a round at a time — so these exist to change an order that is
  // already open, and every one of them re-derives the money afterwards.

  /**
   * Recompute an order's totals from its live lines.
   *
   * The stored totals are never patched incrementally. Adding a line's value to
   * total_amount looks cheaper, but every rounding decision and every rate
   * change then depends on the order the edits happened in, and a tab that was
   * amended four times drifts from a tab that was rung in once. Reading the
   * lines back and recomputing is the only version that always agrees with the
   * receipt.
   *
   * Voided lines are excluded here but stay in the table — the Z-report still
   * has to see them.
   */
  async recomputeTotals(
    tenantId: string,
    orderId:  string,
    rates:    { gstRate: number; serviceChargeRate?: number },
  ): Promise<{ order: OrderRow; totals: OrderTotals }> {
    const order = await ordersRepo.findById(tenantId, orderId);
    if (!order) throw new Error(`[POS] order ${orderId} not found`);

    const items = await ordersRepo.items(orderId);
    const live: NewOrderItem[] = items
      .filter(i => i.voided_at === null)
      .map(i => ({
        dishName:     i.dish_name,
        quantity:     i.quantity,
        unitPrice:    num(i.unit_price),
        lineDiscount: num(i.line_discount),
      }));

    const totals = computeTotals(live, rates.gstRate, {
      discount:          num(order.discount),
      deliveryFee:       num(order.delivery_fee),
      serviceChargeRate: rates.serviceChargeRate,
    });

    const rows = await db.updateReturning<OrderRow>('orders', {
      id: `eq.${orderId}`, tenant_id: `eq.${tenantId}`,
    }, {
      subtotal:       totals.subtotal,
      discount:       totals.discount,
      service_charge: totals.serviceCharge,
      tax_total:      totals.tax,
      total_amount:   totals.total,
      updated_at:     new Date().toISOString(),
    });

    return { order: rows[0], totals };
  },

  /**
   * What the totals WOULD be if this line were voided — computed without
   * writing anything.
   *
   * The alternative is to void, then check, then un-void on refusal. That
   * leaves a window where the order is wrong, and an un-void is not a real
   * operation: the row already carries a void reason and an approver by then.
   * Refusing before any write means a rejected void changes nothing at all.
   */
  async previewVoidItem(
    tenantId: string,
    orderId:  string,
    itemId:   string,
    rates:    { gstRate: number; serviceChargeRate?: number },
  ): Promise<OrderTotals> {
    const order = await ordersRepo.findById(tenantId, orderId);
    if (!order) throw new Error(`[POS] order ${orderId} not found`);

    const items = await ordersRepo.items(orderId);
    const live: NewOrderItem[] = items
      .filter(i => i.voided_at === null && i.id !== itemId)
      .map(i => ({
        dishName:     i.dish_name,
        quantity:     i.quantity,
        unitPrice:    num(i.unit_price),
        lineDiscount: num(i.line_discount),
      }));

    return computeTotals(live, rates.gstRate, {
      discount:          num(order.discount),
      deliveryFee:       num(order.delivery_fee),
      serviceChargeRate: rates.serviceChargeRate,
    });
  },

  /** What the totals WOULD be at this discount. Same no-write rationale. */
  async previewDiscount(
    tenantId: string,
    orderId:  string,
    discount: number,
    rates:    { gstRate: number; serviceChargeRate?: number },
  ): Promise<OrderTotals> {
    const order = await ordersRepo.findById(tenantId, orderId);
    if (!order) throw new Error(`[POS] order ${orderId} not found`);

    const items = await ordersRepo.items(orderId);
    const live: NewOrderItem[] = items
      .filter(i => i.voided_at === null)
      .map(i => ({
        dishName:     i.dish_name,
        quantity:     i.quantity,
        unitPrice:    num(i.unit_price),
        lineDiscount: num(i.line_discount),
      }));

    return computeTotals(live, rates.gstRate, {
      discount,
      deliveryFee:       num(order.delivery_fee),
      serviceChargeRate: rates.serviceChargeRate,
    });
  },
  /**
   * Tie an order to the dine-in visit that produced it.
   *
   * Written after the order exists rather than as part of create(), because
   * SubmitOrderParams is the shared adapter contract and a dine_session_id is
   * meaningless to the managed and custom_api adapters. Best-effort at the call
   * site: the sale is already recorded, and failing to decorate it must not
   * undo it.
   */
  async setDineSession(tenantId: string, orderId: string, dineSessionId: string): Promise<void> {
    await db.update('orders', { id: `eq.${orderId}`, tenant_id: `eq.${tenantId}` }, {
      dine_session_id: dineSessionId,
    });
  },

  /** Every order this table has placed during the current visit. */
  forDineSession(tenantId: string, dineSessionId: string): Promise<OrderRow[]> {
    return db.selectMany<OrderRow>('orders', {
      tenant_id:       `eq.${tenantId}`,
      dine_session_id: `eq.${dineSessionId}`,
      order:           'created_at.asc',
    });
  },

  /** Append a round to an open tab. */
  async addItems(
    tenantId: string,
    orderId:  string,
    items:    NewOrderItem[],
    rates:    { gstRate: number; serviceChargeRate?: number },
  ): Promise<{ order: OrderRow; totals: OrderTotals }> {
    if (items.length === 0) throw new Error('[POS] refusing to add an empty round');

    const order = await ordersRepo.findById(tenantId, orderId);
    if (!order)           throw new Error(`[POS] order ${orderId} not found`);
    if (order.voided_at)  throw new Error('[POS] cannot add items to a voided order');
    // A closed tab has been settled. Re-opening it by adding a line would leave
    // the order owing money nobody is standing there to pay.
    if (order.closed_at)  throw new Error('[POS] this order is already closed — start a new one');

    await db.insertMany('order_items', items.map(i => ({
      tenant_id:        tenantId,
      order_id:         orderId,
      dish_id:          i.dishId ?? null,
      dish_name:        i.dishName,
      quantity:         i.quantity,
      unit_price:       i.unitPrice,
      line_discount:    i.lineDiscount ?? 0,
      // item_total omitted — GENERATED ALWAYS (see migration 010).
      selected_options: i.selectedOptions ?? [],
      notes:            i.notes   ?? null,
      seat_no:          i.seatNo  ?? null,
      course:           i.course  ?? null,
    })));

    return ordersRepo.recomputeTotals(tenantId, orderId, rates);
  },

  /** Void one line. The row is kept so the Z-report and any audit still see it. */
  async voidItem(
    tenantId: string,
    orderId:  string,
    itemId:   string,
    reason:   string,
    byStaffId: string | null,
    rates:    { gstRate: number; serviceChargeRate?: number },
  ): Promise<{ order: OrderRow; totals: OrderTotals }> {
    const items = await ordersRepo.items(orderId);
    const line  = items.find(i => i.id === itemId);
    if (!line)            throw new Error(`[POS] line ${itemId} not found on this order`);
    if (line.voided_at)   throw new Error('[POS] that line is already voided');

    await db.update('order_items', { id: `eq.${itemId}`, tenant_id: `eq.${tenantId}` }, {
      voided_at:   new Date().toISOString(),
      void_reason: reason,
      void_by:     byStaffId,
    });

    return ordersRepo.recomputeTotals(tenantId, orderId, rates);
  },

  /** Set an order-level discount. Stored with its reason and who approved it. */
  async applyDiscount(
    tenantId:  string,
    orderId:   string,
    discount:  number,
    reason:    string,
    byStaffId: string | null,
    rates:     { gstRate: number; serviceChargeRate?: number },
  ): Promise<{ order: OrderRow; totals: OrderTotals }> {
    const order = await ordersRepo.findById(tenantId, orderId);
    if (!order)          throw new Error(`[POS] order ${orderId} not found`);
    if (order.voided_at) throw new Error('[POS] cannot discount a voided order');
    if (order.closed_at) throw new Error('[POS] cannot discount an order that is already settled');

    await db.update('orders', { id: `eq.${orderId}`, tenant_id: `eq.${tenantId}` }, {
      discount, discount_reason: reason, discount_by: byStaffId,
    });

    return ordersRepo.recomputeTotals(tenantId, orderId, rates);
  },
};

// ── Payments ─────────────────────────────────────────────────────────────────

export interface PaymentRow {
  id:              string;
  tenant_id:       string;
  order_id:        string;
  shift_id:        string | null;
  method:          string;
  amount:          unknown;
  tendered:        unknown;
  change_due:      unknown;
  tip:             unknown;
  status:          string;
  refunded_amount: unknown;
  reference:       string | null;
  staff_id:        string | null;
  created_at:      string;
}

export const paymentsRepo = {
  forOrder(orderId: string): Promise<PaymentRow[]> {
    return db.selectMany<PaymentRow>('pos_payments', {
      order_id: `eq.${orderId}`, order: 'created_at.asc',
    });
  },

  // Sum of captured tender against an order, net of refunds. The route uses
  // this to reject an over-tender and to decide when an order is fully paid.
  async paidTotal(orderId: string): Promise<number> {
    const rows = await paymentsRepo.forOrder(orderId);
    return rows
      .filter(p => p.status !== 'voided')
      .reduce((s, p) => s + num(p.amount) - num(p.refunded_amount), 0);
  },

  capture(p: {
    tenantId: string; orderId: string; shiftId?: string | null; method: string;
    amount: number; tendered?: number; changeDue?: number; tip?: number;
    reference?: string | null; staffId?: string | null;
  }): Promise<PaymentRow> {
    return db.insertReturning<PaymentRow>('pos_payments', {
      tenant_id:  p.tenantId,
      order_id:   p.orderId,
      shift_id:   p.shiftId  ?? null,
      method:     p.method,
      amount:     p.amount,
      tendered:   p.tendered  ?? null,
      change_due: p.changeDue ?? 0,
      tip:        p.tip       ?? 0,
      status:     'captured',
      reference:  p.reference ?? null,
      staff_id:   p.staffId   ?? null,
    });
  },

  // Increments refunded_amount rather than deleting or negating. The DB
  // constraint pos_payments_refund_within_amount stops a refund exceeding the
  // original tender even if the route's own check is wrong.
  async refund(tenantId: string, paymentId: string, amount: number): Promise<PaymentRow> {
    const existing = await db.selectOne<PaymentRow>('pos_payments', {
      id: `eq.${paymentId}`, tenant_id: `eq.${tenantId}`,
    });
    if (!existing) throw new Error(`[POS] payment ${paymentId} not found`);

    const already = num(existing.refunded_amount);
    const total   = num(existing.amount);
    const next    = already + amount;
    if (next > total) {
      throw new Error(`[POS] refund ${amount} exceeds remaining ${total - already} on payment ${paymentId}`);
    }

    const rows = await db.updateReturning<PaymentRow>('pos_payments', {
      id: `eq.${paymentId}`, tenant_id: `eq.${tenantId}`,
    }, {
      refunded_amount: next,
      status:          next >= total ? 'refunded' : 'partially_refunded',
    });
    return rows[0];
  },
};

// ── Shifts ───────────────────────────────────────────────────────────────────

export interface ShiftRow {
  id:            string;
  tenant_id:     string;
  opened_by:     string | null;
  opened_at:     string;
  opening_float: unknown;
  closed_by:     string | null;
  closed_at:     string | null;
  declared_cash: unknown;
  expected_cash: unknown;
  variance:      unknown;
  note:          string | null;
  status:        string;
}

export interface CashMovementRow {
  id:         string;
  tenant_id:  string;
  shift_id:   string;
  type:       string;
  amount:     unknown;
  reason:     string | null;
  staff_id:   string | null;
  created_at: string;
}

export interface ShiftReport {
  shiftId:      string;
  openedAt:     string;
  closedAt:     string | null;
  openingFloat: number;
  orders:       { total: number; voided: number };
  sales:        { subtotal: number; discount: number; serviceCharge: number; tax: number; total: number };
  tenders:      Array<{ method: string; gross: number; refunded: number; net: number; count: number }>;
  movements:    Array<{ type: string; amount: number; count: number }>;
  expectedCash: number;
  /** Null until the shift is closed — an X report has nothing counted yet. */
  declaredCash: number | null;
  variance:     number | null;
}

export const shiftsRepo = {
  current(tenantId: string): Promise<ShiftRow | null> {
    return db.selectOne<ShiftRow>('pos_shifts', {
      tenant_id: `eq.${tenantId}`, status: 'eq.open',
    });
  },

  // A unique partial index (pos_shifts_one_open_per_tenant_uidx) enforces
  // one-open-shift-per-tenant, so two managers racing to open a drawer produces
  // a constraint violation rather than two live shifts. Let it throw.
  open(tenantId: string, openedBy: string | null, openingFloat: number): Promise<ShiftRow> {
    return db.insertReturning<ShiftRow>('pos_shifts', {
      tenant_id:     tenantId,
      opened_by:     openedBy,
      opening_float: openingFloat,
      status:        'open',
    });
  },

  // Any shift by id, open or closed — current() only ever returns the open one,
  // and a Z report is read from a shift that has just been closed.
  byId(tenantId: string, shiftId: string): Promise<ShiftRow | null> {
    return db.selectOne<ShiftRow>('pos_shifts', {
      id: `eq.${shiftId}`, tenant_id: `eq.${tenantId}`,
    });
  },
  movements(shiftId: string): Promise<CashMovementRow[]> {
    return db.selectMany<CashMovementRow>('pos_cash_movements', {
      shift_id: `eq.${shiftId}`, order: 'created_at.asc',
    });
  },

  addMovement(m: {
    tenantId: string; shiftId: string; type: string;
    amount: number; reason?: string | null; staffId?: string | null;
  }): Promise<CashMovementRow> {
    return db.insertReturning<CashMovementRow>('pos_cash_movements', {
      tenant_id: m.tenantId,
      shift_id:  m.shiftId,
      type:      m.type,
      amount:    m.amount,
      reason:    m.reason  ?? null,
      staff_id:  m.staffId ?? null,
    });
  },

  // What the drawer should hold: opening float, plus cash tendered net of
  // change and refunds, plus paid-in, minus paid-out/drops.
  //
  // Card and wallet tender is deliberately excluded — it never enters the
  // drawer, and including it is the classic reason a Z-report "never balances".
  async expectedCash(tenantId: string, shift: ShiftRow): Promise<number> {
    const [payments, movements] = await Promise.all([
      db.selectMany<PaymentRow>('pos_payments', {
        tenant_id: `eq.${tenantId}`, shift_id: `eq.${shift.id}`, method: 'eq.cash',
      }),
      shiftsRepo.movements(shift.id),
    ]);

    const cashSales = payments
      .filter(p => p.status !== 'voided')
      .reduce((s, p) => s + num(p.amount) - num(p.refunded_amount), 0);

    const movementNet = movements.reduce((s, m) => {
      const amt = num(m.amount);
      return m.type === 'cash_in' ? s + amt : s - amt;
    }, 0);

    return Math.round((num(shift.opening_float) + cashSales + movementNet) * 100) / 100;
  },

  /**
   * The numbers behind an X or a Z report.
   *
   * X = read the figures mid-shift, drawer stays open. Z = the same figures at
   * close, after which the shift is finished. They are the SAME computation on
   * purpose: a Z that is derived differently from the X staff read an hour
   * earlier is a Z nobody trusts.
   *
   * Tender is grouped by method and reported gross, refunded and net, because
   * "we took 40,000 today" and "we took 40,000 and refunded 3,000" are very
   * different days and a single net figure hides which one happened.
   */
  async report(tenantId: string, shift: ShiftRow): Promise<ShiftReport> {
    const [orders, payments, movements, expectedCash] = await Promise.all([
      db.selectMany<OrderRow>('orders', {
        tenant_id: `eq.${tenantId}`, shift_id: `eq.${shift.id}`,
      }),
      db.selectMany<PaymentRow>('pos_payments', {
        tenant_id: `eq.${tenantId}`, shift_id: `eq.${shift.id}`,
      }),
      shiftsRepo.movements(shift.id),
      shiftsRepo.expectedCash(tenantId, shift),
    ]);

    // Voided orders are counted but contribute no money. They still have to be
    // visible: a shift with thirty voids is telling you something, and a report
    // that silently drops them is the one that hides it.
    const live = orders.filter(o => o.voided_at === null);

    const sales = live.reduce((acc, o) => ({
      subtotal:      acc.subtotal      + num(o.subtotal),
      discount:      acc.discount      + num(o.discount),
      serviceCharge: acc.serviceCharge + num(o.service_charge),
      tax:           acc.tax           + num(o.tax_total),
      total:         acc.total         + num(o.total_amount),
    }), { subtotal: 0, discount: 0, serviceCharge: 0, tax: 0, total: 0 });

    const r2 = (n: number) => Math.round(n * 100) / 100;

    const byMethod = new Map<string, { gross: number; refunded: number; count: number }>();
    for (const pay of payments) {
      if (pay.status === 'voided') continue;
      const e = byMethod.get(pay.method) ?? { gross: 0, refunded: 0, count: 0 };
      e.gross    += num(pay.amount);
      e.refunded += num(pay.refunded_amount);
      e.count    += 1;
      byMethod.set(pay.method, e);
    }

    const byType = new Map<string, { amount: number; count: number }>();
    for (const m of movements) {
      const e = byType.get(m.type) ?? { amount: 0, count: 0 };
      e.amount += num(m.amount);
      e.count  += 1;
      byType.set(m.type, e);
    }

    return {
      shiftId:      shift.id,
      openedAt:     shift.opened_at,
      closedAt:     shift.closed_at,
      openingFloat: num(shift.opening_float),
      orders: {
        total:  orders.length,
        voided: orders.length - live.length,
      },
      sales: {
        subtotal:      r2(sales.subtotal),
        discount:      r2(sales.discount),
        serviceCharge: r2(sales.serviceCharge),
        tax:           r2(sales.tax),
        total:         r2(sales.total),
      },
      tenders: [...byMethod.entries()]
        .map(([method, v]) => ({
          method,
          gross:    r2(v.gross),
          refunded: r2(v.refunded),
          net:      r2(v.gross - v.refunded),
          count:    v.count,
        }))
        .sort((a, b) => b.net - a.net),
      movements: [...byType.entries()]
        .map(([type, v]) => ({ type, amount: r2(v.amount), count: v.count }))
        .sort((a, b) => a.type.localeCompare(b.type)),
      expectedCash,
      declaredCash: shift.declared_cash === null ? null : num(shift.declared_cash),
      variance:     shift.variance      === null ? null : num(shift.variance),
    };
  },

  async close(
    tenantId: string,
    shift: ShiftRow,
    declaredCash: number,
    closedBy: string | null,
    note?: string | null,
  ): Promise<ShiftRow> {
    const expected = await shiftsRepo.expectedCash(tenantId, shift);
    const rows     = await db.updateReturning<ShiftRow>('pos_shifts', {
      id: `eq.${shift.id}`, tenant_id: `eq.${tenantId}`,
    }, {
      status:        'closed',
      closed_at:     new Date().toISOString(),
      closed_by:     closedBy,
      declared_cash: declaredCash,
      expected_cash: expected,
      variance:      Math.round((declaredCash - expected) * 100) / 100,
      note:          note ?? null,
    });
    return rows[0];
  },

  // Closing a drawer while a tab is still open makes the cash figure a lie.
  async openOrderCount(tenantId: string, shiftId: string): Promise<number> {
    const rows = await db.selectMany<{ id: string }>('orders', {
      select:    'id',
      tenant_id: `eq.${tenantId}`,
      shift_id:  `eq.${shiftId}`,
      closed_at: 'is.null',
      voided_at: 'is.null',
    });
    return rows.length;
  },
};

// ── Tables (shared with Reservations) ────────────────────────────────────────

export interface VenueTableRow {
  id:        string;
  tenant_id: string;
  area:      string;
  label:     string;
  seats:     number;
  x:         number;
  y:         number;
  status:    string;
}

export const tablesRepo = {
  list(tenantId: string): Promise<VenueTableRow[]> {
    return db.selectMany<VenueTableRow>('venue_tables', {
      tenant_id: `eq.${tenantId}`, order: 'area.asc,label.asc',
    });
  },

  create(t: {
    tenantId: string; area?: string; label: string; seats?: number; x?: number; y?: number;
  }): Promise<VenueTableRow> {
    return db.insertReturning<VenueTableRow>('venue_tables', {
      tenant_id: t.tenantId,
      area:      t.area  ?? 'Main',
      label:     t.label,
      seats:     t.seats ?? 2,
      x:         t.x ?? 0,
      y:         t.y ?? 0,
    });
  },

  async update(tenantId: string, id: string, patch: Partial<Omit<VenueTableRow, 'id' | 'tenant_id'>>): Promise<void> {
    await db.update('venue_tables', { id: `eq.${id}`, tenant_id: `eq.${tenantId}` }, patch);
  },

  async remove(tenantId: string, id: string): Promise<void> {
    await db.remove('venue_tables', { id: `eq.${id}`, tenant_id: `eq.${tenantId}` });
  },
};

// ── Customers ────────────────────────────────────────────────────────────────

export interface CustomerRow {
  id:        string;
  tenant_id: string;
  name:      string | null;
  phone:     string | null;
  email:     string | null;
  notes:     string | null;
}

export const customersRepo = {
  findByPhone(tenantId: string, phone: string): Promise<CustomerRow | null> {
    return db.selectOne<CustomerRow>('pos_customers', {
      tenant_id: `eq.${tenantId}`, phone: `eq.${phone}`,
    });
  },

  create(c: { tenantId: string; name?: string; phone?: string; email?: string; notes?: string }): Promise<CustomerRow> {
    return db.insertReturning<CustomerRow>('pos_customers', {
      tenant_id: c.tenantId,
      name:      c.name  ?? null,
      phone:     c.phone ?? null,
      email:     c.email ?? null,
      notes:     c.notes ?? null,
    });
  },

  // Phone is the natural key at the till; upserting on it stops a regular
  // customer accumulating a new row on every visit.
  async findOrCreate(tenantId: string, phone: string, name?: string): Promise<CustomerRow> {
    const existing = await customersRepo.findByPhone(tenantId, phone);
    if (existing) return existing;
    return customersRepo.create({ tenantId, phone, name });
  },
};
