import type { WireOrder, WireCartItem } from '../src/lib/types.js';

export type { WireOrder, WireCartItem };

// ── Input param types ─────────────────────────────────────────────────────────
// All methods accept camelCase params; adapters handle serialisation internally.

export interface ResolveItemParams {
  sessionId:  string;
  dishQuery:  string;
  modifiers?: string[];
  quantity?:  number;
  notes?:     string | null;
}

// One line of an inline cart, used as the fallback source of order items when
// no Redis cart exists for the session (see PosAdapter.submitOrder). Shaped to
// match NewOrderItem in posRepo.ts without importing it, so this interface
// stays independent of any one adapter's storage.
export interface SubmitOrderCartItem {
  dishId?:          number | null;
  dishName:         string;
  quantity:         number;
  unitPrice:        number;
  selectedOptions?: { option_name?: string; choice_name: string }[];
  notes?:           string | null;
}

export interface SubmitOrderParams {
  sessionId:      string;
  customerName?:  string;
  customerPhone?: string;
  orderType?:     string;
  paymentMethod?: string;
  deliveryFee?:   number;
  discount?:      number;
  instructions?:  string | null;
  notes?:         string | null;
  cartItems?:     SubmitOrderCartItem[];
  // Which channel rang this order in. Recorded on the order so reporting can
  // answer whether the AI channels earn their keep — the whole point of
  // orders.source existing. Upstream adapters ignore it; PosAdapter stores it.
  source?:        OrderSource;
  // Dine-in table, when the channel knows it (POS floor, QR at the table).
  tableId?:       string | null;
}

// Closed set rather than string: `source` drives reporting breakdowns, and one
// typo'd 'kiosc' would quietly split a column in two.
export type OrderSource = 'pos' | 'kiosk' | 'phone' | 'whatsapp' | 'qr' | 'web';

export interface OrderFilter {
  status?:  string;
  perPage?: number;
  [key: string]: string | number | undefined;
}

// ── Response types ────────────────────────────────────────────────────────────
// Snake_case fields match what the Render backend returns and what App.tsx
// consumes, so ManagedBackendAdapter can pass responses through without
// transformation and the frontend keeps working as-is.

export interface ResolveItemResult {
  status:            'ok' | 'requires_input';
  summary?:          string;
  unit_price?:       number;
  cart_item_id?:     string;
  dish_id?:          number;
  selected_options?: { option_id: number; sub_option_id: number }[];
  ai_instruction?:   string;
}

export interface OrderResult {
  id?:           number;
  order_id?:     string;
  order_number?: string | number;
  summary?:      string;
  total?:        number;
  error?:        string;
}

// ── Envelope normalisation ────────────────────────────────────────────────────
// Upstreams disagree on how they wrap collections: some return a bare array,
// others `{items:[...]}`, `{orders:[...]}` or `{data:[...]}`. Unwrap once, here,
// so every adapter hands routes the same bare array and no caller downstream has
// to guess.
//
// Throws on an unrecognised shape rather than returning []. An empty array is a
// legitimate answer ("no orders yet") and must never be how a parse failure
// looks — that ambiguity is exactly what hid the dashboard outage.
export function unwrapCollection<T>(raw: unknown, context: string): T[] {
  if (Array.isArray(raw)) return raw as T[];

  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['items', 'orders', 'data', 'results'] as const) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }

  throw new Error(
    `[adapter] ${context}: expected an array or {items|orders|data|results:[...]}, got ${
      raw === null ? 'null' : typeof raw
    }`,
  );
}

// ── Core interface ────────────────────────────────────────────────────────────
// Define once here; every adapter (Managed, Custom, Webhook) implements this.
// Routes in server.ts call ONLY these methods — never axios directly.

export interface IRestaurantAdapter {
  // Menu
  getMenuContext(): Promise<string>;       // markdown injected into Gemini system prompt
  getMenuForUI():   Promise<unknown>;      // raw JSON for the kiosk grid

  // Cart
  resolveItem(params: ResolveItemParams): Promise<ResolveItemResult>;
  removeItem(sessionId: string, cartItemId: string): Promise<void>;
  clearCart(sessionId: string):            Promise<void>;
  // Always a bare array in canonical wire shape — adapters unwrap whatever
  // envelope their upstream uses. Never `unknown`: that is what let the two
  // implementations silently disagree.
  getCart(sessionId: string):              Promise<WireCartItem[]>;

  // Orders
  submitOrder(params: SubmitOrderParams): Promise<OrderResult>;
  getOrders(filter?: OrderFilter):         Promise<WireOrder[]>;
  updateOrderStatus(orderId: string, status: string): Promise<unknown>;
}
