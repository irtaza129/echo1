/**
 * geminiTools.ts  — AI tool declarations for the voice agent.
 *
 * System instruction is now built by PromptBuilder, not here.
 */

import { Type, FunctionDeclaration } from "@google/genai";

export function generateSessionId(): string {
  return crypto.randomUUID();
}

export const add_item: FunctionDeclaration = {
  name: "add_item",
  description: `Add a dish to the customer's order.

  Pass the dish name exactly as the customer said it — the server will fuzzy-match it.
  Pass ALL customisation details the customer mentioned as an array of plain strings.
  Examples of modifiers: ["leg piece", "boxed"], ["chest piece", "thigh piece"], ["cola next"], ["plain fries"].

  If the server responds with status="requires_input", speak the ai_instruction to the customer,
  wait for their answer, then call add_item again with the updated modifiers list.

  If the server responds with status="ok", confirm the item summary to the customer (2-3 words).`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      session_id: {
        type: Type.STRING,
        description: "The voice session ID (passed from the client, same for all calls in one session).",
      },
      dish_query: {
        type: Type.STRING,
        description: "Dish name as the customer said it. E.g. 'special choice pulao', 'krispo wings', 'single'.",
      },
      modifiers: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "ALL customisations mentioned: piece type, packaging, drink brand, size, add-ons, etc.",
      },
      quantity: {
        type: Type.INTEGER,
        description: "How many of this item the customer wants. Default 1.",
      },
      notes: {
        type: Type.STRING,
        description: "Any special instructions for this item.",
      },
    },
    required: ["session_id", "dish_query"],
  },
};

export const remove_item: FunctionDeclaration = {
  name: "remove_item",
  description:
    "Remove a specific item from the cart using its cart_item_id (returned by a previous add_item call).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      session_id: { type: Type.STRING },
      cart_item_id: {
        type: Type.STRING,
        description: "The cart_item_id returned when the item was added.",
      },
    },
    required: ["session_id", "cart_item_id"],
  },
};

export const clear_cart: FunctionDeclaration = {
  name: "clear_cart",
  description: "Remove ALL items from the cart and start the order fresh.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      session_id: { type: Type.STRING },
    },
    required: ["session_id"],
  },
};

export const confirm_order: FunctionDeclaration = {
  name: "confirm_order",
  description: `Finalise and submit the order after the customer explicitly confirms they are done.

  Always read back the full order summary and total BEFORE calling this.
  Only call this once the customer says something like "haan", "yes", "confirm", "theek hai".

  After the tool returns, read the result message back to the customer word-for-word — it contains their order summary and total.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      session_id: { type: Type.STRING },
      customer_name: {
        type: Type.STRING,
        description: "Customer's name if provided, otherwise use 'Guest'.",
      },
      customer_phone: {
        type: Type.STRING,
        description: "Customer's phone number if provided, otherwise use '0000000000'.",
      },
      order_type: {
        type: Type.STRING,
        description: "One of: dine_in, pickup, delivery. Default: dine_in.",
      },
      instructions: {
        type: Type.STRING,
        description: "Special cooking or dietary instructions for the entire order (e.g. 'extra spicy', 'no onions', 'allergy to nuts').",
      },
      notes: {
        type: Type.STRING,
        description: "Any other order notes, e.g. table number.",
      },
    },
    required: ["session_id"],
  },
};

export const allTools = [add_item, remove_item, clear_cart, confirm_order];

// ── Menu context cache ────────────────────────────────────────────────────────

const MENU_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Cache key is tenant-scoped so switching tenants never serves the wrong menu
function cacheKey(tenantId?: string) {
  return `menu_context_v2_${tenantId ?? 'default'}`;
}

interface MenuCacheEntry { text: string; cached_at: number }

function readCache(tenantId?: string): string | null {
  try {
    const raw = localStorage.getItem(cacheKey(tenantId));
    if (!raw) return null;
    const entry: MenuCacheEntry = JSON.parse(raw);
    if (Date.now() - entry.cached_at > MENU_CACHE_TTL_MS) return null;
    return entry.text;
  } catch {
    return null;
  }
}

function writeCache(text: string, tenantId?: string): void {
  try {
    localStorage.setItem(cacheKey(tenantId), JSON.stringify({ text, cached_at: Date.now() } satisfies MenuCacheEntry));
  } catch {
    // localStorage may be unavailable (private mode, storage quota exceeded)
  }
}

export async function fetchMenuContext(tenantId?: string): Promise<string> {
  const { tenantFetch } = await import('./apiClient');
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await tenantFetch('/api/agent/menu-context', { tenantIdOverride: tenantId });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      if (text.trimStart().startsWith('{')) throw new Error('backend returned error JSON');
      writeCache(text, tenantId);
      return text;
    } catch (err) {
      console.warn(`[MENU] fetchMenuContext attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
  const cached = readCache(tenantId);
  if (cached) {
    console.warn('[MENU] fetchMenuContext: using cached menu context (all attempts failed)');
    return cached;
  }
  console.error('[MENU] fetchMenuContext: all attempts exhausted, no cache available');
  return '';
}

