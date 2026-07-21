// ── Canonical wire types ─────────────────────────────────────────────────────
// The single definition of what /api/orders and /api/agent/cart put on the
// wire. Imported by the Express routes, every adapter, and the dashboard, so
// all three are forced to agree at compile time.
//
// These deliberately use the Render backend's snake_case field names
// (total_amount, dish_name, item_total). Render is external and cannot be
// changed, so it sets the contract; the local Redis path normalises into this
// shape on read via toWireOrder() in server.ts.
//
// History: these were `unknown` on IRestaurantAdapter, which let the local path
// and the Render adapter drift apart unnoticed — the local path emitted a bare
// array of `{total, items:[{name}]}` while the dashboard read `{items:[...]}`
// of `{total_amount, items:[{dish_name}]}`. Nothing failed loudly: the board
// rendered empty, then rendered Rs 0. Keep these typed.

// `option_name` is the group ("Piece"), `choice_name` the selection ("leg").
// Locally-stored modifiers are bare strings with no group, so option_name is
// optional and the dashboard renders the label only when present.
export interface WireSelectedOption {
  option_name?: string;
  choice_name:  string;
}

export interface WireOrderItem {
  dish_name:         string;
  quantity:          number;
  unit_price:        string | number;
  item_total:        string | number;
  notes?:            string | null;
  selected_options?: WireSelectedOption[];
}

export interface WireOrder {
  id:             string;
  order_number?:  string | number;
  customer_name:  string;
  customer_phone: string;
  order_type:     string;
  status:         string;
  total_amount:   string | number;
  subtotal:       string | number;
  notes?:         string | null;
  created_at:     string;
  items:          WireOrderItem[];
}

export interface WireCartItem {
  cart_item_id: string;
  dish_name:    string;
  quantity:     number;
  unit_price:   string | number;
  summary?:     string;
  notes?:       string | null;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  response: unknown;
}

export interface TranscriptTurn {
  index: number;
  customerText: string | null;
  aiText: string | null;
  toolCalls: ToolCallRecord[];
  promptTokens: number;
  responseTokens: number;
  costUsd: number;
  timestamp: string; // ISO-8601
}
