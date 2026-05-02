/**
 * geminiTools.ts  — AI tool declarations for the Savour Foods voice agent.
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

  The server will write the order to the database and return a confirmation message to read back.`,
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
      notes: {
        type: Type.STRING,
        description: "Any overall order notes, e.g. table number.",
      },
    },
    required: ["session_id"],
  },
};

export const allTools = [add_item, remove_item, clear_cart, confirm_order];

const MENU_CACHE_KEY = 'savour_menu_context_v1';

export async function fetchMenuContext(): Promise<string> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/agent/menu-context");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      if (text.trimStart().startsWith('{')) throw new Error('backend returned error JSON');
      localStorage.setItem(MENU_CACHE_KEY, text);
      return text;
    } catch (err) {
      console.warn(`fetchMenuContext attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
  const cached = localStorage.getItem(MENU_CACHE_KEY);
  if (cached) {
    console.warn('fetchMenuContext: using cached menu context');
    return cached;
  }
  console.error("fetchMenuContext: all attempts exhausted, no cache");
  return "";
}

export function buildSystemInstruction(menuContext: string): string {
  return `You are the voice-ordering assistant for a Savour Foods kiosk in Islamabad.
Your ONLY role is to help customers place their order using the official menu below.

${menuContext}

LANGUAGE:
- Understand and respond in English, Urdu, and Roman Urdu.
- "Aik special choice pulao, leg aur chest piece, boxed" → add_item("special choice pulao", ["leg piece", "chest piece", "boxed"])
- "Cola Next" or "Colla Next" is the cola drink (NOT Pepsi or Coke — those brands are not sold here).
- "Fizzup" or "Fizz Up" is the lemon/lime drink.

DRINK RULES:
- When a customer says "cola" or "coke"  → use "Cola Next" as the modifier.
- When a customer says "sprite" or "7up" → use "Fizzup" as the modifier.
- When a customer says "water"            → use "Savour Mineral Water" as the modifier.

ORDERING RULES:
1. Do NOT speak first. Wait for the customer to place an order.
2. When a customer orders an item, immediately call add_item with everything they said.
3. If add_item returns status="requires_input", speak the ai_instruction naturally to the customer.
4. Once they answer, call add_item again with the full modifiers list (both old and new answers).
5. When the customer is finished, read back a brief summary of their order and total, then ask for confirmation.
6. Only call confirm_order after they say yes/confirm/theek hai.
7. Be EXTREMELY concise. Confirm items with 2-3 words max once added successfully.
8. Never mention GST or tax unless asked (it is 15%, added at checkout).
`;
}
