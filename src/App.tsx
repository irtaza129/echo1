/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { AudioPlayer, AudioRecorder } from './lib/audioUtils';
import {
  allTools,
  generateSessionId,
  fetchMenuContext,
  buildSystemInstruction,
} from './lib/geminiTools';

type CartItem = {
  cart_item_id: string;
  summary: string;
  quantity: number;
  unit_price: number;
};

export default function App({ onNavigateToDashboard }: { onNavigateToDashboard?: () => void }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [menu, setMenu] = useState<any[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('Chicken Pulao');
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('IDLE READY');
  const [isConnected, setIsConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // One session ID per page load — stable across multiple PTT presses
  const sessionIdRef = useRef<string>(generateSessionId());
  const menuContextRef = useRef<string>('');
  
  const aiRef = useRef<GoogleGenAI | null>(null);
  const sessionRef = useRef<any>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const isRecordingRef = useRef(false);
  const isSpeakingRef = useRef(false);

  useEffect(() => {
    aiRef.current = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    recorderRef.current = new AudioRecorder();
    playerRef.current = new AudioPlayer();

    playerRef.current.onQueueEmpty = () => {
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      setStatus('IDLE READY');
    };

    // Fetch menu context once for both the AI prompt and UI grid
    fetchMenuContext().then(ctx => {
      menuContextRef.current = ctx;
      console.log('Menu context loaded:', ctx.length, 'chars');
    });

    // Fetch structured menu for the UI category grid
    fetch('/api/menu')
      .then(res => res.json())
      .then(data => {
        // /api/v1/menu returns category objects; flatten to dish list for UI
        const dishes: any[] = [];
        for (const cat of (Array.isArray(data) ? data : [])) {
          for (const sub of (cat.sub_categories || [])) {
            for (const dish of (sub.dishes || [])) {
              dishes.push({ ...dish, category: cat.name });
            }
          }
        }
        setMenu(dishes);
        console.log('Menu loaded:', dishes.length, 'dishes');
      })
      .catch(err => console.error('Menu Fetch Error:', err));

    return () => {
      recorderRef.current?.destroy();
      playerRef.current?.stop();
      sessionRef.current?.close();
    };
  }, []);

  const connectToGemini = async () => {
    if (!aiRef.current) return;
    setStatus('CONNECTING...');

    // Ensure menu context is ready before opening the session
    if (!menuContextRef.current) {
      menuContextRef.current = await fetchMenuContext();
    }
    const sysInstruction = buildSystemInstruction(menuContextRef.current);

    await new Promise<void>(async (resolve) => {
      const sessionPromise = aiRef.current!.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: sysInstruction,
          tools: [{ functionDeclarations: allTools }],
        },
        callbacks: {
          onopen: () => {
            setStatus('CONNECTED');
            setIsConnected(true);
            resolve();
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn) {
              const parts = message.serverContent.modelTurn.parts || [];
              for (const part of parts) {
                if (part.inlineData?.data) {
                  isSpeakingRef.current = true;
                  setIsSpeaking(true);
                  playerRef.current?.playPCM(part.inlineData.data, 24000);
                  setStatus('SPEAKING');
                }
              }
            }
            if (message.serverContent?.interrupted) {
              playerRef.current?.stop();
            }

            // ── Tool call handling ──────────────────────────────
            if (message.toolCall && sessionRef.current) {
              const sid = sessionIdRef.current;
              const functionResponses: any[] = [];

              for (const call of message.toolCall.functionCalls || []) {
                const args = call.args as any;

                if (call.name === 'add_item') {
                  // POST to agent adapter — returns ok / requires_input / not_found
                  const res = await fetch('/api/agent/resolve-item', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      session_id: sid,
                      dish_query: args.dish_query,
                      modifiers: args.modifiers || [],
                      quantity: args.quantity || 1,
                      notes: args.notes || null,
                    }),
                  }).then(r => r.json());

                  if (res.status === 'ok') {
                    // Add to local UI cart
                    setCart(prev => [...prev, {
                      cart_item_id: res.cart_item_id,
                      summary: res.summary,
                      quantity: args.quantity || 1,
                      unit_price: res.unit_price,
                    }]);
                    functionResponses.push({
                      id: call.id, name: call.name,
                      response: { result: res.summary, cart_item_id: res.cart_item_id },
                    });
                  } else {
                    // requires_input or not_found — give the ai_instruction back to Gemini
                    functionResponses.push({
                      id: call.id, name: call.name,
                      response: { status: res.status, ai_instruction: res.ai_instruction },
                    });
                  }

                } else if (call.name === 'remove_item') {
                  await fetch('/api/agent/remove-item', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sid, cart_item_id: args.cart_item_id }),
                  });
                  setCart(prev => prev.filter(i => i.cart_item_id !== args.cart_item_id));
                  functionResponses.push({
                    id: call.id, name: call.name,
                    response: { result: 'Item removed.' },
                  });

                } else if (call.name === 'clear_cart') {
                  await fetch('/api/agent/clear-cart', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sid }),
                  });
                  setCart([]);
                  functionResponses.push({
                    id: call.id, name: call.name,
                    response: { result: 'Cart cleared.' },
                  });

                } else if (call.name === 'confirm_order') {
                  const res = await fetch('/api/agent/submit-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      session_id: sid,
                      customer_name: args.customer_name || 'Guest',
                      customer_phone: args.customer_phone || '0000000000',
                      order_type: args.order_type || 'dine_in',
                      notes: args.notes || null,
                    }),
                  }).then(r => r.json());

                  if (res.order_id) {
                    setCart([]);
                    setStatus('ORDER CONFIRMED');
                    setTimeout(() => setStatus('IDLE READY'), 4000);
                    functionResponses.push({
                      id: call.id, name: call.name,
                      response: { result: res.summary },
                    });
                  } else {
                    functionResponses.push({
                      id: call.id, name: call.name,
                      response: { error: 'Order submission failed. Please try again.' },
                    });
                  }
                }
              }

              if (functionResponses.length > 0) {
                sessionRef.current.sendToolResponse({ functionResponses });
              }
            }
          },
          onerror: (e: any) => setStatus('ERROR: ' + e?.message),
          onclose: () => {
            setStatus('IDLE READY');
            setIsConnected(false);
            sessionRef.current = null;
          },
        },
      });

      sessionRef.current = await sessionPromise;
    });

    // Suppress proactive greeting
    sessionRef.current?.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: '' }] }],
      turnComplete: false,
    });
  };

  const handleMouseDown = async () => {
    if (isSpeakingRef.current) {
      playerRef.current?.stop();
      isSpeakingRef.current = false;
      setIsSpeaking(false);
    }

    isRecordingRef.current = true;
    setIsRecording(true);
    setStatus('LISTENING');

    if (!sessionRef.current) {
      await connectToGemini();
    }

    await recorderRef.current?.start((base64) => {
      if (isRecordingRef.current && sessionRef.current) {
        sessionRef.current.sendRealtimeInput({
          audio: { data: base64, mimeType: 'audio/pcm;rate=16000' }
        });
      }
    });
  };

  const handleMouseUp = () => {
    if (!isRecordingRef.current) return;

    isRecordingRef.current = false;
    setIsRecording(false);

    recorderRef.current?.stop();

    if (sessionRef.current) {
      try {
        sessionRef.current.sendRealtimeInput({ audioStreamEnd: true });
        setStatus('PROCESSING...');
      } catch (e) {
        console.error('audioStreamEnd error', e);
      }
    }
  };

  const submitOrder = async () => {
    if (cart.length === 0) return;
    setStatus('SUBMITTING...');
    try {
      const res = await fetch('/api/agent/submit-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionIdRef.current,
          customer_name: 'Guest',
          customer_phone: '0000000000',
          order_type: 'dine_in',
        }),
      }).then(r => r.json());

      if (res.order_id) {
        setCart([]);
        setStatus('ORDER CONFIRMED');
        setTimeout(() => setStatus('IDLE READY'), 4000);
      } else {
        setStatus('SUBMIT ERROR');
      }
    } catch (err) {
      console.error('submitOrder error:', err);
      setStatus('SUBMIT ERROR');
    }
    sessionRef.current?.close();
  };

  const clearCart = () => {
    setCart([]);
    setStatus('IDLE READY');
    if (sessionRef.current) {
       sessionRef.current.close(); 
    }
  };

  const subtotal = cart.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
  const gst = Math.round(subtotal * 0.15);
  const total = subtotal + gst;

  return (
    <div className="p-8 flex gap-8 w-full h-full select-none">
      <aside className="w-64 flex flex-col gap-6">
        <div className="p-2">
          <h1 className="text-2xl font-serif font-bold text-[#5A5A40]">SAVOUR FOODS</h1>
          <p className="text-xs tracking-widest uppercase opacity-60">Islamabad / Blue Area</p>
        </div>

        <nav className="flex flex-col gap-2 overflow-y-auto max-h-[60vh]">
          {[...new Set(menu.map((m: any) => m.category))].map(cat => (
            <div
              key={cat as string}
              onClick={() => setSelectedCategory(cat as string)}
              className={`sidebar-item p-4 rounded-r-lg cursor-pointer transition-all ${selectedCategory === cat ? 'active' : 'opacity-70 hover:opacity-100 hover:bg-white/10'}`}
            >
              <p className="font-semibold">{cat as string}</p>
              <p className="text-[10px] opacity-50 uppercase">
                {menu.filter((m: any) => m.category === cat).length} Items
              </p>
            </div>
          ))}
        </nav>

        {onNavigateToDashboard && (
          <button
            onClick={onNavigateToDashboard}
            className="w-full py-3 glass-panel rounded-2xl text-xs font-bold uppercase tracking-widest text-[#5A5A40] hover:bg-white/80 transition-colors cursor-pointer"
          >
            Live Orders →
          </button>
        )}

        <div className="mt-auto glass-panel p-4">
          <p className="text-[10px] uppercase tracking-tighter opacity-50 mb-2">System Status</p>
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
            <span className="text-xs font-mono">GEMINI 3.1 FLASH LIVE</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500"></div>
            <span className="text-xs font-mono">LOCAL DB: SYNCED</span>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex flex-col glass-panel relative overflow-hidden">
          {/* Menu Items Grid or PTT View */}
          <div className="flex-1 p-8 overflow-y-auto">
            <h2 className="text-2xl font-serif text-[#5A5A40] mb-6">{selectedCategory} Menu</h2>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {menu.length === 0 ? (
                <div className="col-span-full py-20 text-center opacity-40">Loading menu...</div>
              ) : (
                menu.filter(item => item.category === selectedCategory).map(item => (
                  <div key={item.id} className="p-4 bg-white/40 rounded-xl border border-white/40 hover:border-[#A39171]/40 transition-all group">
                    <div className="flex justify-between items-start mb-1">
                      <h4 className="font-bold text-[#5A5A40]">{item.name}</h4>
                      <span className="font-mono text-sm">PKR {item.display_price || item.price || item.base_price}</span>
                    </div>
                    <p className="text-xs opacity-60 line-clamp-2 mb-3">{item.description}</p>
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] uppercase tracking-widest px-2 py-0.5 bg-white/60 rounded">{item.tag || ''}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Voice Interface Overlay */}
          <div className="absolute bottom-0 left-0 right-0 p-6 flex flex-col items-center pointer-events-none z-50">
            <div className="w-full h-24 bg-gradient-to-t from-[#F8F7F2] to-transparent absolute bottom-0 left-0 right-0 pointer-events-none"></div>
            <div 
              className={`ptt-ring relative flex items-center justify-center cursor-pointer transition-all duration-300 pointer-events-auto z-10 shadow-2xl ${
                isRecording ? 'scale-90 bg-red-600 shadow-red-200' :
                isSpeaking  ? 'bg-gray-400 cursor-not-allowed' :
                'bg-[#5A5A40]'
              }`}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onTouchStart={handleMouseDown}
              onTouchEnd={handleMouseUp}
              style={{ width: '120px', height: '120px' }}
            >
              <div className={`flex items-end gap-1 h-6 ${isRecording ? 'animate-pulse' : ''}`}>
                <div className="wave-line w-1 h-3 bg-white"></div>
                <div className="wave-line w-1 h-6 bg-white"></div>
                <div className="wave-line w-1 h-4 bg-white"></div>
                <div className="wave-line w-1 h-8 bg-white"></div>
                <div className="wave-line w-1 h-3 bg-white"></div>
              </div>
            </div>
            <p className="mt-3 font-bold text-[#5A5A40] tracking-widest uppercase text-[10px] pointer-events-none z-10 drop-shadow-sm">
              {isRecording ? 'Listening...' : isSpeaking ? 'Gemini Speaking...' : 'Push to Talk'}
            </p>
          </div>
        </div>
      </main>

      <aside className="w-80 flex flex-col">
        <div className="glass-panel flex-1 flex flex-col">
          <div className="p-6 border-b border-gray-200">
            <h3 className="text-xl font-bold">Current Order</h3>
            <p className="text-xs opacity-50">Cart Items: {cart.length}</p>
          </div>

          <div className="flex-1 p-6 flex flex-col gap-4 overflow-y-auto">
            {cart.length === 0 ? (
              <p className="text-xs opacity-50 italic text-center mt-10">Your cart is empty.</p>
            ) : (
              cart.map((item, idx) => (
                <div key={idx} className="flex justify-between items-start">
                  <div className="flex-1 pr-2">
                    <p className="font-bold text-sm">{item.summary}</p>
                  </div>
                  <span className="font-mono text-sm whitespace-nowrap">PKR {Math.round(item.unit_price * item.quantity)}</span>
                </div>
              ))
            )}
          </div>

          <div className="p-6 bg-[#5A5A40] text-[#F8F7F2] rounded-b-[24px]">
            <div className="flex justify-between mb-2 opacity-80">
              <span className="text-sm">Subtotal</span>
              <span className="text-sm">PKR {subtotal}</span>
            </div>
            <div className="flex justify-between mb-4">
              <span className="text-sm opacity-80">Sales Tax (GST)</span>
              <span className="text-sm">PKR {gst}</span>
            </div>
            <div className="flex justify-between items-end border-t border-white/20 pt-4">
              <span className="text-xl font-serif">Total</span>
              <span className="text-2xl font-bold">PKR {total}</span>
            </div>
            
            <div className="mt-6 flex flex-col gap-2">
              <button 
                onClick={submitOrder}
                disabled={cart.length === 0}
                className={`w-full py-3 rounded-lg font-bold uppercase tracking-widest text-xs transition-colors ${cart.length > 0 ? 'bg-[#A39171] text-white cursor-pointer hover:bg-[#928263]' : 'bg-white/20 text-white/40 cursor-not-allowed'}`}
              >
                Confirm Order
              </button>
              <button 
                 onClick={clearCart}
                 className="w-full py-2 border border-white/20 rounded-lg text-xs opacity-70 cursor-pointer hover:bg-white/10 transition-colors">
                 Clear All Items
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
