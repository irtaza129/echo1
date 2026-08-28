import { getRedis, redisKey, TTL } from './redis.js';
import { withCartLock } from './cartLock.js';
import type { WireCartItem } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// The session cart — one implementation, shared by every adapter that keeps a
// basket of its own.
//
// This lived inside PosAdapter as five private methods until `managed` tenants
// needed the same thing. Copying it would have given the product two cart
// stores with two lock strategies and two TTLs for one concept; the upstream's
// own cart is being retired precisely because a second store is where baskets
// go missing. So it moves here rather than being duplicated.
//
// Redis is the right home for this and, unusually, is not a cache of anything:
// a cart exists only between "add item" and "pay", so a TTL is how an abandoned
// kiosk session is cleaned up. Nothing is lost when it expires. That is not in
// tension with non-negotiable #2 — the cart is not a record, and the moment it
// becomes one (submitOrder) it is written to Postgres and the cart is dropped.
//
// Every read degrades to an empty cart rather than throwing. Callers pair that
// with an inline cart from the request body, so a Redis outage costs line
// detail on the receipt and never the sale itself.
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionCartItem {
  cart_item_id: string;
  /**
   * The dishes.id this line resolved to, or null when the matcher that built it
   * could not say. order_items.dish_id is what kitchen station routing joins on
   * (see kdsRepo), so a null here means the line prints on no station's board.
   */
  dish_id:      number | null;
  name:         string;
  category:     string | null;
  summary:      string;
  quantity:     number;
  unit_price:   number;
  modifiers:    { option_name?: string; choice_name: string }[];
  notes:        string | null;
}

export function sessionCartKey(tenantId: string, sessionId: string): string {
  return redisKey.localCart(tenantId, sessionId);
}

/** The cart as stored, or empty. Never throws — see the header. */
export async function readCart(key: string): Promise<SessionCartItem[]> {
  try {
    return (await getRedis().get<SessionCartItem[]>(key)) ?? [];
  } catch {
    return [];
  }
}

/** Replace the cart. Never throws: a Redis blip must not block a sale. */
export async function writeCart(key: string, items: SessionCartItem[]): Promise<void> {
  try {
    await getRedis().set(key, items, { ex: TTL.LOCAL_CART });
  } catch {
    // Non-fatal by design — the caller keeps its own copy and submitOrder
    // accepts an inline cart.
  }
}

/**
 * Append one line under the cart lock.
 *
 * The lock is the point: a model that emits two add_item calls in one turn
 * would otherwise have both read the same pre-state, and the second write would
 * discard the first item. That is how "a pulao and a coke" becomes just a coke.
 */
export async function appendCartItem(key: string, item: SessionCartItem): Promise<void> {
  await withCartLock(key, async () => {
    await writeCart(key, [...await readCart(key), item]);
  });
}

/** Drop one line under the lock. Returns whether the line was there to drop. */
export async function removeCartItem(key: string, cartItemId: string): Promise<boolean> {
  return withCartLock(key, async () => {
    const cart = await readCart(key);
    const kept = cart.filter(i => i.cart_item_id !== cartItemId);
    if (kept.length === cart.length) return false;
    await writeCart(key, kept);
    return true;
  });
}

export async function clearCart(key: string): Promise<void> {
  try {
    await getRedis().del(key);
  } catch { /* non-fatal */ }
}

/**
 * Read the cart under the lock, for the one caller that must not race it.
 *
 * submitOrder needs this and a plain read will not do: an add_item still in
 * flight has to land before the snapshot, or the customer pays for an order
 * missing its last item.
 */
export async function snapshotCart(key: string): Promise<SessionCartItem[]> {
  return withCartLock(key, () => readCart(key));
}

/** The wire shape the kiosk, guest app and voice tools all consume. */
export function toWireCartItems(items: SessionCartItem[]): WireCartItem[] {
  return items.map(i => ({
    cart_item_id: i.cart_item_id,
    dish_name:    i.name,
    quantity:     i.quantity,
    unit_price:   i.unit_price,
    summary:      i.summary,
    notes:        i.notes,
    dish_id:      i.dish_id,
  }));
}
