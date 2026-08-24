import * as db from './supabaseAdmin.js';
import type { OrderItemRow } from './posRepo.js';

// The kitchen display's data.
//
// Reads are shaped around one question: "what still has to be cooked, oldest
// first?" Everything else on the board — the colour, the timer, the station tab
// — is derived from that in the browser.

export interface StationRow {
  id:         string;
  tenant_id:  string;
  name:       string;
  sort_order: number;
  active:     boolean;
}

export interface KdsLine {
  itemId:    string;
  name:      string;
  quantity:  number;
  modifiers: string[];
  notes:     string | null;
  seat:      number | null;
  course:    string | null;
  startedAt: string | null;
}

export interface KdsTicket {
  orderId:     string;
  orderNumber: number | null;
  orderType:   string;
  tableLabel:  string | null;
  source:      string;
  placedAt:    string;
  lines:       KdsLine[];
}

interface OrderHead {
  id: string; order_number: number | null; order_type: string;
  status: string; source: string; created_at: string; table_id: string | null;
}

// Statuses whose lines the kitchen should be looking at. A 'ready' order still
// appears until every line is bumped, so a partially-plated order does not
// vanish off the board mid-service.
const COOKING = ['pending', 'confirmed', 'preparing', 'ready'];

export const kdsRepo = {
  stations(tenantId: string): Promise<StationRow[]> {
    return db.selectMany<StationRow>('pos_stations', {
      tenant_id: `eq.${tenantId}`, active: 'is.true', order: 'sort_order.asc,name.asc',
    });
  },

  /**
   * Open tickets, oldest first.
   *
   * Three reads rather than one embedded query: PostgREST's nested embeds with
   * filters at each level are fragile, and this shape is easy to reason about
   * when it is slow. The board polls rarely — it is driven by the event stream —
   * so the round trips are not the bottleneck.
   */
  async tickets(tenantId: string, stationId?: string): Promise<KdsTicket[]> {
    const orders = await db.selectMany<OrderHead>('orders', {
      tenant_id: `eq.${tenantId}`,
      status:    `in.(${COOKING.join(',')})`,
      voided_at: 'is.null',
      order:     'created_at.asc',
      limit:     '100',
      select:    'id,order_number,order_type,status,source,created_at,table_id',
    });
    if (orders.length === 0) return [];

    const ids = orders.map(o => o.id);

    const [items, tables] = await Promise.all([
      db.selectMany<OrderItemRow & { started_at: string | null; bumped_at: string | null; dish_id: number | null }>(
        'order_items',
        {
          tenant_id: `eq.${tenantId}`,
          order_id:  `in.(${ids.join(',')})`,
          bumped_at: 'is.null',
          voided_at: 'is.null',
          order:     'id.asc',
        },
      ),
      db.selectMany<{ id: string; label: string }>('venue_tables', {
        tenant_id: `eq.${tenantId}`, select: 'id,label',
      }),
    ]);

    // Station filtering needs dish → station, which lives on `dishes`. Only
    // fetched when a station is actually selected, so the common
    // one-board kitchen costs nothing.
    let dishStation: Map<number, string> | null = null;
    if (stationId) {
      const dishes = await db.selectMany<{ id: number; station_id: string | null }>('dishes', {
        tenant_id: `eq.${tenantId}`, station_id: `eq.${stationId}`, select: 'id,station_id',
      });
      dishStation = new Map(dishes.map(d => [d.id, d.station_id!]));
    }

    const tableById = new Map(tables.map(t => [t.id, t.label]));
    const byOrder   = new Map<string, KdsLine[]>();

    for (const i of items) {
      // An open item has no dish_id and therefore no station. It shows on the
      // unfiltered board only — better than hiding it from every station and
      // having nobody cook it.
      if (dishStation && (i.dish_id === null || !dishStation.has(i.dish_id))) continue;

      const list = byOrder.get(i.order_id) ?? [];
      list.push({
        itemId:    i.id,
        name:      i.dish_name,
        quantity:  i.quantity,
        modifiers: (i.selected_options ?? []).map(o => o.choice_name),
        notes:     i.notes,
        seat:      i.seat_no,
        course:    i.course,
        startedAt: i.started_at,
      });
      byOrder.set(i.order_id, list);
    }

    return orders
      .filter(o => byOrder.has(o.id))     // nothing left to cook → off the board
      .map(o => ({
        orderId:     o.id,
        orderNumber: o.order_number,
        orderType:   o.order_type,
        tableLabel:  o.table_id ? tableById.get(o.table_id) ?? null : null,
        source:      o.source,
        placedAt:    o.created_at,
        lines:       byOrder.get(o.id)!,
      }));
  },

  async bump(tenantId: string, itemId: string, staffId: string | null): Promise<OrderItemRow | null> {
    const rows = await db.updateReturning<OrderItemRow>('order_items', {
      id: `eq.${itemId}`, tenant_id: `eq.${tenantId}`,
    }, {
      bumped_at: new Date().toISOString(),
      bumped_by: staffId,
    });
    return rows[0] ?? null;
  },

  /**
   * Un-bump a line.
   *
   * Bumping is one tap and mistakes happen. Without recall the only recovery is
   * re-ringing the item, which double-charges the customer for a kitchen error.
   */
  async recall(tenantId: string, itemId: string): Promise<OrderItemRow | null> {
    const rows = await db.updateReturning<OrderItemRow>('order_items', {
      id: `eq.${itemId}`, tenant_id: `eq.${tenantId}`,
    }, {
      bumped_at: null, bumped_by: null,
    });
    return rows[0] ?? null;
  },

  /** True when nothing on this order is still waiting to be cooked. */
  async allBumped(orderId: string): Promise<boolean> {
    const remaining = await db.selectMany<{ id: string }>('order_items', {
      order_id:  `eq.${orderId}`,
      bumped_at: 'is.null',
      voided_at: 'is.null',
      select:    'id',
      limit:     '1',
    });
    return remaining.length === 0;
  },
};
