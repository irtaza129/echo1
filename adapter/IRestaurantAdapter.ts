// ── Input param types ─────────────────────────────────────────────────────────
// All methods accept camelCase params; adapters handle serialisation internally.

export interface ResolveItemParams {
  sessionId:  string;
  dishQuery:  string;
  modifiers?: string[];
  quantity?:  number;
  notes?:     string | null;
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
}

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
  getCart(sessionId: string):              Promise<unknown>;

  // Orders
  submitOrder(params: SubmitOrderParams): Promise<OrderResult>;
  getOrders(filter?: OrderFilter):         Promise<unknown>;
  updateOrderStatus(orderId: string, status: string): Promise<unknown>;
}
