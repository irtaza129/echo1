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
 *
 * Both input types always answer with a TEXT message. This channel never
 * synthesises or returns audio: a voice note is transcribed and understood by
 * the model, and the reply goes back as text.
 */

import crypto from 'crypto';
import axios from 'axios';
import { getRedis, redisKey, TTL, WA_TTL } from '../src/lib/redis.js';
import { parseTenantConfig, type TenantConfig } from '../src/lib/tenantConfig.js';
import { PromptBuilder } from '../src/lib/PromptBuilder.js';
import { allTools } from '../src/lib/geminiTools.js';
import {
  resolveItemLocal, removeItemLocal, clearCartLocal, submitOrderLocal, getCartLocal,
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

// Gemini REST API types (matches the API JSON)
interface GeminiPart {
  text?:          string;
  // Gemini 3 marks internal reasoning parts with thought:true. They must never
  // be shown to the customer, and thoughtSignature must be echoed back verbatim
  // in the model turn or multi-step tool calling degrades.
  thought?:          boolean;
  thoughtSignature?: string;
  inlineData?:    { mimeType: string; data: string };
  functionCall?:  { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> };
}

interface GeminiContent { role: string; parts: GeminiPart[] }

interface GeminiResponse {
  candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

interface FunctionDeclarationLike {
  name: string;
  description?: string;
  parameters?: { type: unknown; properties?: Record<string, unknown>; required?: string[] };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * The kiosk runs `gemini-3.1-flash-live-preview`. That model is Live-API only
 * (`bidiGenerateContent`) — calling it over REST `generateContent` returns 404,
 * so WhatsApp cannot literally share the kiosk's model id. `gemini-3.1-flash`
 * does not exist; within the 3.1 generation the REST-capable options are
 * `gemini-3.1-pro-preview` (verified quota-0 on this key, same failure that
 * pushed this channel off gemini-2.0) and `gemini-3.1-flash-lite`, which is GA,
 * has a working grant, and handles tool calling plus inline audio. So the
 * WhatsApp channel runs the same 3.1 generation as the kiosk, flash-lite tier.
 * Override with WHATSAPP_GEMINI_MODEL if a plain 3.1 flash ships later.
 */
const GEMINI_MODEL   = process.env.WHATSAPP_GEMINI_MODEL || 'gemini-3.1-flash-lite';
const META_API_BASE  = 'https://graph.facebook.com/v20.0';
const MAX_TOOL_TURNS = 8;      // guard against infinite loops
const WA_TEXT_LIMIT  = 4096;   // Meta hard limit on a text message body
const MAX_AUDIO_BYTES = 12 * 1024 * 1024; // base64 inflates ~33%; keeps request under the 20 MB inline cap

// Tool declarations for this channel. The kiosk's declarations require
// session_id because the browser passes one; on WhatsApp the session is the
// customer's phone number and is injected server-side, so leaving session_id in
// the schema only forces the model to invent a value on every call.
const waTools: FunctionDeclarationLike[] = (allTools as unknown as FunctionDeclarationLike[]).map(tool => {
  if (!tool.parameters?.properties) return tool;
  const { session_id: _omit, ...properties } = tool.parameters.properties;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties,
      required: (tool.parameters.required ?? []).filter(r => r !== 'session_id'),
    },
  };
});

// ── Logging ───────────────────────────────────────────────────────────────────
// Masks a WA number to the last 4 digits so logs stay traceable without
// leaking full customer phone numbers.
function maskPhone(waNumber: string): string {
  return waNumber.length > 4 ? `***${waNumber.slice(-4)}` : waNumber;
}

function preview(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ── Tenant routing ────────────────────────────────────────────────────────────

async function findTenantByPhoneNumberId(phoneNumberId: string): Promise<TenantConfig | null> {
  const redis = getRedis();

  // 1. Cache hit
  const cachedId = await redis.get<string>(redisKey.waRouting(phoneNumberId)).catch(() => null);
  if (cachedId) {
    const cfg = await redis.get<unknown>(redisKey.tenantConfig(cachedId)).catch(() => null);
    if (cfg) {
      console.log(`[WA] Tenant routing cache hit: phoneNumberId=${phoneNumberId} → tenant=${cachedId}`);
      return parseTenantConfig(cfg);
    }
  }

  // 2. Scan all tenant configs for a matching wabaPhoneNumberId.
  //    Tenant count is small so a full scan is acceptable.
  console.log(`[WA] Tenant routing cache miss for phoneNumberId=${phoneNumberId} — scanning tenant configs`);
  const allIds = await redis.smembers(redisKey.tenantsIndex).catch(() => [] as string[]);
  for (const tenantId of allIds) {
    const raw = await redis.get<unknown>(redisKey.tenantConfig(tenantId)).catch(() => null);
    if (!raw) continue;
    try {
      const cfg = parseTenantConfig(raw);
      // Log every tenant that has a WhatsApp channel configured at all, match
      // or not — this is what makes an ID-mismatch or a not-actually-enabled
      // toggle visible instead of a silent "no match" across dozens of tenants.
      if (cfg.channels?.whatsapp) {
        console.log(`[WA] Scan: tenant=${tenantId} (${cfg.restaurantName}) has whatsapp channel: enabled=${cfg.channels.whatsapp.enabled} wabaPhoneNumberId=${JSON.stringify(cfg.channels.whatsapp.wabaPhoneNumberId)}`);
      }
      if (cfg.channels?.whatsapp?.wabaPhoneNumberId === phoneNumberId) {
        if (!cfg.channels.whatsapp.enabled) {
          console.warn(`[WA] Matched tenant=${tenantId} for phoneNumberId=${phoneNumberId} but WhatsApp channel is disabled in config`);
          continue;
        }
        console.log(`[WA] Resolved phoneNumberId=${phoneNumberId} → tenant=${tenantId} (${cfg.restaurantName})`);
        await redis.set(redisKey.waRouting(phoneNumberId), tenantId, { ex: WA_TTL.ROUTING }).catch(() => undefined);
        return cfg;
      }
    } catch (err) {
      console.warn(`[WA] Skipping tenant=${tenantId} — config failed to parse:`, (err as Error).message);
    }
  }
  console.warn(`[WA] No enabled tenant matched phoneNumberId=${phoneNumberId} across ${allIds.length} tenant config(s)`);
  return null;
}

// ── Message de-duplication ────────────────────────────────────────────────────
// Meta delivers webhooks at least once: any slow/failed ack is retried with the
// same message id. Without this guard a retry re-runs the tool loop and can add
// an item — or submit an order — twice.

async function claimMessage(messageId: string): Promise<boolean> {
  try {
    const res = await getRedis().set(`wa:msg:${messageId}`, '1', { nx: true, ex: WA_TTL.DEDUPE });
    return res !== null;
  } catch {
    // Redis unavailable — process the message rather than silently dropping it.
    return true;
  }
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

// ── Cart snapshot ─────────────────────────────────────────────────────────────

async function buildCartSnapshot(tenantId: string, sessionId: string): Promise<string> {
  try {
    const items = await getCartLocal(tenantId, sessionId);
    if (items.length === 0) return '\nCURRENT CART: empty.\n';
    const lines = items.map(i => `- ${i.summary} (cart_item_id: ${i.cart_item_id}, unit_price: ${i.unit_price})`);
    return `\nCURRENT CART (already added — do NOT re-add these; use the cart_item_id values for remove_item):\n${lines.join('\n')}\n`;
  } catch (err) {
    console.warn(`[WA] Cart snapshot unavailable for tenant=${tenantId}:`, (err as Error).message);
    return '';
  }
}

// ── Gemini text API ───────────────────────────────────────────────────────────

async function callGemini(
  apiKey: string,
  contents: GeminiContent[],
  systemInstruction: string,
  opts: { withTools: boolean } = { withTools: true },
): Promise<GeminiResponse> {
  const body = {
    contents,
    ...(opts.withTools ? { tools: [{ functionDeclarations: waTools }] } : {}),
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature: 0.3,
      // Ordering is a shallow task; low thinking keeps WhatsApp latency down.
      thinkingConfig: { thinkingLevel: 'low' },
    },
  };
  const start = Date.now();
  try {
    const { data } = await axios.post<GeminiResponse>(
      `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent`,
      body,
      { headers: { 'x-goog-api-key': apiKey }, timeout: 30_000 },
    );
    const finish = data.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP') {
      console.warn(`[WA] Gemini finishReason=${finish} blockReason=${data.promptFeedback?.blockReason ?? 'none'}`);
    }
    console.log(`[WA] Gemini call ok (${Date.now() - start}ms) model=${GEMINI_MODEL} tools=${opts.withTools}`);
    return data;
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? `${err.response?.status ?? 'no-response'} ${JSON.stringify(err.response?.data ?? err.message)}`
      : String(err);
    console.error(`[WA] Gemini call failed (${Date.now() - start}ms) model=${GEMINI_MODEL}:`, detail);
    throw err;
  }
}

// Customer-visible text only — reasoning parts (thought:true) are excluded.
function extractText(response: GeminiResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.filter(p => p.text && p.thought !== true).map(p => p.text!).join('').trim();
}

function extractFunctionCalls(response: GeminiResponse): Array<{ name: string; args: Record<string, unknown>; id?: string }> {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.filter(p => p.functionCall).map(p => p.functionCall!);
}

// ── Reply formatting ──────────────────────────────────────────────────────────

// Gemini emits markdown by default; WhatsApp renders none of it. Convert what
// maps cleanly (**bold** → *bold*) and strip the rest so customers do not see
// raw asterisks and hash marks.
function formatForWhatsApp(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkForWhatsApp(text: string): string[] {
  if (text.length <= WA_TEXT_LIMIT) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > WA_TEXT_LIMIT) {
    // Prefer a paragraph/line boundary so a chunk never splits mid-word.
    const window = rest.slice(0, WA_TEXT_LIMIT);
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at  = cut > WA_TEXT_LIMIT * 0.5 ? cut : WA_TEXT_LIMIT;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ── Tool execution ────────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  tenantId: string,
  sessionId: string,
  config: TenantConfig,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  try {
    let result: Record<string, unknown>;
    switch (name) {
      case 'add_item':
        result = await resolveItemLocal(tenantId, sessionId, {
          dish_query: args.dish_query as string,
          modifiers:  args.modifiers  as string[] | undefined,
          quantity:   args.quantity   as number   | undefined,
          notes:      args.notes      as string   | null | undefined,
        }) as unknown as Record<string, unknown>;
        break;

      case 'remove_item':
        await removeItemLocal(tenantId, sessionId, args.cart_item_id as string);
        result = { ok: true };
        break;

      case 'clear_cart':
        await clearCartLocal(tenantId, sessionId);
        result = { ok: true };
        break;

      case 'confirm_order':
        result = await submitOrderLocal(tenantId, sessionId, {
          customer_name:  args.customer_name  as string | undefined,
          customer_phone: args.customer_phone as string | undefined,
          order_type:     args.order_type     as string | undefined,
          instructions:   args.instructions   as string | null | undefined,
          notes:          args.notes          as string | null | undefined,
        }, config) as unknown as Record<string, unknown>;
        break;

      default:
        console.warn(`[WA] Tool call for unknown tool: ${name}`);
        return { error: `Unknown tool: ${name}` };
    }
    console.log(`[WA] Tool ${name} ok (${Date.now() - start}ms) args=${JSON.stringify(args)}`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WA] Tool ${name} failed (${Date.now() - start}ms) args=${JSON.stringify(args)}:`, msg);
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

  const body = text.trim();
  if (!body) { console.warn(`[WA] Refusing to send empty reply to ${maskPhone(to)}`); return; }

  // Meta rejects bodies over 4096 chars outright, so a long reply must be split.
  for (const chunk of chunkForWhatsApp(body)) {
    try {
      const { data } = await axios.post<{ messages?: Array<{ id: string }> }>(
        `${META_API_BASE}/${phoneNumberId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'text', text: { body: chunk } },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 },
      );
      console.log(`[WA] -> reply sent to ${maskPhone(to)} id=${data.messages?.[0]?.id ?? 'unknown'}: "${preview(chunk)}"`);
    } catch (err) {
      const detail = axios.isAxiosError(err)
        ? `${err.response?.status ?? 'no-response'} ${JSON.stringify(err.response?.data ?? err.message)}`
        : (err as Error).message;
      console.error(`[WA] Failed to send reply to ${maskPhone(to)}:`, detail);
      return; // don't fire later chunks out of order after a failure
    }
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
      maxContentLength: MAX_AUDIO_BYTES,
    });
    if (data.byteLength > MAX_AUDIO_BYTES) {
      console.error(`[WA] Media id=${mediaId} too large (${data.byteLength}B > ${MAX_AUDIO_BYTES}B) — rejecting`);
      return null;
    }
    const mimeType = meta.mime_type.split(';')[0].trim();
    console.log(`[WA] Media fetched: id=${mediaId} mimeType=${mimeType} size=${data.byteLength}B`);
    return { buffer: Buffer.from(data), mimeType };
  } catch (err) {
    console.error(`[WA] Failed to fetch media id=${mediaId}:`, (err as Error).message);
    return null;
  }
}

