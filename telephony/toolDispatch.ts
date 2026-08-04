import crypto from 'crypto';
import { getRedis, redisKey, TTL } from '../src/lib/redis.js';
import { parseTenantConfig, type TenantConfig, type AdapterCredentials } from '../src/lib/tenantConfig.js';
import { decryptCredentials, type EncryptedBlob } from '../src/lib/crypto.js';
import { AdapterFactory } from '../adapter/AdapterFactory.js';
import type { IRestaurantAdapter } from '../adapter/IRestaurantAdapter.js';
import {
  getLocalMenu, fuzzyMatchItem,
  type LocalCartItem, type LocalOrder,
} from '../src/lib/localMenuUtils.js';

// ── Response shapes (match existing /api/agent/* route responses) ─────────────

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
// Loads config + credentials from Redis and builds the adapter. Used by the
// adapter fall-through path for tenants without an admin-managed local menu.

export async function loadAdapterForTenant(tenantId: string): Promise<{ config: TenantConfig; adapter: IRestaurantAdapter }> {
  const redis  = getRedis();
  const cached = await redis.get<unknown>(redisKey.tenantConfig(tenantId));
  if (!cached) throw new Error(`[DISPATCH] Tenant config not found for ${tenantId}`);
  const config = parseTenantConfig(cached);

  let credentials: AdapterCredentials = {};
  try {
    const blob = await redis.get<EncryptedBlob>(redisKey.credentialsKey(tenantId));
    if (blob) credentials = decryptCredentials(blob);
  } catch { /* managed adapter needs no credentials */ }

  return { config, adapter: AdapterFactory.create(config, credentials) };
}

// ── Cart mutation serialisation ───────────────────────────────────────────────
// The cart lives under a single Redis key and every mutation is a
// read-modify-write. Two concurrent writers both read the pre-state and the
// second write silently discards the first item — which is exactly what happens
// when a model emits two add_item calls in one turn. Chain mutations per
// (tenant, session) so they apply in order.
//
// This is per-process. It fully covers the dominant case (several tool calls in
// one turn, one request, one process). Multi-instance deployments would need a
// Redis lock or a Lua CAS; noted rather than silently assumed away.

const cartLocks = new Map<string, Promise<unknown>>();

function withCartLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = cartLocks.get(lockKey) ?? Promise.resolve();
  const run  = prev.then(fn, fn);           // run regardless of how the previous one settled
  const tail = run.then(() => undefined, () => undefined);
  cartLocks.set(lockKey, tail);
  void tail.then(() => {
    if (cartLocks.get(lockKey) === tail) cartLocks.delete(lockKey); // bound the map
  });
  return run;
}

// ── Tool implementations ──────────────────────────────────────────────────────

export async function resolveItemLocal(
  tenantId: string,
  sessionId: string,
  params: { dish_query: string; modifiers?: string[]; quantity?: number; notes?: string | null },
): Promise<ResolveItemResponse> {
  const menu = await getLocalMenu(tenantId);

  if (menu) {
    const qty   = params.quantity || 1;
    const mods  = (params.modifiers ?? []).filter(Boolean);
    const match = fuzzyMatchItem(params.dish_query, menu.items);

    if (!match) {
      return {
        status: 'not_found', cart_item_id: null, summary: null, unit_price: null,
        ai_instruction: `I couldn't find '${params.dish_query}' on the menu. Could you clarify?`,
      };
    }

    const cat        = menu.categories.find(c => c.id === match.categoryId);
    const summary    = mods.length > 0 ? `${match.name} × ${qty} (${mods.join(', ')})` : `${match.name} × ${qty}`;
    const cartItemId = crypto.randomUUID();

    try {
      const cartKey = redisKey.localCart(tenantId, sessionId);
      await withCartLock(cartKey, async () => {
        const redis    = getRedis();
        const existing = (await redis.get<LocalCartItem[]>(cartKey)) ?? [];
        await redis.set(cartKey, [...existing, {
          cart_item_id: cartItemId, name: match.name, category: cat?.name ?? '',
          summary, quantity: qty, unit_price: match.price, modifiers: mods, notes: params.notes ?? null,
        }], { ex: TTL.LOCAL_CART });
      });
    } catch { /* non-fatal */ }

    console.log(`[DISPATCH] resolve-item: "${params.dish_query}" → "${match.name}" for tenant ${tenantId}`);
    return { status: 'ok', summary, unit_price: match.price, cart_item_id: cartItemId };
  }

  // Adapter path (Render backend or custom API)
  const { adapter } = await loadAdapterForTenant(tenantId);
  return await adapter.resolveItem({
    sessionId, dishQuery: params.dish_query,
    modifiers: params.modifiers, quantity: params.quantity, notes: params.notes,
  }) as ResolveItemResponse;
}

