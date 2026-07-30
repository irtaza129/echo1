/**
 * WhatsAppHandler — Meta Cloud API webhook handler.
 *
 * Routing: a single Meta App webhook serves all tenants.
 * Each incoming message carries metadata.phone_number_id which identifies
 * the tenant's WhatsApp Business number. We look up the tenant from Redis
 * (cached 5 min) and dispatch to the correct AI + menu.
 *
 * Supports:
 *   - Text messages  → Gemini text API + tool loop → WhatsApp text reply
 *   - Audio messages → OGG/Opus inline to Gemini audio API → WhatsApp text reply
 */

import crypto from 'crypto';
import axios from 'axios';
import { getRedis, redisKey, TTL, WA_TTL } from '../src/lib/redis.js';
import { parseTenantConfig, type TenantConfig } from '../src/lib/tenantConfig.js';
import { PromptBuilder } from '../src/lib/PromptBuilder.js';
import { allTools } from '../src/lib/geminiTools.js';
import {
  resolveItemLocal, removeItemLocal, clearCartLocal, submitOrderLocal,
  loadAdapterForTenant,
} from './toolDispatch.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface WaTextMessage {
  id: string; type: 'text'; from: string;
  text: { body: string };
}

interface WaAudioMessage {
  id: string; type: 'audio'; from: string;
  audio: { id: string; mime_type: string };
}

interface WaWebhookPayload {
  object: string;
  entry: Array<{
    changes: Array<{
      value: {
        metadata:      { phone_number_id: string };
        messages?:     Array<WaTextMessage | WaAudioMessage>;
        statuses?:     unknown[];
      };
    }>;
  }>;
}

interface WaHistoryEntry { role: 'user' | 'model'; text: string }

