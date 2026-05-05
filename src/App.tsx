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
  buildSystemInstruction,
} from './lib/geminiTools';

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
}

// Structural interface covering only the session methods this component calls.
// The full SDK type is not exported — using a structural type avoids `any` here.
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
  | string;

const STATUS_LABEL: Record<string, string> = {
  IDLE:            'Tap the mic to speak your order',
  CONNECTING:      'Connecting to AI...',
  RECORDING:       'Recording — tap to stop',
  SPEAKING:        'Responding...',
  ORDER_CONFIRMED: 'Order confirmed!',
  SUBMITTING:      'Submitting order...',
};

function getStatusLabel(status: AppStatus): string {
  return STATUS_LABEL[status] ?? status;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function App({ onNavigateToDashboard }: { onNavigateToDashboard?: () => void }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [status, setStatus] = useState<AppStatus>('IDLE');
  const [isConnected, setIsConnected] = useState(false);

  const sessionIdRef    = useRef<string>(generateSessionId());
  const menuContextRef  = useRef<string>('');
  const aiRef           = useRef<GoogleGenAI | null>(null);
  const sessionRef      = useRef<GeminiLiveSession | null>(null);
  const recorderRef     = useRef<AudioRecorder | null>(null);
  const playerRef       = useRef<AudioPlayer | null>(null);
  const isRecordingRef  = useRef(false);
  const isSpeakingRef   = useRef(false);
  const isConnectingRef = useRef(false);
  const cartRef         = useRef<CartItem[]>([]);

  const isRecording = status === 'RECORDING';

  // Keep cartRef in sync so the confirm_order closure always sees current cart
  useEffect(() => { cartRef.current = cart; }, [cart]);

  useEffect(() => {
    recorderRef.current = new AudioRecorder();
    playerRef.current   = new AudioPlayer();

    playerRef.current.onQueueEmpty = () => {
      isSpeakingRef.current = false;
      setStatus('IDLE');
    };

    // Fetch Gemini API key at runtime — never baked into the bundle
    fetch('/api/config')
      .then(r => {
        if (!r.ok) throw new Error(`config ${r.status}`);
        return r.json() as Promise<{ geminiApiKey: string }>;
      })
      .then(({ geminiApiKey }) => {
        aiRef.current = new GoogleGenAI({ apiKey: geminiApiKey });
      })
      .catch(err => {
        console.error('[INIT] Failed to load config:', err);
        setStatus('Setup error — refresh page');
      });

    // Pre-load menu context for AI (non-blocking)
    fetchMenuContext().then(ctx => { menuContextRef.current = ctx; });

    // Structured menu for the UI grid
    fetch('/api/menu')
      .then(r => r.json())
      .then((data: MenuCategory[]) => {
        const dishes: MenuItem[] = [];
        for (const cat of (Array.isArray(data) ? data : [])) {
          for (const sub of (cat.sub_categories || [])) {
            for (const dish of (sub.dishes || [])) {
              dishes.push({ ...dish, category: cat.name });
            }
          }
        }
        setMenu(dishes);
        const cats = [...new Set(dishes.map(d => d.category))];
        if (cats.length > 0) {
          setSelectedCategory(prev => (prev && cats.includes(prev)) ? prev : cats[0]);
        }
      })
      .catch(err => console.error('[MENU] Fetch error:', err));

    return () => {
      recorderRef.current?.destroy();
      playerRef.current?.stop();
      sessionRef.current?.close();
    };
  }, []);

  const connectToGemini = useCallback(async () => {
    if (!aiRef.current) {
      setStatus('Setup error — refresh page');
      return;
    }
    setStatus('CONNECTING');

    if (!menuContextRef.current) {
      menuContextRef.current = await fetchMenuContext();
    }
    const sysInstruction = buildSystemInstruction(menuContextRef.current);

    await new Promise<void>((resolve, reject) => {
      let pendingSession: GeminiLiveSession | null = null;
      let wsOpen = false;

      const tryResolve = () => {
        if (pendingSession && wsOpen) {
          sessionRef.current = pendingSession;
          resolve();
        }
      };

      aiRef.current!.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: sysInstruction,
          tools: [{ functionDeclarations: allTools }],
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            wsOpen = true;
            tryResolve();
          },
          onmessage: async (message: LiveServerMessage) => {
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

            // Model finished turn — if no audio queued, unlock the mic
            if ((message.serverContent as { turnComplete?: boolean } | undefined)?.turnComplete
                && !isSpeakingRef.current) {
              setStatus('IDLE');
            }

            // Tool calls — dispatch all in parallel, always send a response
            if (message.toolCall && sessionRef.current) {
              const sid = sessionIdRef.current;

              const functionResponses = await Promise.all(
                (message.toolCall.functionCalls || []).map(async (call) => {
                  const args = call.args as Record<string, unknown>;

                  if (call.name === 'add_item') {
                    try {
                      const res = await fetch('/api/agent/resolve-item', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
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
                      await fetch('/api/agent/remove-item', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session_id: sid, cart_item_id: args.cart_item_id }),
                      });
                      setCart((prev: CartItem[]) => prev.filter((i: CartItem) => i.cart_item_id !== args.cart_item_id));
                    } catch {
                      // Cart state stays in sync even if network call fails
                    }
                    return { id: call.id, name: call.name, response: { result: 'Item removed.' } };

                  } else if (call.name === 'clear_cart') {
                    try {
                      await fetch('/api/agent/clear-cart', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
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
                      const sub  = currentCart.reduce((s, i) => s + i.unit_price * i.quantity, 0);
                      const gst  = Math.round(sub * 0.15);
                      const tot  = sub + gst;

                      const raw = await fetch('/api/agent/submit-order', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          session_id:     sid,
                          customer_name:  args.customer_name  || 'Guest',
                          customer_phone: args.customer_phone || '0000000000',
                          order_type:     args.order_type     || 'dine_in',
                          payment_method: 'cash',
                          delivery_fee:   0,
                          discount:       0,
                          instructions:   (args.instructions as string) || null,
                          notes:          (args.notes as string)        || null,
                        }),
                      });
                      const res = await raw.json() as SubmitOrderResponse;
                      console.log('[AGENT] submit-order response', raw.status, res);

                      const orderId = res.id ?? res.order_id ?? res.order_number;
                      if (orderId) {
                        const lines = currentCart.map(i =>
                          `${i.summary}${i.quantity > 1 ? ` x${i.quantity}` : ''}`
                        ).join(', ');
                        const confirmMsg =
                          `Order confirmed! Order number ${orderId}. ${lines}. ` +
                          `Subtotal PKR ${sub}, GST PKR ${gst}, Total PKR ${tot}. Shukriya!`;
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

              // Always send tool responses — a missing response stalls the Gemini turn
              if (functionResponses.length > 0 && sessionRef.current) {
                sessionRef.current.sendToolResponse({ functionResponses });
              }
            }
          },
          onerror: (e: unknown) => {
            setStatus('Connection error — tap to retry');
            reject(e);
          },
          onclose: () => {
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

    await recorderRef.current?.start((base64: string) => {
      if (isRecordingRef.current && sessionRef.current) {
        sessionRef.current.sendRealtimeInput({
          audio: { data: base64, mimeType: 'audio/pcm;rate=16000' },
        });
      }
    });
  };

  const submitOrder = async () => {
    if (cart.length === 0) return;
    setStatus('SUBMITTING');
    try {
      const sub = cart.reduce((s, i) => s + i.unit_price * i.quantity, 0);
      const gst = Math.round(sub * 0.15);

      const raw = await fetch('/api/agent/submit-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id:     sessionIdRef.current,
          customer_name:  'Guest',
          customer_phone: '0000000000',
          order_type:     'dine_in',
          payment_method: 'cash',
          delivery_fee:   0,
          discount:       0,
        }),
      });
      const res = await raw.json() as SubmitOrderResponse;
      console.log('[AGENT] manual submit-order response', raw.status, res);

      const orderId = res.id ?? res.order_id ?? res.order_number;
      if (orderId) {
        const lines = cart.map(i => `${i.summary}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ');
        const confirmMsg =
          `Order confirmed! Order number ${orderId}. ${lines}. ` +
          `Subtotal PKR ${sub}, GST PKR ${gst}, Total PKR ${sub + gst}. Shukriya!`;
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
  const gst   = Math.round(subtotal * 0.15);
  const total = subtotal + gst;

  return (
    <div className="flex h-full overflow-hidden select-none bg-[#F8F7F2]">

      {/* ── Left sidebar: branding + category nav ── */}
      <aside className="w-52 lg:w-60 shrink-0 flex flex-col overflow-hidden border-r border-[#5A5A40]/10">
        {/* Logo */}
        <div className="px-5 pt-6 pb-4 shrink-0">
          <h1 className="text-xl lg:text-2xl font-serif font-bold text-[#5A5A40] leading-tight">
            SAVOUR FOODS
          </h1>
          <p className="text-[10px] tracking-widest uppercase opacity-50 mt-0.5">
            Islamabad / Blue Area
          </p>
        </div>

        {/* Category nav — scrollable */}
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

        {/* Live orders button */}
        {onNavigateToDashboard && (
          <div className="px-3 pb-3 shrink-0">
            <button
              onClick={onNavigateToDashboard}
              className="w-full py-2.5 glass-panel rounded-xl text-xs font-bold uppercase tracking-widest text-[#5A5A40] hover:bg-white/80 transition-colors cursor-pointer"
            >
              Live Orders →
            </button>
          </div>
        )}

        {/* System status */}
        <div className="px-3 pb-4 shrink-0">
          <div className="glass-panel p-3">
            <p className="text-[9px] uppercase tracking-widest opacity-40 font-semibold mb-2">
              System
            </p>
            <div className="flex items-center gap-2 mb-1.5">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isConnected ? 'bg-green-500' : 'bg-[#A39171] dot-pulse'}`} />
              <span className="text-[10px] font-mono truncate">GEMINI 3.1 FLASH</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              <span className="text-[10px] font-mono">DB SYNCED</span>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Main: menu grid + voice section ── */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden p-4 lg:p-5 gap-4">

        {/* Menu panel */}
        <div className="glass-panel flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="px-5 py-4 border-b border-[#5A5A40]/8 shrink-0 flex items-center justify-between">
            <div>
              <h2 className="text-base lg:text-lg font-serif font-bold text-[#5A5A40]">
                {selectedCategory || 'Menu'}
              </h2>
              <p className="text-[10px] uppercase tracking-widest opacity-40 mt-0.5">
                {filteredItems.length} item{filteredItems.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          {/* Items grid — own scrollbar */}
          <div className="flex-1 overflow-y-auto min-h-0 p-4 lg:p-5">
            {menu.length === 0 ? (
              <div className="flex items-center justify-center h-24 opacity-35 text-sm">
                Loading menu...
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="flex items-center justify-center h-24 opacity-35 text-sm">
                No items in this category.
              </div>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {filteredItems.map((item: MenuItem) => (
                  <div
                    key={item.id}
                    className="p-4 bg-white/50 rounded-xl border border-white/60 hover:border-[#A39171]/30 hover:bg-white/70 transition-all"
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
        <div className="glass-panel shrink-0 p-4 lg:p-5">
          <div className="flex items-center gap-5">

            {/* Mic button */}
            <div className="relative shrink-0">
              {isRecording && <div className="pulse-ring" />}
              <button
                onClick={handleToggleRecording}
                disabled={status === 'CONNECTING'}
                aria-label={isRecording ? 'Stop recording' : 'Start recording'}
                className={`
                  relative w-[60px] h-[60px] rounded-full flex items-center justify-center
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

            {/* Status text */}
            <div className="min-w-0">
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
                <p className="text-[11px] opacity-50 mt-0.5">
                  Click the button again to stop
                </p>
              )}
            </div>

            {/* Animated level bars (recording state) */}
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

      {/* ── Right sidebar: cart ── */}
      <aside className="w-64 lg:w-72 shrink-0 flex flex-col overflow-hidden border-l border-[#5A5A40]/10">
        <div className="flex flex-col h-full overflow-hidden">

          {/* Cart header */}
          <div className="px-5 pt-6 pb-4 shrink-0">
            <h3 className="text-base lg:text-lg font-bold text-[#5A5A40]">Current Order</h3>
            <p className="text-[10px] uppercase tracking-widest opacity-45 mt-0.5">
              {cart.length} item{cart.length !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Cart items — own scrollbar */}
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
                    PKR {Math.round(item.unit_price * item.quantity)}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Totals + actions */}
          <div className="mx-3 mb-3 bg-[#5A5A40] text-[#F8F7F2] rounded-2xl p-4 lg:p-5 shrink-0">
            <div className="flex justify-between mb-2 opacity-75">
              <span className="text-sm">Subtotal</span>
              <span className="text-sm font-mono">PKR {subtotal}</span>
            </div>
            <div className="flex justify-between mb-3 opacity-75">
              <span className="text-sm">GST (15%)</span>
              <span className="text-sm font-mono">PKR {gst}</span>
            </div>
            <div className="flex justify-between items-end border-t border-white/20 pt-3 mb-4">
              <span className="text-base font-serif">Total</span>
              <span className="text-xl font-bold font-mono">PKR {total}</span>
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
    </div>
  );
}
