/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { AudioPlayer, AudioRecorder } from './lib/audioUtils';
import {
  allTools,
  generateSessionId,
  fetchMenuContext,
} from './lib/geminiTools';
import { tenantFetch } from './lib/apiClient';
import { openOrderCheckout } from './lib/paddleCheckout';
import { PromptBuilder } from './lib/PromptBuilder';
import type { PromptConfig } from './lib/PromptBuilder';
import type { TranscriptTurn, ToolCallRecord } from './lib/types';

// ── Tenant config ─────────────────────────────────────────────────────────────

// Shape of what GET /api/tenant-config/:slug returns (non-sensitive fields only).
// Extends PromptConfig so PromptBuilder.build() accepts it directly.
interface PublicTenantConfig extends PromptConfig {
  tenantId?: string;
  branding: {
    primaryColor: string;
    logoUrl:      string;
    kioskTitle:   string;
  };
  businessRules: {
    gstRate:            number;
    currencySymbol:     string;
    orderStatusMachine: string[];
  };
  features: {
    deliveryOrders:   boolean;
    tableNumbers:     boolean;
    transcriptScreen: boolean;
    loyaltyPoints:    boolean;
  };
  // Non-secret half of the tenant's payment settings — just which gateway, so
  // the kiosk knows whether card is offerable. Gateway keys stay server-side.
  payments?: {
    provider: 'cash' | 'safepay' | 'paddle';
  };
  setupComplete?: boolean;
  setupStep?:     number;
}

// Fallback used while the fetch is in-flight and on fetch failure.
const DEFAULT_TENANT_CONFIG: PublicTenantConfig = {
  restaurantName: 'Savour Foods',
  gemini: {
    agentName:          'Savour Assistant',
    voice:              'Puck',
    languages:          ['en', 'ur', 'roman-ur'],
    systemPromptExtras: '',
  },
  branding: {
    primaryColor: '#C8102E',
    logoUrl:      '',
    kioskTitle:   'Welcome to Savour Foods',
  },
  businessRules: {
    gstRate:            0.15,
    currencySymbol:     'PKR',
    orderStatusMachine: ['pending','confirmed','preparing','ready','out_for_delivery','delivered'],
  },
  features: {
    deliveryOrders:   false,
    tableNumbers:     true,
    transcriptScreen: true,
    loyaltyPoints:    false,
  },
};

// ── Types ─────────────────────────────────────────────────────────────────────

type CartItem = {
  cart_item_id: string;
  dish_id: number;
  summary: string;
  quantity: number;
  unit_price: number;
  notes?: string;
  selected_options: { option_id: number; sub_option_id: number }[];
};

interface MenuItem {
  id: string;
  name: string;
  description?: string;
  price?: number;
  base_price?: number;
  display_price?: number;
  tag?: string;
  category: string;
}

interface MenuCategory {
  name: string;
  sub_categories: { dishes: Omit<MenuItem, 'category'>[] }[];
}

interface ResolveItemResponse {
  status: 'ok' | 'requires_input';
  summary?: string;
  unit_price?: number;
  cart_item_id?: string;
  dish_id?: number;
  selected_options?: { option_id: number; sub_option_id: number }[];
  ai_instruction?: string;
}

interface SubmitOrderResponse {
  id?: number;
  order_id?: string;
  order_number?: string | number;
  summary?: string;
  total?: number;
  error?: string;
  // Present only when the tenant collects online and the order was placed as
  // card. `clientToken` is the Paddle transaction id to open in the overlay;
  // `redirectUrl` is the hosted-checkout fallback for redirect-based gateways.
  payment?: {
    providerRef:  string;
    redirectUrl?: string;
    clientToken?: string;
    status:       string;
  };
}

// Structural interface covering only the session methods this component calls.
interface GeminiLiveSession {
  sendRealtimeInput(input: {
    audio?: { data: string; mimeType: string };
    audioStreamEnd?: boolean;
  }): void;
  sendClientContent(input: {
    turns: { role: string; parts: { text: string }[] }[];
    turnComplete: boolean;
  }): void;
  sendToolResponse(response: { functionResponses: unknown[] }): void;
  close(): void;
}

type AppStatus =
  | 'IDLE'
  | 'CONNECTING'
  | 'RECORDING'
  | 'SPEAKING'
  | 'ORDER_CONFIRMED'
  | 'SUBMITTING'
  | 'AWAITING_PAYMENT'
  | 'PAYMENT_PROCESSING'
  | string;

const STATUS_LABEL: Record<string, string> = {
  IDLE:               'Tap the mic to speak your order',
  CONNECTING:         'Connecting to AI...',
  RECORDING:          'Recording — tap to stop',
  SPEAKING:           'Responding...',
  ORDER_CONFIRMED:    'Order confirmed!',
  SUBMITTING:         'Submitting order...',
  AWAITING_PAYMENT:   'Complete your card payment in the window',
  PAYMENT_PROCESSING: 'Confirming payment...',
};