// Gemini REST API types (snake_case, matches the API JSON)
interface GeminiPart {
  text?:          string;
  inlineData?:    { mimeType: string; data: string };
  functionCall?:  { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent { role: string; parts: GeminiPart[] }

interface GeminiResponse {
  candidates?: Array<{ content: GeminiContent }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL    = 'gemini-2.0-flash';
const META_API_BASE   = 'https://graph.facebook.com/v20.0';
const MAX_TOOL_TURNS  = 8; // guard against infinite loops

// ── Tenant routing ────────────────────────────────────────────────────────────

async function findTenantByPhoneNumberId(phoneNumberId: string): Promise<TenantConfig | null> {
  const redis = getRedis();

  // 1. Cache hit
  const cachedId = await redis.get<string>(redisKey.waRouting(phoneNumberId)).catch(() => null);
  if (cachedId) {
    const cfg = await redis.get<unknown>(redisKey.tenantConfig(cachedId)).catch(() => null);
    if (cfg) return parseTenantConfig(cfg);
  }

  // 2. Scan all tenant configs for a matching wabaPhoneNumberId.
  //    Tenant count is small so a full scan is acceptable.
  const allIds = await redis.smembers(redisKey.tenantsIndex).catch(() => [] as string[]);
  for (const tenantId of allIds) {
    const raw = await redis.get<unknown>(redisKey.tenantConfig(tenantId)).catch(() => null);
    if (!raw) continue;
    try {
      const cfg = parseTenantConfig(raw);
      if (cfg.channels?.whatsapp?.wabaPhoneNumberId === phoneNumberId && cfg.channels?.whatsapp?.enabled) {
        await redis.set(redisKey.waRouting(phoneNumberId), tenantId, { ex: WA_TTL.ROUTING }).catch(() => undefined);
        return cfg;
      }
    } catch { /* invalid config — skip */ }
  }
  return null;
}

// ── Menu context (server-side) ────────────────────────────────────────────────

async function getMenuContextServer(tenantId: string, config: TenantConfig): Promise<string> {
  const redis = getRedis();
  try {
    const cached = await redis.get<string>(redisKey.menuContext(tenantId));
    if (cached) return cached;
  } catch { /* fall through */ }

  // Cache miss — try adapter (covers Render-backend tenants like Savour Foods)
  try {
    const { adapter } = await loadAdapterForTenant(tenantId);
    const text = await adapter.getMenuContext();
    if (text) {
      await redis.set(redisKey.menuContext(tenantId), text, { ex: TTL.MENU_CONTEXT }).catch(() => undefined);
      return text;
    }
  } catch { /* non-fatal */ }

  return `# ${config.restaurantName} Menu\n\n(Menu temporarily unavailable)`;
}

// ── Gemini text API ───────────────────────────────────────────────────────────

async function callGemini(
  apiKey: string,
  contents: GeminiContent[],
  systemInstruction: string,
): Promise<GeminiResponse> {
  const body = {
    contents,
    tools: [{ functionDeclarations: allTools }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { temperature: 0.3 },
  };
  const { data } = await axios.post<GeminiResponse>(
    `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent`,
    body,
    { headers: { 'x-goog-api-key': apiKey }, timeout: 30_000 },
  );
  return data;
}

function extractText(response: GeminiResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.filter(p => p.text).map(p => p.text!).join('').trim();
}

function extractFunctionCalls(response: GeminiResponse): Array<{ name: string; args: Record<string, unknown> }> {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.filter(p => p.functionCall).map(p => p.functionCall!);
}

// ── Tool execution ────────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  tenantId: string,
  sessionId: string,
  config: TenantConfig,
): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case 'add_item':
        return await resolveItemLocal(tenantId, sessionId, {
          dish_query: args.dish_query as string,
          modifiers:  args.modifiers  as string[] | undefined,
          quantity:   args.quantity   as number   | undefined,
          notes:      args.notes      as string   | null | undefined,
        }) as unknown as Record<string, unknown>;

      case 'remove_item':
        await removeItemLocal(tenantId, sessionId, args.cart_item_id as string);
        return { ok: true };

      case 'clear_cart':
        await clearCartLocal(tenantId, sessionId);
        return { ok: true };

      case 'confirm_order':
        return await submitOrderLocal(tenantId, sessionId, {
          customer_name:  args.customer_name  as string | undefined,
          customer_phone: args.customer_phone as string | undefined,
          order_type:     args.order_type     as string | undefined,
          instructions:   args.instructions   as string | null | undefined,
          notes:          args.notes          as string | null | undefined,
        }, config) as unknown as Record<string, unknown>;

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WA] Tool ${name} failed:`, msg);
    return { error: msg };
  }
}

// ── History ───────────────────────────────────────────────────────────────────

async function loadHistory(waNumber: string, tenantId: string): Promise<WaHistoryEntry[]> {
  try {
    return (await getRedis().get<WaHistoryEntry[]>(redisKey.waHistory(waNumber, tenantId))) ?? [];
  } catch { return []; }
}

async function saveHistory(waNumber: string, tenantId: string, history: WaHistoryEntry[]): Promise<void> {
  try {
    const trimmed = history.slice(-20); // keep last 20 turns
    await getRedis().set(redisKey.waHistory(waNumber, tenantId), trimmed, { ex: WA_TTL.HISTORY });
  } catch { /* non-fatal */ }
}

function historyToContents(history: WaHistoryEntry[]): GeminiContent[] {
  return history.map(h => ({
    role:  h.role === 'user' ? 'user' : 'model',
    parts: [{ text: h.text }],
  }));
}

// ── Meta Graph API ────────────────────────────────────────────────────────────

async function sendWhatsAppReply(phoneNumberId: string, to: string, text: string): Promise<void> {
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!token) { console.error('[WA] META_WHATSAPP_TOKEN not set — cannot send reply'); return; }
  try {
    await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 },
    );
  } catch (err) {
    console.error('[WA] Failed to send reply:', (err as Error).message);
  }
}

async function fetchMediaBuffer(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!token) return null;
  try {
    // Step 1: get the media URL
    const { data: meta } = await axios.get<{ url: string; mime_type: string }>(
      `${META_API_BASE}/${mediaId}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 },
    );
    // Step 2: download the binary
    const { data } = await axios.get<ArrayBuffer>(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: 30_000,
    });
    return { buffer: Buffer.from(data), mimeType: meta.mime_type.split(';')[0].trim() };
  } catch (err) {
    console.error('[WA] Failed to fetch media:', (err as Error).message);
    return null;
  }
}

// ── Message handlers ──────────────────────────────────────────────────────────