// ── Agent turn ────────────────────────────────────────────────────────────────
// One implementation for both text and voice notes: they differ only in the
// user part sent to Gemini and in what gets written to history. Both always
// answer with text.

async function runAgentTurn(
  config: TenantConfig,
  phoneNumberId: string,
  from: string,
  apiKey: string,
  userPart: GeminiPart,
  historyText: string,
  fallbackReply: string,
): Promise<void> {
  const tenantId  = config.tenantId;
  const sessionId = from; // stable per WA number
  const start     = Date.now();

  const [menuContext, cartSnapshot] = await Promise.all([
    getMenuContextServer(tenantId, config),
    buildCartSnapshot(tenantId, sessionId),
  ]);
  const systemPrompt = PromptBuilder.build({ ...config, channel: 'whatsapp' }, menuContext) + cartSnapshot;

  const history  = await loadHistory(from, tenantId);
  const contents: GeminiContent[] = [
    ...historyToContents(history),
    { role: 'user', parts: [userPart] },
  ];

  let response = await callGemini(apiKey, contents, systemPrompt);
  let turns = 0;

  while (extractFunctionCalls(response).length > 0 && turns < MAX_TOOL_TURNS) {
    turns++;
    const calls = extractFunctionCalls(response);
    console.log(`[WA] Turn ${turns}: ${calls.map(c => c.name).join(', ')} (${maskPhone(from)})`);

    // Echo the model turn back verbatim — this carries thoughtSignature, which
    // Gemini 3 requires to keep reasoning continuity across tool steps.
    contents.push({ role: 'model', parts: response.candidates![0].content!.parts });

    // Execute sequentially, not with Promise.all: these tools mutate one shared
    // cart, and a model that emits add_item twice in a turn would otherwise
    // race two read-modify-writes and silently drop an item. Order also matters
    // (add-then-remove must not reorder). There is nothing to gain from
    // parallelism here — each call is a millisecond-scale Redis write.
    const toolResponseParts: GeminiPart[] = [];
    for (const fc of calls) {
      toolResponseParts.push({
        functionResponse: {
          name:     fc.name,
          ...(fc.id ? { id: fc.id } : {}),
          response: await executeTool(fc.name, fc.args, tenantId, sessionId, config),
        },
      });
    }
    contents.push({ role: 'user', parts: toolResponseParts });

    response = await callGemini(apiKey, contents, systemPrompt);
  }

  // Loop exhausted while the model was still calling tools: it never produced a
  // customer-facing reply. Ask once more with tools disabled so the customer
  // gets a real answer instead of the generic fallback.
  if (turns >= MAX_TOOL_TURNS && extractFunctionCalls(response).length > 0) {
    console.warn(`[WA] Hit MAX_TOOL_TURNS=${MAX_TOOL_TURNS} for ${maskPhone(from)} tenant=${tenantId} — forcing a text-only reply`);
    contents.push({ role: 'model', parts: response.candidates![0].content!.parts });
    contents.push({ role: 'user', parts: [{ text: 'Summarise the order status for the customer now, in plain text. Do not call any tools.' }] });
    try {
      response = await callGemini(apiKey, contents, systemPrompt, { withTools: false });
    } catch { /* fall through to the fallback reply */ }
  }

  const reply = formatForWhatsApp(extractText(response)) || fallbackReply;

  // Persist condensed history (text only — tool mechanics not stored; the cart
  // snapshot above is what carries cart state between messages)
  await saveHistory(from, tenantId, [
    ...history,
    { role: 'user',  text: historyText },
    { role: 'model', text: reply },
  ]);

  console.log(`[WA] Message handled in ${Date.now() - start}ms (${turns} tool turn(s)) for ${maskPhone(from)}`);
  await sendWhatsAppReply(phoneNumberId, from, reply);
}

