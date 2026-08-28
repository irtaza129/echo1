import { getRedis, redisKey } from '../src/lib/redis.js';
import { parseTenantConfig, type TenantConfig, type AdapterCredentials } from '../src/lib/tenantConfig.js';
import { decryptCredentials, type EncryptedBlob } from '../src/lib/crypto.js';
import { AdapterFactory } from '../adapter/AdapterFactory.js';
import type { IRestaurantAdapter, OrderSource } from '../adapter/IRestaurantAdapter.js';

// Tool implementations shared by the server-side channels (WhatsApp today, the
// phone agent next). The browser kiosk reaches the same logic over HTTP through
// /api/agent/*; these functions are what a channel with no browser calls
// directly.
//
// Every function here delegates to the tenant's adapter. It used to carry a
// second, parallel implementation that read and wrote Redis directly whenever
// the tenant had an admin-managed menu — which meant a WhatsApp order and a
// kiosk order for the same restaurant could land in different stores, with
// different totals, and neither could see the other. One code path, one ledger.

// ── Response shapes (match the /api/agent/* route responses) ─────────────────

export interface ResolveItemResponse {
  status: 'ok' | 'not_found' | 'requires_input';
  cart_item_id: string | null;
  summary:      string | null;
  unit_price:   number | null;
  ai_instruction?: string;
}

export interface SubmitOrderResponse {
  id:           string;
  order_id:     string;
  order_number: number;
  total:        number;
  summary:      string;
}

// ── Tenant context ────────────────────────────────────────────────────────────

export async function loadAdapterForTenant(
  tenantId: string,
): Promise<{ config: TenantConfig; adapter: IRestaurantAdapter }> {
  const redis  = getRedis();
  const cached = await redis.get<unknown>(redisKey.tenantConfig(tenantId));
  if (!cached) throw new Error(`[DISPATCH] Tenant config not found for ${tenantId}`);
  const config = parseTenantConfig(cached);

  let credentials: AdapterCredentials = {};
  try {
    const blob = await redis.get<EncryptedBlob>(redisKey.credentialsKey(tenantId));
    if (blob) credentials = decryptCredentials(blob);
  } catch { /* managed and pos adapters need no credentials */ }

  return { config, adapter: AdapterFactory.create(config, credentials) };
}

// ── Tool implementations ──────────────────────────────────────────────────────
//
// Cart serialisation lives inside PosAdapter now (see src/lib/cartLock.ts), so
// concurrent add_item calls are safe for every channel rather than only this one.

export async function resolveItemLocal(
  tenantId: string,
  sessionId: string,
  params: { dish_query: string; modifiers?: string[]; quantity?: number; notes?: string | null },
): Promise<ResolveItemResponse> {
  const { adapter } = await loadAdapterForTenant(tenantId);

  const result = await adapter.resolveItem({
    sessionId,
    dishQuery: params.dish_query,
    modifiers: params.modifiers,
    quantity:  params.quantity,
    notes:     params.notes,
  });

  // The adapter contract is {status: 'ok' | 'requires_input'}; this channel's
  // callers also understand 'not_found'. Normalise to the wider shape with the
  // nulls the WhatsApp handler expects, rather than leaving fields undefined.
  return {
    status:         result.status,
    cart_item_id:   result.cart_item_id ?? null,
    summary:        result.summary      ?? null,
    unit_price:     result.unit_price   ?? null,
    ai_instruction: result.ai_instruction,
  };
}

/**
 * Read the current cart for a session.
 *
 * WhatsApp needs this because its conversation history is persisted as plain
 * text only — the model never sees the cart_item_id values that earlier
 * add_item calls returned. Without a cart snapshot in the system prompt it
 * cannot satisfy "remove the pulao" on any message after the one that added it.
 */
export async function getCartLocal(
  tenantId: string,
  sessionId: string,
): Promise<Array<{ cart_item_id: string; summary: string; quantity: number; unit_price: number }>> {
  const { adapter } = await loadAdapterForTenant(tenantId);
  const items = await adapter.getCart(sessionId);

  return items.map(i => ({
    cart_item_id: i.cart_item_id,
    summary:      i.summary ?? i.dish_name,
    quantity:     i.quantity,
    unit_price:   typeof i.unit_price === 'number' ? i.unit_price : Number(i.unit_price) || 0,
  }));
}

export async function removeItemLocal(
  tenantId: string,
  sessionId: string,
  cartItemId: string,
): Promise<void> {
  const { adapter } = await loadAdapterForTenant(tenantId);
  await adapter.removeItem(sessionId, cartItemId);
}

export async function clearCartLocal(tenantId: string, sessionId: string): Promise<void> {
  const { adapter } = await loadAdapterForTenant(tenantId);
  await adapter.clearCart(sessionId);
}

export async function submitOrderLocal(
  tenantId: string,
  sessionId: string,
  params: {
    customer_name?:  string;
    customer_phone?: string;
    order_type?:     string;
    instructions?:   string | null;
    notes?:          string | null;
  },
  _config: TenantConfig,
  source: OrderSource = 'whatsapp',
): Promise<SubmitOrderResponse> {
  const { adapter } = await loadAdapterForTenant(tenantId);

  const result = await adapter.submitOrder({
    sessionId,
    customerName:  params.customer_name,
    customerPhone: params.customer_phone,
    orderType:     params.order_type,
    instructions:  params.instructions,
    notes:         params.notes,
    source,
  });

  // An empty cart comes back as {error}, not a rejection — surface it as one so
  // the tool loop reports "your cart is empty" instead of an order numbered 0.
  if (result.error) throw new Error(result.error);

  const orderId  = result.order_id ?? String(result.id ?? '');
  const orderNum = typeof result.order_number === 'number'
    ? result.order_number
    : Number(result.order_number ?? 0);

  console.log(`[DISPATCH] Order #${orderNum} submitted for tenant ${tenantId} via ${source}`);

  return {
    id: orderId, order_id: orderId, order_number: orderNum,
    total: result.total ?? 0, summary: result.summary ?? `Order #${orderNum}`,
  };
}