/**
 * Read the current cart for a session, normalised to the local shape.
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
  const menu = await getLocalMenu(tenantId);

  if (menu) {
    const items = await getRedis()
      .get<LocalCartItem[]>(redisKey.localCart(tenantId, sessionId))
      .catch(() => null) ?? [];
    return items.map(i => ({
      cart_item_id: i.cart_item_id,
      summary:      i.summary,
      quantity:     i.quantity,
      unit_price:   i.unit_price,
    }));
  }

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
  const menu = await getLocalMenu(tenantId);

  if (menu) {
    try {
      const cartKey = redisKey.localCart(tenantId, sessionId);
      await withCartLock(cartKey, async () => {
        const redis = getRedis();
        const items = (await redis.get<LocalCartItem[]>(cartKey)) ?? [];
        await redis.set(cartKey, items.filter(i => i.cart_item_id !== cartItemId), { ex: TTL.LOCAL_CART });
      });
    } catch { /* non-fatal */ }
    return;
  }

  const { adapter } = await loadAdapterForTenant(tenantId);
  await adapter.removeItem(sessionId, cartItemId);
}

export async function clearCartLocal(tenantId: string, sessionId: string): Promise<void> {
  const menu = await getLocalMenu(tenantId);

  if (menu) {
    const cartKey = redisKey.localCart(tenantId, sessionId);
    try { await withCartLock(cartKey, async () => { await getRedis().del(cartKey); }); } catch { /* non-fatal */ }
    return;
  }

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
  config: TenantConfig,
): Promise<SubmitOrderResponse> {
  const menu = await getLocalMenu(tenantId);

  if (menu) {
    const redis   = getRedis();
    const cartKey = redisKey.localCart(tenantId, sessionId);
    // Under the lock: an add_item still in flight must land before we snapshot
    // the cart, or the customer is charged for an order missing an item.
    const items   = await withCartLock(cartKey, async () =>
      await redis.get<LocalCartItem[]>(cartKey).catch(() => null) ?? []);

    if (items.length === 0) throw new Error('Cart is empty');

    const subtotal = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
    const gst      = Math.round(subtotal * config.businessRules.gstRate);
    const total    = subtotal + gst;
    const orderNum = await redis.incr(redisKey.localOrderCounter(tenantId));
    const orderId  = crypto.randomUUID();
    const now      = new Date().toISOString();

    const order: LocalOrder = {
      id: orderId, order_number: orderNum, tenant_id: tenantId, status: 'pending',
      items, subtotal, total,
      customer_name:  params.customer_name  ?? 'Guest',
      customer_phone: params.customer_phone ?? '',
      order_type:     params.order_type     ?? 'delivery',
      payment_method: 'cash',
      notes: params.notes ?? params.instructions ?? null,
      created_at: now, updated_at: now,
    };

    await redis.set(redisKey.localOrder(orderId), order, { ex: TTL.LOCAL_ORDER });
    await redis.lpush(redisKey.localOrders(tenantId), orderId);
    try { await (redis as unknown as { ltrim(k: string, s: number, e: number): Promise<void> }).ltrim(redisKey.localOrders(tenantId), 0, 499); } catch { /* non-fatal */ }
    await redis.del(cartKey);

    console.log(`[DISPATCH] Order #${orderNum} submitted for tenant ${tenantId} via WhatsApp`);
    return { id: orderId, order_id: orderId, order_number: orderNum, total, summary: `Order #${orderNum}` };
  }

  // Adapter path
  const { adapter } = await loadAdapterForTenant(tenantId);
  const result = await adapter.submitOrder({
    sessionId, customerName: params.customer_name, customerPhone: params.customer_phone,
    orderType: params.order_type, instructions: params.instructions, notes: params.notes,
  });
  const orderId  = result.order_id ?? String(result.id ?? '');
  const orderNum = typeof result.order_number === 'number' ? result.order_number : Number(result.order_number ?? 0);
  return {
    id: orderId, order_id: orderId, order_number: orderNum,
    total: result.total ?? 0, summary: result.summary ?? `Order #${orderNum}`,
  };
}