async function handleTextMessage(
  config: TenantConfig, phoneNumberId: string, from: string, text: string, apiKey: string,
): Promise<void> {
  console.log(`[WA] <- text from ${maskPhone(from)} tenant=${config.tenantId}: "${preview(text)}"`);
  await runAgentTurn(
    config, phoneNumberId, from, apiKey,
    { text },
    text,
    'Sorry, I could not process your request. Please try again.',
  );
}

async function handleAudioMessage(
  config: TenantConfig, phoneNumberId: string, from: string, mediaId: string, apiKey: string,
): Promise<void> {
  console.log(`[WA] <- audio from ${maskPhone(from)} tenant=${config.tenantId} mediaId=${mediaId}`);

  const media = await fetchMediaBuffer(mediaId);
  if (!media) {
    console.error(`[WA] Audio media fetch failed for ${maskPhone(from)} mediaId=${mediaId} — replying with fallback`);
    await sendWhatsAppReply(phoneNumberId, from, "Sorry, I couldn't process your voice message. Please try typing your order instead.");
    return;
  }

  await runAgentTurn(
    config, phoneNumberId, from, apiKey,
    { inlineData: { mimeType: media.mimeType, data: media.buffer.toString('base64') } },
    '[voice note]',
    'Sorry, I could not understand your voice message. Please try typing your order.',
  );
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
  // Same key as the kiosk interface, by design: one project, one quota, one
  // place to rotate. (A previous GEMINI_API_KEY2 split existed only to dodge a
  // gemini-2.0 free-tier quota grant of 0 — the 3.1 model does not need it.)
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('[WA] GEMINI_API_KEY not set — dropping webhook payload'); return; }

  const entries = payload.entry ?? [];
  console.log(`[WA] Webhook received: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);

  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const { metadata, messages, statuses } = change.value;
      if (statuses?.length) {
        console.log(`[WA] Received ${statuses.length} status update(s) for phoneNumberId=${metadata.phone_number_id} — ignored`);
      }
      if (!messages?.length) continue;

      const phoneNumberId = metadata.phone_number_id;
      console.log(`[WA] ${messages.length} message(s) for phoneNumberId=${phoneNumberId}`);

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
        // Hoisted: inside the type-narrowed branches below `msg` narrows to
        // `never` in the unsupported-type case, so read the common fields once.
        const msgFrom = msg.from;
        if (!(await claimMessage(msg.id))) {
          console.log(`[WA] Duplicate delivery of message id=${msg.id} — skipped`);
          continue;
        }
        console.log(`[WA] Dispatching ${msg.type} message id=${msg.id} from ${maskPhone(msgFrom)} → tenant=${config.tenantId}`);
        try {
          if (msg.type === 'text') {
            const body = msg.text.body.trim().toLowerCase();
            if (['cancel', 'restart', 'start over', 'reset', 'new order'].includes(body)) {
              console.log(`[WA] Reset command "${body}" from ${maskPhone(msg.from)} tenant=${config.tenantId}`);
              await clearCartLocal(config.tenantId, msg.from);
              await saveHistory(msg.from, config.tenantId, []);
              await sendWhatsAppReply(phoneNumberId, msg.from,
                `Starting fresh! Welcome to ${config.restaurantName}. What would you like to order?`);
            } else {
              await handleTextMessage(config, phoneNumberId, msg.from, msg.text.body, apiKey);
            }
          } else if (msg.type === 'audio') {
            await handleAudioMessage(config, phoneNumberId, msg.from, msg.audio.id, apiKey);
          } else {
            console.log(`[WA] Ignoring unsupported message type: ${JSON.stringify(msg)}`);
            await sendWhatsAppReply(phoneNumberId, msgFrom,
              'I can only read text messages and voice notes. Please type your order or send a voice note.');
          }
        } catch (err) {
          console.error(`[WA] Failed to handle message from ${maskPhone(msgFrom)} tenant=${config.tenantId}:`, (err as Error).message);
          await sendWhatsAppReply(phoneNumberId, msgFrom,
            'Sorry, something went wrong on our side. Please try again in a moment.');
        }
      }
    }
  }
}