function getStatusLabel(status: AppStatus): string {
  return STATUS_LABEL[status] ?? status;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function App({
  tenantSlug,
  onNavigateToDashboard,
  onNavigateToTranscripts,
  onNavigateToAdmin,
  onLogout,
  onTurnComplete,
}: {
  tenantSlug?:              string;
  onNavigateToDashboard?:  () => void;
  onNavigateToTranscripts?: () => void;
  onNavigateToAdmin?:       () => void;
  onLogout?:                () => void;
  onTurnComplete?:          (turn: TranscriptTurn) => void;
}) {
  const [tenantConfig, setTenantConfig] = useState<PublicTenantConfig>(DEFAULT_TENANT_CONFIG);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [status, setStatus] = useState<AppStatus>('IDLE');
  const [isConnected, setIsConnected] = useState(false);
  const [showMobileCart, setShowMobileCart] = useState(false);
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(false);
  const [manualOrderType, setManualOrderType] = useState<'dine_in' | 'pickup' | 'delivery'>('dine_in');
  const [setupToast, setSetupToast]     = useState<{ stepName: string; stepsLeft: number } | null>(null);
  const [toastTimer, setToastTimer]     = useState(15);

  const sessionIdRef      = useRef<string>(generateSessionId());
  const tenantConfigRef   = useRef<PublicTenantConfig>(DEFAULT_TENANT_CONFIG);
  const tenantIdRef       = useRef<string>('');
  const menuContextRef    = useRef<string>('');
  const sessionRef      = useRef<GeminiLiveSession | null>(null);
  const recorderRef     = useRef<AudioRecorder | null>(null);
  const playerRef       = useRef<AudioPlayer | null>(null);
  const isRecordingRef  = useRef(false);
  const isSpeakingRef   = useRef(false);
  const isConnectingRef = useRef(false);
  const cartRef         = useRef<CartItem[]>([]);

  const transcriptionEnabledRef = useRef(false);
  const turnIndexRef  = useRef(0);
  const turnBufferRef = useRef<{
    customerText: string; aiText: string;
    toolCalls: ToolCallRecord[];
    promptTokens: number; responseTokens: number; costUsd: number;
  }>({ customerText: '', aiText: '', toolCalls: [], promptTokens: 0, responseTokens: 0, costUsd: 0 });

  const isRecording = status === 'RECORDING';

  // Keep tenantConfigRef in sync for connectToGemini closures (avoids stale config)
  useEffect(() => { tenantConfigRef.current = tenantConfig; }, [tenantConfig]);

  // Countdown timer for setup toast — ticks every second, dismisses at 0
  useEffect(() => {
    if (!setupToast) return;
    if (toastTimer <= 0) { setSetupToast(null); return; }
    const id = setTimeout(() => setToastTimer(t => t - 1), 1000);
    return () => clearTimeout(id);
  }, [setupToast, toastTimer]);


  // Keep cartRef in sync so the confirm_order closure always sees current cart
  useEffect(() => { cartRef.current = cart; }, [cart]);

  // Keep transcriptionEnabledRef in sync for onmessage closures
  useEffect(() => { transcriptionEnabledRef.current = transcriptionEnabled; }, [transcriptionEnabled]);

  useEffect(() => {
    recorderRef.current = new AudioRecorder();
    playerRef.current   = new AudioPlayer();

    playerRef.current.onQueueEmpty = () => {
      isSpeakingRef.current = false;
      setStatus('IDLE');
    };

    // JWT prop takes precedence — authenticated users always see their own tenant's kiosk.
    // URL slug is the fallback for unauthenticated direct access (e.g. customer scanning a QR code).
    // Never read the URL first: the URL-sync effect in main.tsx fires AFTER this child effect,
    // so window.location.pathname may still be stale at this point.
    const urlSlug = window.location.pathname.match(/^\/kiosk\/([a-z0-9-]+)/)?.[1];
    const slug = tenantSlug ?? urlSlug ?? 'savour-foods';

    // Fetch tenant config first so we have the tenantId for all subsequent calls
    fetch(`/api/tenant-config/${slug}`)
      .then(r => r.ok ? r.json() as Promise<PublicTenantConfig> : Promise.reject(r.status))
      .then(async cfg => {
        setTenantConfig(cfg);
        tenantConfigRef.current = cfg;
        const tid = cfg.tenantId ?? '';
        tenantIdRef.current = tid;
        if (cfg.features.transcriptScreen) setTranscriptionEnabled(true);

        // Show setup toast only for admin users who haven't finished setup
        if (onNavigateToAdmin && !cfg.setupComplete) {
          const STEP_NAMES = ['Restaurant','Plan','Adapter','Test','Menu','AI Persona','Rules','Launch'];
          const savedStep  = cfg.setupStep ?? 0;
          const stepName   = STEP_NAMES[savedStep] ?? 'Restaurant';
          const stepsLeft  = STEP_NAMES.length - savedStep;
          setSetupToast({ stepName, stepsLeft });
          setToastTimer(15);
        }

        // Pre-load menu context for Gemini (with tenant header)
        fetchMenuContext(tid).then(ctx => { menuContextRef.current = ctx; });

        // Structured menu for the UI grid — 3 attempts with backoff
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            const r = await tenantFetch('/api/menu', { tenantIdOverride: tid });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json() as MenuCategory[];
            const dishes: MenuItem[] = [];
            for (const cat of (Array.isArray(data) ? data : [])) {
              for (const sub of (cat.sub_categories ?? [])) {
                for (const dish of (sub.dishes ?? [])) dishes.push({ ...dish, category: cat.name });
              }
              // Also handle flat admin-panel format: { id, name, items[] }
              const catAny = cat as unknown as { items?: MenuItem[] };
              if (catAny.items) {
                for (const item of catAny.items) dishes.push({ ...item, category: cat.name });
              }
            }
            setMenu(dishes);
            const cats = [...new Set(dishes.map(d => d.category))];
            if (cats.length > 0) setSelectedCategory(prev => (prev && cats.includes(prev)) ? prev : cats[0]);
            return;
          } catch (err) {
            console.warn(`[MENU] fetch attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
            if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 1500));
          }
        }
        console.error('[MENU] Failed to load menu after all attempts');
      })
      .catch(err => {
        console.warn('[TENANT] Failed to load config, using defaults:', err);
        // Still try to load menu context with no tenant (defaults to Savour Foods)
        fetchMenuContext().then(ctx => { menuContextRef.current = ctx; });
      });

    return () => {
      recorderRef.current?.destroy();
      playerRef.current?.stop();
      sessionRef.current?.close();
    };
  }, []);

  const connectToGemini = useCallback(async () => {
    setStatus('CONNECTING');
    turnIndexRef.current  = 0;
    turnBufferRef.current = { customerText: '', aiText: '', toolCalls: [], promptTokens: 0, responseTokens: 0, costUsd: 0 };

    // Fetch a short-lived ephemeral token from the server.
    // The real GEMINI_API_KEY never leaves the server process — the browser
    // only ever sees this token, which expires in 60 seconds.
    const tid = tenantIdRef.current;

    let ephemeralToken: string;
    try {
      const r = await tenantFetch('/api/gemini-token', { method: 'POST', tenantIdOverride: tid });
      if (!r.ok) throw new Error(`/api/gemini-token returned ${r.status}`);
      ({ ephemeralToken } = await r.json() as { ephemeralToken: string });
      if (!ephemeralToken) throw new Error('No ephemeralToken in server response');
    } catch (err) {
      console.error('[INIT] Failed to obtain Gemini token:', err);
      throw err;
    }

    if (!menuContextRef.current) {
      menuContextRef.current = await fetchMenuContext(tenantIdRef.current || undefined);
    }
    const tcfg = tenantConfigRef.current;
    const sysInstruction = PromptBuilder.build(
      {
        ...tcfg,
        // The agent only offers card when a gateway is actually configured.
        acceptsCard: Boolean(tcfg.payments && tcfg.payments.provider !== 'cash'),
      },
      menuContextRef.current,
    );

    // Ephemeral tokens only work with v1alpha of the Gemini Live API.
    const ai = new GoogleGenAI({ apiKey: ephemeralToken, httpOptions: { apiVersion: 'v1alpha' } });

    await new Promise<void>((resolve, reject) => {
      let pendingSession: GeminiLiveSession | null = null;
      let wsOpen = false;

      const tryResolve = () => {
        if (pendingSession && wsOpen) {
          sessionRef.current = pendingSession;
          resolve();
        }
      };

      ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: tenantConfigRef.current.gemini.voice } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: sysInstruction,
          tools: [{ functionDeclarations: allTools }],
        },
        callbacks: {
          onopen: () => {
            console.log('[WS] onopen fired');
            setIsConnected(true);
            wsOpen = true;
            tryResolve();
          },
          onmessage: async (message: LiveServerMessage) => {
            console.log('[MSG]', JSON.stringify(message).slice(0, 300));
            // Token usage — logged whenever Gemini includes usageMetadata in a message.
            // Pricing reference: gemini-3.1-flash-live-preview (verify at ai.google.dev/pricing).
            // Update these constants if Google revises rates.
            if (message.usageMetadata) {
              const PRICE_TEXT_IN   =  0.75 / 1_000_000; // $ per token, text input
              const PRICE_AUDIO_IN  =  3.00 / 1_000_000; // $ per token, audio input
              const PRICE_TEXT_OUT  =  4.50 / 1_000_000; // $ per token, text output (incl. thinking)
              const PRICE_AUDIO_OUT = 12.00 / 1_000_000; // $ per token, audio output

              const u = message.usageMetadata;
              const details = (arr: typeof u.promptTokensDetails) =>
                (arr ?? []).map(d => `${d.modality ?? '?'}=${d.tokenCount ?? 0}`).join(' ') || 'n/a';

              const textIn   = (u.promptTokensDetails   ?? []).find(d => d.modality === 'TEXT')?.tokenCount   ?? 0;
              const audioIn  = (u.promptTokensDetails   ?? []).find(d => d.modality === 'AUDIO')?.tokenCount  ?? 0;
              const textOut  = (u.responseTokensDetails ?? []).find(d => d.modality === 'TEXT')?.tokenCount   ?? 0;
              const audioOut = (u.responseTokensDetails ?? []).find(d => d.modality === 'AUDIO')?.tokenCount  ?? 0;

              const cost = textIn * PRICE_TEXT_IN + audioIn * PRICE_AUDIO_IN
                         + textOut * PRICE_TEXT_OUT + audioOut * PRICE_AUDIO_OUT;

              console.log(
                `[TOKENS] prompt=${u.promptTokenCount ?? '?'} (${details(u.promptTokensDetails)})` +
                ` response=${u.responseTokenCount ?? '?'} (${details(u.responseTokensDetails)})` +
                ` total=${u.totalTokenCount ?? '?'}` +
                ` est_cost_usd=$${cost.toFixed(6)}`
              );

              turnBufferRef.current.promptTokens   += u.promptTokenCount   ?? 0;
              turnBufferRef.current.responseTokens += u.responseTokenCount ?? 0;
              turnBufferRef.current.costUsd        += cost;
            }

            // Accumulate transcription only when the feature is enabled
            if (transcriptionEnabledRef.current) {
              if (message.serverContent?.inputTranscription?.text) {
                turnBufferRef.current.customerText += message.serverContent.inputTranscription.text;
              }
              if (message.serverContent?.outputTranscription?.text) {
                turnBufferRef.current.aiText += message.serverContent.outputTranscription.text;
              }
            }

            // Audio response chunks
            if (message.serverContent?.modelTurn) {
              for (const part of (message.serverContent.modelTurn.parts || [])) {
                if (part.inlineData?.data) {
                  isSpeakingRef.current = true;
                  setStatus('SPEAKING');
                  playerRef.current?.playPCM(part.inlineData.data, 24000);
                }
              }
            }
            if (message.serverContent?.interrupted) {
              playerRef.current?.stop();
              isSpeakingRef.current = false;
              setStatus('IDLE');
            }

            if ((message.serverContent as { turnComplete?: boolean } | undefined)?.turnComplete) {
              if (!isSpeakingRef.current) setStatus('IDLE');
              const buf = { ...turnBufferRef.current };
              const idx = turnIndexRef.current++;
              turnBufferRef.current = { customerText: '', aiText: '', toolCalls: [],
                                        promptTokens: 0, responseTokens: 0, costUsd: 0 };
              if (transcriptionEnabledRef.current) {
                onTurnComplete?.({
                  index:          idx,
                  customerText:   buf.customerText   || null,
                  aiText:         buf.aiText         || null,
                  toolCalls:      buf.toolCalls,
                  promptTokens:   buf.promptTokens,
                  responseTokens: buf.responseTokens,
                  costUsd:        buf.costUsd,
                  timestamp:      new Date().toISOString(),
                });
              }
              // Report usage metrics — fire-and-forget, only when there are tokens to record
              if (buf.promptTokens > 0 || buf.responseTokens > 0) {
                const jwt = sessionStorage.getItem('sf_jwt');
                if (jwt) {
                  fetch('/api/admin/report-usage', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
                    body:    JSON.stringify({ promptTokens: buf.promptTokens, responseTokens: buf.responseTokens, costUsd: buf.costUsd }),
                  }).catch(() => undefined);
                }
              }
            }

            // Tool calls — dispatch all in parallel, always send a response
            if (message.toolCall && sessionRef.current) {
              const sid = sessionIdRef.current;
              const calls = message.toolCall.functionCalls || [];

              let functionResponses: unknown[];
              try {
                functionResponses = await Promise.all(
                  calls.map(async (call) => {
                    const args = call.args as Record<string, unknown>;

                    // tenantFetch attaches Authorization (JWT) and X-Tenant-ID
                    // automatically so the middleware can scope this call to
                    // the right tenant — and 403 if they ever disagree.
                    const agentTid = tenantIdRef.current;
                    const agentH = { 'Content-Type': 'application/json' };

                    if (call.name === 'add_item') {
                      try {
                        const res = await tenantFetch('/api/agent/resolve-item', {
                          method: 'POST',
                          headers: agentH,
                          tenantIdOverride: agentTid,
                          body: JSON.stringify({
                            session_id: sid,
                            dish_query: args.dish_query,
                            modifiers:  args.modifiers  || [],
                            quantity:   args.quantity   || 1,
                            notes:      args.notes      || null,
                          }),
                        }).then(r => r.json() as Promise<ResolveItemResponse>);

                        if (res.status === 'ok') {
                          setCart((prev: CartItem[]) => [...prev, {
                            cart_item_id:     res.cart_item_id!,
                            dish_id:          res.dish_id ?? 0,
                            summary:          res.summary!,
                            quantity:         (args.quantity as number) || 1,
                            unit_price:       res.unit_price!,
                            notes:            (args.notes as string) || undefined,
                            selected_options: res.selected_options ?? [],
                          }]);
                          return {
                            id: call.id, name: call.name,
                            response: { result: res.summary, cart_item_id: res.cart_item_id },
                          };
                        }
                        return {
                          id: call.id, name: call.name,
                          response: { status: res.status, ai_instruction: res.ai_instruction },
                        };
                      } catch {
                        return { id: call.id, name: call.name, response: { error: 'add_item failed' } };
                      }

                    } else if (call.name === 'remove_item') {
                      try {
                        await tenantFetch('/api/agent/remove-item', {
                          method: 'POST',
                          headers: agentH,
                          tenantIdOverride: agentTid,
                          body: JSON.stringify({ session_id: sid, cart_item_id: args.cart_item_id }),
                        });
                        setCart((prev: CartItem[]) => prev.filter((i: CartItem) => i.cart_item_id !== args.cart_item_id));
                      } catch {
                        // Cart state stays in sync even if network call fails
                      }
                      return { id: call.id, name: call.name, response: { result: 'Item removed.' } };

                    } else if (call.name === 'clear_cart') {
                      try {
                        await tenantFetch('/api/agent/clear-cart', {
                          method: 'POST',
                          headers: agentH,
                          tenantIdOverride: agentTid,
                          body: JSON.stringify({ session_id: sid }),
                        });
                        setCart([]);
                      } catch {
                        setCart([]);
                      }
                      return { id: call.id, name: call.name, response: { result: 'Cart cleared.' } };

                    } else if (call.name === 'confirm_order') {
                      try {
                        const currentCart = cartRef.current;
                        if (currentCart.length === 0) {
                          return { id: call.id, name: call.name, response: { error: 'Cart is empty.' } };
                        }
                        const cfg  = tenantConfigRef.current;
                        const cur  = cfg.businessRules.currencySymbol;
                        const sub  = currentCart.reduce((s, i) => s + i.unit_price * i.quantity, 0);
                        const gst  = Math.round(sub * cfg.businessRules.gstRate);
                        const tot  = sub + gst;

                        // Only honour "card" if this tenant actually has an online
                        // gateway configured. Otherwise the order would be created
                        // as card with nothing to open, stranding the customer.
                        //
                        // Delivery is excluded here as well as in the prompt.
                        // The prompt is guidance the model can ignore; this is the
                        // check that actually holds, and it matters because a
                        // delivery order paid online would then be collected again
                        // by the rider.
                        const orderType = String(args.order_type ?? 'dine_in').toLowerCase();
                        const wantsCard = String(args.payment_method ?? '').toLowerCase() === 'card';
                        const payMethod = wantsCard
                          && orderType !== 'delivery'
                          && cfg.payments?.provider && cfg.payments.provider !== 'cash'
                          ? 'card'
                          : 'cash';

                        const raw = await tenantFetch('/api/agent/submit-order', {
                          method: 'POST',
                          headers: agentH,
                          tenantIdOverride: agentTid,
                          body: JSON.stringify({
                            session_id:     sid,
                            cart_items:     currentCart.map(i => ({
                              cart_item_id: i.cart_item_id,
                              summary:      i.summary,
                              quantity:     i.quantity,
                              unit_price:   i.unit_price,
                              notes:        i.notes ?? null,
                            })),
                            customer_name:  args.customer_name  || 'Guest',
                            customer_phone: args.customer_phone || '0000000000',
                            order_type:     args.order_type     || 'dine_in',
                            payment_method: payMethod,
                            delivery_fee:   0,
                            discount:       0,
                            instructions:   (args.instructions as string) || null,
                            notes:          (args.notes as string)        || null,
                          }),
                        });
                        const res = await raw.json() as SubmitOrderResponse;
                        const orderId = res.id ?? res.order_id ?? res.order_number;
                        if (orderId) {
                          const lines = currentCart.map(i =>
                            `${i.summary}${i.quantity > 1 ? ` x${i.quantity}` : ''}`
                          ).join(', ');
                          const gstLabel = gst > 0 ? ` GST ${cur} ${gst},` : '';
                          const totals =
                            `Subtotal ${cur} ${sub},${gstLabel} Total ${cur} ${tot}`;

                          // Card orders are NOT confirmed here. The order is
                          // created unpaid and only becomes confirmed when the
                          // signed transaction.completed webhook arrives — so the
                          // agent must not tell the customer their order is placed
                          // before any money has actually moved.
                          const txnId = res.payment?.clientToken;
                          if (payMethod === 'card' && txnId) {
                            setStatus('AWAITING_PAYMENT');
                            void openOrderCheckout(txnId, {
                              onClosed: () => setStatus('IDLE'),
                              // Deliberately does NOT clear the cart or mark the
                              // order confirmed: checkout.completed means the form
                              // was submitted, not that the payment settled.
                              onCompleted: () => setStatus('PAYMENT_PROCESSING'),
                            }).catch((err: unknown) => {
                              console.error('[PADDLE] could not open checkout:', err);
                              setStatus('IDLE');
                            });

                            return { id: call.id, name: call.name, response: {
                              result: `Order number ${orderId}. ${lines}. ${totals}. ` +
                                `Please complete the payment in the window that just opened. ` +
                                `I'll confirm as soon as the payment goes through.`,
                            }};
                          }

                          if (payMethod === 'card' && !txnId) {
                            // Gateway failed at checkout creation — server already
                            // recorded the order unpaid so staff can collect
                            // manually. Say so rather than claiming it's confirmed.
                            console.error('[PADDLE] card order created without a checkout token', res.payment);
                            return { id: call.id, name: call.name, response: {
                              result: `Order number ${orderId} is saved, but the card payment could not be ` +
                                `started. Please pay at the counter.`,
                            }};
                          }

                          const confirmMsg =
                            `Order confirmed! Order number ${orderId}. ${lines}. ${totals}. Shukriya!`;
                          setCart([]);
                          setStatus('ORDER_CONFIRMED');
                          setTimeout(() => setStatus('IDLE'), 5000);
                          return { id: call.id, name: call.name, response: { result: confirmMsg } };
                        }
                        const errMsg = res.error || `submit-order returned HTTP ${raw.status} with no order ID`;
                        console.error('[AGENT] confirm_order failed:', errMsg, res);
                        return { id: call.id, name: call.name, response: { error: errMsg } };
                      } catch (err) {
                        console.error('[AGENT] confirm_order exception:', err);
                        return { id: call.id, name: call.name, response: { error: 'Order submission failed.' } };
                      }
                    }

                    return { id: call.id, name: call.name, response: { error: 'Unknown tool.' } };
                  })
                );
              } catch {
                functionResponses = calls.map(call => ({
                  id: call.id, name: call.name, response: { error: 'dispatch failed' },
                }));
              }

              // Record tool calls in the turn buffer (only when transcription is on)
              if (transcriptionEnabledRef.current) {
                calls.forEach((call, i) => {
                  turnBufferRef.current.toolCalls.push({
                    name:     call.name ?? '',
                    args:     (call.args ?? {}) as Record<string, unknown>,
                    response: (functionResponses[i] as { response: unknown }).response,
                  });
                });
              }

              if (functionResponses.length > 0 && sessionRef.current) {
                sessionRef.current.sendToolResponse({ functionResponses });
              }
            }
          },
          onerror: (e: unknown) => {
            console.error('[WS] onerror:', e);
            setStatus('Connection error — tap to retry');
            reject(e);
          },
          onclose: (e: unknown) => {
            console.warn('[WS] onclose:', e);
            setIsConnected(false);
            sessionRef.current = null;
            if (isRecordingRef.current) {
              isRecordingRef.current = false;
              setStatus('IDLE');
            }
          },
        },
      }).then((session: unknown) => {
        pendingSession = session as GeminiLiveSession;
        tryResolve();
      }).catch(reject);
    });
  }, []);

  const handleToggleRecording = async () => {
    if (isConnectingRef.current) return;

    if (isSpeakingRef.current) {
      playerRef.current?.stop();
      isSpeakingRef.current = false;
    }

    if (isRecordingRef.current) {
      isRecordingRef.current = false;
      recorderRef.current?.stop();
      setStatus('IDLE');
      if (sessionRef.current) {
        try {
          sessionRef.current.sendRealtimeInput({ audioStreamEnd: true });
        } catch (e) {
          console.error('[AUDIO] audioStreamEnd error', e);
        }
      }
      return;
    }

    if (!sessionRef.current) {
      isConnectingRef.current = true;
      const MAX_ATTEMPTS = 3;
      let connected = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          if (attempt > 1) {
            setStatus(`Retrying (${attempt}/${MAX_ATTEMPTS})...`);
            await new Promise(r => setTimeout(r, attempt * 1500));
          }
          await connectToGemini();
          connected = true;
          break;
        } catch {
          if (attempt === MAX_ATTEMPTS) {
            setStatus('Connection failed — tap to retry');
            isConnectingRef.current = false;
            return;
          }
        }
      }
      isConnectingRef.current = false;
      if (!connected) return;
    }

    isRecordingRef.current = true;
    setStatus('RECORDING');

    let chunkCount = 0;
    try {
      await recorderRef.current?.start((base64: string) => {
        if (isRecordingRef.current && sessionRef.current) {
          chunkCount++;
          if (chunkCount <= 3 || chunkCount % 20 === 0) {
            console.log(`[AUDIO] sending chunk #${chunkCount}, len=${base64.length}`);
          }
          sessionRef.current.sendRealtimeInput({
            audio: { data: base64, mimeType: 'audio/pcm;rate=16000' },
          });
        }
      });
    } catch (err) {
      console.error('[AUDIO] Microphone access denied or unavailable:', err);
      isRecordingRef.current = false;
      setStatus('Microphone denied — check browser permissions');
    }
  };

  const submitOrder = async () => {
    if (cart.length === 0) return;
    setStatus('SUBMITTING');
    try {
      const cfg = tenantConfigRef.current;
      const cur = cfg.businessRules.currencySymbol;
      const sub = cart.reduce((s, i) => s + i.unit_price * i.quantity, 0);
      const gst = Math.round(sub * cfg.businessRules.gstRate);

      const tid = tenantIdRef.current;
      const raw = await tenantFetch('/api/agent/submit-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        tenantIdOverride: tid,
        body: JSON.stringify({
          session_id:     sessionIdRef.current,
          cart_items:     cart.map(i => ({
            cart_item_id: i.cart_item_id,
            summary:      i.summary,
            quantity:     i.quantity,
            unit_price:   i.unit_price,
            notes:        i.notes ?? null,
          })),
          customer_name:  'Guest',
          customer_phone: '0000000000',
          order_type:     manualOrderType,
          payment_method: 'cash',
          delivery_fee:   0,
          discount:       0,
        }),
      });
      const res = await raw.json() as SubmitOrderResponse;
      const orderId = res.id ?? res.order_id ?? res.order_number;
      if (orderId) {
        const lines = cart.map(i => `${i.summary}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ');
        const gstLabel = gst > 0 ? ` GST ${cur} ${gst},` : '';
        const confirmMsg =
          `Order confirmed! Order number ${orderId}. ${lines}. ` +
          `Subtotal ${cur} ${sub},${gstLabel} Total ${cur} ${sub + gst}. Shukriya!`;
        setCart([]);
        setStatus('ORDER_CONFIRMED');
        setTimeout(() => setStatus('IDLE'), 5000);
        sessionRef.current?.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `[System] Order was placed manually. Read this confirmation aloud word-for-word: "${confirmMsg}"` }] }],
          turnComplete: true,
        });
      } else {
        console.error('[AGENT] manual submit-order: no order ID in response', res);
        setStatus(res.error || `Submit failed (HTTP ${raw.status}) — try again`);
      }
    } catch (err) {
      console.error('[AGENT] manual submit-order exception:', err);
      setStatus('Submit failed — try again');
    }
  };

  const clearCart = () => {
    setCart([]);
    setStatus('IDLE');
    sessionRef.current?.close();
  };

  const categories = [...new Set(menu.map((m: MenuItem) => m.category))];
  const filteredItems = menu.filter((item: MenuItem) => item.category === selectedCategory);
  const subtotal = cart.reduce((sum: number, item: CartItem) => sum + item.unit_price * item.quantity, 0);
  const gstRate  = tenantConfig.businessRules.gstRate;
  const currency = tenantConfig.businessRules.currencySymbol;
  const gst      = Math.round(subtotal * gstRate);
  const total    = subtotal + gst;

  return (
    <div className="flex flex-col lg:flex-row h-full overflow-hidden select-none bg-[#F8F7F2]">

      {/* ── Mobile top bar ── */}
      <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-[#5A5A40]/10 shrink-0">
        <div>
          <h1 className="text-base font-serif font-bold text-[#5A5A40] leading-tight">{tenantConfig.restaurantName.toUpperCase()}</h1>
          <p className="text-[9px] tracking-widest uppercase opacity-50">{tenantConfig.branding.kioskTitle}</p>
        </div>
        <div className="flex items-center gap-3">
          {onNavigateToDashboard && (
            <button
              onClick={onNavigateToDashboard}
              className="text-xs font-semibold text-[#5A5A40] opacity-60 hover:opacity-100 uppercase tracking-widest cursor-pointer"
            >
              Orders
            </button>
          )}
          <button
            onClick={() => setShowMobileCart(true)}
            className="relative p-2.5 glass-panel rounded-xl cursor-pointer"
            aria-label="Open cart"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#5A5A40]">
              <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
              <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
            </svg>
            {cart.length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-[#A39171] rounded-full text-[9px] text-white flex items-center justify-center font-bold leading-none">
                {cart.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── Mobile category scroll ── */}
      <div className="lg:hidden flex gap-2 px-3 py-2 overflow-x-auto shrink-0 border-b border-[#5A5A40]/10">
        {categories.length === 0 ? (
          <span className="text-xs opacity-30 px-1">Loading menu...</span>
        ) : (
          categories.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                selectedCategory === cat
                  ? 'bg-[#5A5A40] text-[#F8F7F2]'
                  : 'bg-white/70 text-[#5A5A40] border border-[#5A5A40]/20'
              }`}
            >
              {cat}
            </button>
          ))
        )}
      </div>

      {/* ── Left sidebar: branding + category nav ── */}
      <aside className="hidden lg:flex lg:w-60 shrink-0 flex-col overflow-hidden border-r border-[#5A5A40]/10">
        <div className="px-5 pt-6 pb-4 shrink-0">
          <h1 className="text-xl lg:text-2xl font-serif font-bold text-[#5A5A40] leading-tight">
            {tenantConfig.restaurantName.toUpperCase()}
          </h1>
          <p className="text-[10px] tracking-widest uppercase opacity-50 mt-0.5">
            {tenantConfig.branding.kioskTitle}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2">
          <p className="text-[10px] uppercase tracking-widest opacity-40 font-semibold px-3 mb-2">
            Menu
          </p>
          {categories.length === 0 ? (
            <div className="px-3 py-2 text-xs opacity-30">Loading...</div>
          ) : (
            categories.map(cat => (
              <div
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`sidebar-item px-3 py-2.5 cursor-pointer mb-0.5 ${
                  selectedCategory === cat
                    ? 'active'
                    : 'opacity-65 hover:opacity-100 hover:bg-white/40'
                }`}
              >
                <p className="font-semibold text-sm text-[#3D3D33]">{cat}</p>
                <p className="text-[10px] opacity-45 uppercase tracking-wide mt-0.5">
                  {menu.filter((m: MenuItem) => m.category === cat).length} items
                </p>
              </div>
            ))
          )}
        </div>

        {onNavigateToDashboard && (
          <div className="px-3 pb-1 shrink-0">
            <button
              onClick={onNavigateToDashboard}
              className="w-full py-2.5 glass-panel rounded-xl text-xs font-bold uppercase tracking-widest text-[#5A5A40] hover:bg-white/80 transition-colors cursor-pointer"
            >
              Live Orders →
            </button>
          </div>
        )}

        {onNavigateToTranscripts && (
          <div className="px-3 pb-1 shrink-0">
            <button
              onClick={onNavigateToTranscripts}
              className="w-full py-2.5 glass-panel rounded-xl text-xs font-bold uppercase tracking-widest text-[#5A5A40] hover:bg-white/80 transition-colors cursor-pointer"
            >
              Transcript →
            </button>
          </div>
        )}

        {onNavigateToAdmin && (
          <div className="px-3 pb-1 shrink-0">
            <button
              onClick={onNavigateToAdmin}
              className="w-full py-2.5 glass-panel rounded-xl text-xs font-bold uppercase tracking-widest text-[#5A5A40] hover:bg-white/80 transition-colors cursor-pointer"
            >
              Admin →
            </button>
          </div>
        )}

        {onLogout && (
          <div className="px-3 pb-1 shrink-0">
            <button
              onClick={onLogout}
              className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest text-red-500 border border-red-200 hover:bg-red-50 transition-colors cursor-pointer"
            >
              Sign Out
            </button>
          </div>
        )}

        <div className="px-3 pb-4 shrink-0">
          <div className="glass-panel p-3">
            <p className="text-[9px] uppercase tracking-widest opacity-40 font-semibold mb-2">
              System
            </p>
            <div className="flex items-center gap-2 mb-1.5">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isConnected ? 'bg-green-500' : 'bg-[#A39171] dot-pulse'}`} />
              <span className="text-[10px] font-mono truncate">GEMINI 3.1 FLASH</span>
            </div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              <span className="text-[10px] font-mono">DB SYNCED</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-widest opacity-40 font-semibold">
                Transcription
              </span>
              <button
                onClick={() => setTranscriptionEnabled(v => !v)}
                aria-label={transcriptionEnabled ? 'Disable transcription' : 'Enable transcription'}
                className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                  transcriptionEnabled ? 'bg-[#5A5A40]' : 'bg-[#5A5A40]/20'
                }`}
              >
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
                  transcriptionEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Main: menu grid + voice section ── */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden p-3 lg:p-5 gap-3 lg:gap-4">

        <div className="glass-panel flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="px-4 lg:px-5 py-3 lg:py-4 border-b border-[#5A5A40]/8 shrink-0 flex items-center justify-between">
            <div>
              <h2 className="text-base lg:text-lg font-serif font-bold text-[#5A5A40]">
                {selectedCategory || 'Menu'}
              </h2>
              <p className="text-[10px] uppercase tracking-widest opacity-40 mt-0.5">
                {filteredItems.length} item{filteredItems.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 p-3 lg:p-5">
            {menu.length === 0 ? (
              <div className="flex items-center justify-center h-24 opacity-35 text-sm">
                Loading menu...
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="flex items-center justify-center h-24 opacity-35 text-sm">
                No items in this category.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {filteredItems.map((item: MenuItem) => (
                  <div
                    key={item.id}
                    className="p-3 lg:p-4 bg-white/50 rounded-xl border border-white/60 hover:border-[#A39171]/30 hover:bg-white/70 transition-all"
                  >
                    <div className="flex justify-between items-start gap-2 mb-1.5">
                      <h4 className="font-bold text-sm text-[#5A5A40] leading-snug">
                        {item.name}
                      </h4>
                      <span className="font-mono text-sm text-[#5A5A40] whitespace-nowrap shrink-0 font-semibold">
                        PKR {item.display_price ?? item.price ?? item.base_price}
                      </span>
                    </div>
                    {item.description && (
                      <p className="text-xs text-[#3D3D33] opacity-55 line-clamp-2 mb-2 leading-relaxed">
                        {item.description}
                      </p>
                    )}
                    {item.tag && (
                      <span className="inline-block text-[10px] uppercase tracking-widest px-2 py-0.5 bg-[#5A5A40]/8 text-[#5A5A40] rounded-md">
                        {item.tag}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Voice Order section */}
        <div className="glass-panel shrink-0 p-3 lg:p-5">
          <div className="flex items-center gap-4 lg:gap-5">

            <div className="relative shrink-0">
              {isRecording && <div className="pulse-ring" />}
              <button
                onClick={handleToggleRecording}
                disabled={status === 'CONNECTING'}
                aria-label={isRecording ? 'Stop recording' : 'Start recording'}
                className={`
                  relative w-14 h-14 lg:w-[60px] lg:h-[60px] rounded-full flex items-center justify-center
                  transition-all duration-200 focus:outline-none focus-visible:ring-2
                  focus-visible:ring-[#5A5A40] focus-visible:ring-offset-2 shadow-md
                  ${isRecording
                    ? 'bg-red-500 hover:bg-red-600 shadow-red-200 scale-95'
                    : status === 'CONNECTING'
                    ? 'bg-[#A39171] cursor-not-allowed opacity-70'
                    : 'bg-[#5A5A40] hover:bg-[#4a4a33] hover:scale-105 active:scale-95 cursor-pointer'
                  }
                `}
              >
                {isRecording ? (
                  <div className="flex items-end gap-[3px] h-5">
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                  </div>
                ) : (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#F8F7F2" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="2" width="6" height="11" rx="3" />
                    <path d="M5 10a7 7 0 0 0 14 0" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                    <line x1="8" y1="22" x2="16" y2="22" />
                  </svg>
                )}
              </button>
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-widest opacity-45 font-semibold mb-1">
                Voice Order
              </p>
              <p className={`text-sm font-semibold leading-snug ${
                isRecording ? 'text-red-600' :
                status === 'ORDER_CONFIRMED' ? 'text-green-700' :
                'text-[#5A5A40]'
              }`}>
                {getStatusLabel(status)}
              </p>
              {isRecording && (
                <p className="text-[11px] opacity-50 mt-0.5 hidden sm:block">
                  Click the button again to stop
                </p>
              )}
            </div>

            {isRecording && (
              <div className="ml-auto flex items-center gap-0.5 shrink-0 pr-1">
                {[14, 22, 16, 20, 12, 18, 14].map((h, i) => (
                  <div
                    key={i}
                    className="w-[3px] rounded-full bg-red-400"
                    style={{
                      height: `${h}px`,
                      animation: `waveBar 0.7s ease-in-out infinite`,
                      animationDelay: `${i * 0.1}s`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ── Right sidebar: cart (desktop only) ── */}
      <aside className="hidden lg:flex lg:w-72 shrink-0 flex-col overflow-hidden border-l border-[#5A5A40]/10">
        <div className="flex flex-col h-full overflow-hidden">

          <div className="px-5 pt-6 pb-4 shrink-0">
            <h3 className="text-base lg:text-lg font-bold text-[#5A5A40]">Current Order</h3>
            <p className="text-[10px] uppercase tracking-widest opacity-45 mt-0.5">
              {cart.length} item{cart.length !== 1 ? 's' : ''}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 px-4 lg:px-5 pb-2 flex flex-col gap-2">
            {cart.length === 0 ? (
              <p className="text-xs opacity-40 italic text-center pt-10 leading-relaxed">
                Your cart is empty.<br />
                Speak your order to add items.
              </p>
            ) : (
              cart.map((item, idx) => (
                <div
                  key={idx}
                  className="flex justify-between items-start py-2.5 border-b border-[#5A5A40]/8 last:border-0"
                >
                  <div className="flex-1 pr-2 min-w-0">
                    <p className="text-sm font-semibold text-[#3D3D33] leading-snug">
                      {item.summary}
                    </p>
                    {item.quantity > 1 && (
                      <p className="text-[11px] opacity-45 mt-0.5">×{item.quantity}</p>
                    )}
                  </div>
                  <span className="font-mono text-sm text-[#5A5A40] whitespace-nowrap shrink-0 font-semibold">
                    {currency} {Math.round(item.unit_price * item.quantity)}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="mx-3 mb-3 bg-[#5A5A40] text-[#F8F7F2] rounded-2xl p-4 lg:p-5 shrink-0">
            <div className="flex justify-between mb-2 opacity-75">
              <span className="text-sm">Subtotal</span>
              <span className="text-sm font-mono">{currency} {subtotal}</span>
            </div>
            {gstRate > 0 && (
              <div className="flex justify-between mb-3 opacity-75">
                <span className="text-sm">GST ({Math.round(gstRate * 100)}%)</span>
                <span className="text-sm font-mono">{currency} {gst}</span>
              </div>
            )}
            <div className="flex justify-between items-end border-t border-white/20 pt-3 mb-4">
              <span className="text-base font-serif">Total</span>
              <span className="text-xl font-bold font-mono">{currency} {total}</span>
            </div>

            <div className="flex gap-1 mb-3">
              {(['dine_in', 'pickup', 'delivery'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setManualOrderType(t)}
                  className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wide transition-all ${
                    manualOrderType === t
                      ? 'bg-[#A39171] text-white'
                      : 'bg-white/10 text-white/60 hover:bg-white/20'
                  }`}
                >
                  {t === 'dine_in' ? 'Dine In' : t === 'pickup' ? 'Pickup' : 'Takeaway'}
                </button>
              ))}
            </div>
            <button
              onClick={submitOrder}
              disabled={cart.length === 0}
              className={`w-full py-2.5 rounded-xl font-bold uppercase tracking-widest text-xs transition-all mb-2 ${
                cart.length > 0
                  ? 'bg-[#A39171] text-white cursor-pointer hover:bg-[#928263] active:scale-95'
                  : 'bg-white/15 text-white/35 cursor-not-allowed'
              }`}
            >
              Confirm Order
            </button>
            <button
              onClick={clearCart}
              className="w-full py-2 border border-white/20 rounded-xl text-xs opacity-60 hover:opacity-90 cursor-pointer hover:bg-white/10 transition-all"
            >
              Clear All Items
            </button>
          </div>
        </div>
      </aside>

      {/* ── Mobile cart drawer ── */}
      {showMobileCart && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowMobileCart(false)}
          />
          <div className="relative bg-[#F8F7F2] rounded-t-3xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="flex justify-center pt-3 pb-1 shrink-0">
              <div className="w-10 h-1 bg-[#5A5A40]/20 rounded-full" />
            </div>
            <div className="flex items-center justify-between px-5 py-3 shrink-0 border-b border-[#5A5A40]/10">
              <div>
                <h3 className="text-base font-bold text-[#5A5A40]">Current Order</h3>
                <p className="text-[10px] uppercase tracking-widest opacity-45 mt-0.5">
                  {cart.length} item{cart.length !== 1 ? 's' : ''}
                </p>
              </div>
              <button
                onClick={() => setShowMobileCart(false)}
                className="text-[#5A5A40] opacity-50 hover:opacity-100 p-1 cursor-pointer"
                aria-label="Close cart"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-2 flex flex-col gap-2 min-h-0">
              {cart.length === 0 ? (
                <p className="text-xs opacity-40 italic text-center pt-10 leading-relaxed">
                  Your cart is empty.<br />
                  Speak your order to add items.
                </p>
              ) : (
                cart.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex justify-between items-start py-2.5 border-b border-[#5A5A40]/8 last:border-0"
                  >
                    <div className="flex-1 pr-2 min-w-0">
                      <p className="text-sm font-semibold text-[#3D3D33] leading-snug">
                        {item.summary}
                      </p>
                      {item.quantity > 1 && (
                        <p className="text-[11px] opacity-45 mt-0.5">×{item.quantity}</p>
                      )}
                    </div>
                    <span className="font-mono text-sm text-[#5A5A40] whitespace-nowrap shrink-0 font-semibold">
                      {currency} {Math.round(item.unit_price * item.quantity)}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="mx-3 mb-3 bg-[#5A5A40] text-[#F8F7F2] rounded-2xl p-4 shrink-0">
              <div className="flex justify-between mb-2 opacity-75">
                <span className="text-sm">Subtotal</span>
                <span className="text-sm font-mono">{currency} {subtotal}</span>
              </div>
              {gstRate > 0 && (
                <div className="flex justify-between mb-3 opacity-75">
                  <span className="text-sm">GST ({Math.round(gstRate * 100)}%)</span>
                  <span className="text-sm font-mono">{currency} {gst}</span>
                </div>
              )}
              <div className="flex justify-between items-end border-t border-white/20 pt-3 mb-4">
                <span className="text-base font-serif">Total</span>
                <span className="text-xl font-bold font-mono">{currency} {total}</span>
              </div>
              <div className="flex gap-1 mb-3">
                {(['dine_in', 'pickup', 'delivery'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setManualOrderType(t)}
                    className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wide transition-all ${
                      manualOrderType === t
                        ? 'bg-[#A39171] text-white'
                        : 'bg-white/10 text-white/60 hover:bg-white/20'
                    }`}
                  >
                    {t === 'dine_in' ? 'Dine In' : t === 'pickup' ? 'Pickup' : 'Takeaway'}
                  </button>
                ))}
              </div>
              <button
                onClick={() => { submitOrder(); setShowMobileCart(false); }}
                disabled={cart.length === 0}
                className={`w-full py-2.5 rounded-xl font-bold uppercase tracking-widest text-xs transition-all mb-2 ${
                  cart.length > 0
                    ? 'bg-[#A39171] text-white cursor-pointer hover:bg-[#928263] active:scale-95'
                    : 'bg-white/15 text-white/35 cursor-not-allowed'
                }`}
              >
                Confirm Order
              </button>
              <button
                onClick={() => { clearCart(); setShowMobileCart(false); }}
                className="w-full py-2 border border-white/20 rounded-xl text-xs opacity-60 hover:opacity-90 cursor-pointer hover:bg-white/10 transition-all"
              >
                Clear All Items
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Setup incomplete toast ── */}
      {setupToast && (
        <div className="fixed bottom-6 right-6 z-[60] w-80 rounded-2xl shadow-2xl overflow-hidden"
             style={{ background: 'linear-gradient(135deg, #fff8e1 0%, #fff3cd 100%)', border: '1px solid #f59e0b' }}>
          {/* Progress bar */}
          <div
            className="h-1 bg-amber-400 transition-all duration-1000 ease-linear"
            style={{ width: `${(toastTimer / 15) * 100}%` }}
          />
          <div className="p-4">
            <div className="flex items-start gap-3">
              <div className="text-2xl shrink-0">⚙️</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-amber-900 leading-tight">
                  Setup Incomplete
                </p>
                <p className="text-xs text-amber-800 mt-0.5 leading-snug">
                  Resume from <span className="font-semibold">{setupToast.stepName}</span> —{' '}
                  {setupToast.stepsLeft} step{setupToast.stepsLeft !== 1 ? 's' : ''} remaining
                </p>
              </div>
              <button
                onClick={() => setSetupToast(null)}
                className="shrink-0 text-amber-500 hover:text-amber-700 transition-colors cursor-pointer"
                aria-label="Dismiss"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div className="flex items-center gap-2 mt-3">
              {onNavigateToAdmin && (
                <button
                  onClick={() => { setSetupToast(null); onNavigateToAdmin(); }}
                  className="flex-1 py-2 rounded-xl text-xs font-bold bg-amber-500 text-white hover:bg-amber-600 transition-colors cursor-pointer"
                >
                  Complete Setup →
                </button>
              )}
              <span className="text-[10px] text-amber-600 font-mono shrink-0 w-6 text-center">
                {toastTimer}s
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