async function handleTextMessage(
  config: TenantConfig,
  phoneNumberId: string,
  from: string,
  text: string,
  apiKey: string,
): Promise<void> {
  const tenantId  = config.tenantId;
  const sessionId = from; // stable per WA number

  const menuContext  = await getMenuContextServer(tenantId, config);
  const systemPrompt = PromptBuilder.build({ ...config, channel: 'whatsapp' }, menuContext);

  const history  = await loadHistory(from, tenantId);
  const contents: GeminiContent[] = [
    ...historyToContents(history),
    { role: 'user', parts: [{ text }] },
  ];

  let response = await callGemini(apiKey, contents, systemPrompt);
  let turns = 0;

  while (extractFunctionCalls(response).length > 0 && turns < MAX_TOOL_TURNS) {
    turns++;
    const calls = extractFunctionCalls(response);

    // Append model turn (may have both text and function calls)
    contents.push({ role: 'model', parts: response.candidates![0].content.parts });

    // Execute all tool calls and collect responses
    const toolResponseParts: GeminiPart[] = await Promise.all(
      calls.map(async fc => ({
        functionResponse: {
          name:     fc.name,
          response: await executeTool(fc.name, fc.args, tenantId, sessionId, config),
        },
      })),
    );
    contents.push({ role: 'user', parts: toolResponseParts });

    response = await callGemini(apiKey, contents, systemPrompt);
  }

  const reply = extractText(response) || 'Sorry, I could not process your request. Please try again.';

  // Persist condensed history (text only — tool mechanics not stored)
  const updated: WaHistoryEntry[] = [
    ...history,
    { role: 'user',  text },
    { role: 'model', text: reply },
  ];
  await saveHistory(from, tenantId, updated);

  await sendWhatsAppReply(phoneNumberId, from, reply);
}

async function handleAudioMessage(
  config: TenantConfig,
  phoneNumberId: string,
  from: string,
  mediaId: string,
  apiKey: string,
): Promise<void> {
  const tenantId  = config.tenantId;
  const sessionId = from;

  const media = await fetchMediaBuffer(mediaId);
  if (!media) {
    await sendWhatsAppReply(phoneNumberId, from, "Sorry, I couldn't process your voice message. Please try typing your order instead.");
    return;
  }

  const menuContext  = await getMenuContextServer(tenantId, config);
  const systemPrompt = PromptBuilder.build({ ...config, channel: 'whatsapp' }, menuContext);

  const history  = await loadHistory(from, tenantId);
  const contents: GeminiContent[] = [
    ...historyToContents(history),
    {
      role: 'user',
      parts: [{
        inlineData: { mimeType: media.mimeType, data: media.buffer.toString('base64') },
      }],
    },
  ];

  let response = await callGemini(apiKey, contents, systemPrompt);
  let turns = 0;

  while (extractFunctionCalls(response).length > 0 && turns < MAX_TOOL_TURNS) {
    turns++;
    const calls = extractFunctionCalls(response);
    contents.push({ role: 'model', parts: response.candidates![0].content.parts });

    const toolResponseParts: GeminiPart[] = await Promise.all(
      calls.map(async fc => ({
        functionResponse: {
          name:     fc.name,
          response: await executeTool(fc.name, fc.args, tenantId, sessionId, config),
        },
      })),
    );
    contents.push({ role: 'user', parts: toolResponseParts });

    response = await callGemini(apiKey, contents, systemPrompt);
  }

  const reply = extractText(response) || 'Sorry, I could not understand your voice message. Please try typing your order.';

  const updated: WaHistoryEntry[] = [
    ...history,
    { role: 'user',  text: '[voice note]' },
    { role: 'model', text: reply },
  ];
  await saveHistory(from, tenantId, updated);

  await sendWhatsAppReply(phoneNumberId, from, reply);
}

// ── Public webhook handler ────────────────────────────────────────────────────

export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch { return false; }
}

export async function handleWebhook(payload: WaWebhookPayload): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('[WA] GEMINI_API_KEY not set'); return; }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const { metadata, messages } = change.value;
      if (!messages?.length) continue;

      const phoneNumberId = metadata.phone_number_id;

      let config: TenantConfig | null = null;
      try {
        config = await findTenantByPhoneNumberId(phoneNumberId);
      } catch (err) {
        console.error(`[WA] Tenant lookup failed for phoneNumberId ${phoneNumberId}:`, (err as Error).message);
      }
      if (!config) {
        console.warn(`[WA] No tenant found for phoneNumberId ${phoneNumberId} — message dropped`);
        continue;
      }

      for (const msg of messages) {
        try {
          if (msg.type === 'text') {
            const body = msg.text.body.trim().toLowerCase();
            if (['cancel', 'restart', 'start over', 'reset', 'new order'].includes(body)) {
              await clearCartLocal(config.tenantId, msg.from);
              await saveHistory(msg.from, config.tenantId, []);
              await sendWhatsAppReply(phoneNumberId, msg.from,
                `Starting fresh! Welcome to ${config.restaurantName}. What would you like to order?`);
            } else {
              await handleTextMessage(config, phoneNumberId, msg.from, msg.text.body, apiKey);
            }
          } else if (msg.type === 'audio') {
            await handleAudioMessage(config, phoneNumberId, msg.from, msg.audio.id, apiKey);
          }
          // status updates and other types are silently ignored
        } catch (err) {
          console.error(`[WA] Failed to handle ${msg.type} from ${msg.from}:`, (err as Error).message);
        }
      }
    }
  }
}
