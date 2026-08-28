import { useCallback, useEffect, useRef, useState } from 'react';
import { GoogleGenAI, Modality, type FunctionDeclaration } from '@google/genai';
import { AudioRecorder, AudioPlayer } from '../lib/audioUtils';

// Voice ordering at the table.
//
// The same Gemini Live agent the kiosk uses, on the diner's own phone. Three
// things differ from the kiosk, and all three are decided server-side:
//
//   • The system prompt is built with channel 'qr' — it knows the table, never
//     asks for it, never offers pickup or delivery, never mentions payment.
//   • The tools carry no session_id. The dine session comes from the guest
//     token, so a phone cannot name someone else's session.
//   • The API key never reaches the phone; /api/guest/voice/session mints a
//     60-second ephemeral token, exactly as the kiosk does.
//
// Push-to-talk rather than open-mic, deliberately: a table is a noisy place with
// several people talking, and an always-listening mic would pick up the whole
// conversation and try to order it.

type Status = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

interface VoiceSession {
  token: string;
  model: string;
  voice: string;
  systemInstruction: string;
}

// Minimal structural type for the Live session — the SDK's own type is not
// exported in a usable form, and this is every method actually called.
interface LiveSession {
  sendRealtimeInput(input: Record<string, unknown>): void;
  sendToolResponse(response: { functionResponses: unknown[] }): void;
  close(): void;
}

export default function GuestVoice({
  token, onCartChanged, onOrderPlaced, currency,
}: {
  token: string;
  onCartChanged: () => void;
  onOrderPlaced: (orderNumber: number | null) => void;
  currency: string;
}) {
  const [status,     setStatus]     = useState<Status>('idle');
  const [transcript, setTranscript] = useState<string>('');
  const [error,      setError]      = useState<string | null>(null);
  const [supported]                 = useState(() => isSupported());

  const sessionRef  = useRef<LiveSession | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const playerRef   = useRef<AudioPlayer | null>(null);
  const connectingRef = useRef(false);
  const heldRef       = useRef(false);

  const api = useCallback((path: string, init: RequestInit = {}) =>
    fetch(`/api/guest${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    }), [token]);

  // ── Tool dispatch ──────────────────────────────────────────────────────────
  // Every tool the agent can call maps to a guest route. None of them takes a
  // session id: the server reads it from the token.
  const runTool = useCallback(async (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case 'add_item': {
        const res = await api('/cart/item', {
          method: 'POST',
          body: JSON.stringify({
            dishQuery: String(args.dish_query ?? ''),
            modifiers: Array.isArray(args.modifiers) ? args.modifiers.map(String) : undefined,
            quantity:  typeof args.quantity === 'number' ? args.quantity : undefined,
            notes:     args.notes ? String(args.notes) : null,
          }),
        });
        const body = await res.json() as Record<string, unknown>;
        onCartChanged();
        return body;
      }
      case 'remove_item': {
        await api(`/cart/item/${String(args.cart_item_id ?? '')}`, { method: 'DELETE' });
        onCartChanged();
        return { status: 'ok' };
      }
      case 'clear_cart': {
        await api('/cart', { method: 'DELETE' });
        onCartChanged();
        return { status: 'ok' };
      }
      case 'confirm_order': {
        const res  = await api('/order', {
          method: 'POST',
          body:   JSON.stringify({ guestName: args.customer_name ? String(args.customer_name) : undefined }),
        });
        const body = await res.json() as { error?: string; orderNumber?: number; total?: number };
        if (!res.ok) return { status: 'error', message: body.error ?? 'Could not send the order' };
        onCartChanged();
        onOrderPlaced(body.orderNumber ?? null);
        return {
          status: 'ok',
          message: `Order number ${body.orderNumber} has been sent to the kitchen. The total is ${currency} ${(body.total ?? 0).toFixed(2)}.`,
        };
      }
      default:
        return { status: 'error', message: `Unknown tool ${name}` };
    }
  }, [api, onCartChanged, onOrderPlaced, currency]);

  // ── Connect ────────────────────────────────────────────────────────────────
  const connect = useCallback(async (): Promise<LiveSession | null> => {
    if (sessionRef.current) return sessionRef.current;
    if (connectingRef.current) return null;

    connectingRef.current = true;
    setStatus('connecting');
    setError(null);

    try {
      const res = await api('/voice/session', { method: 'POST', body: JSON.stringify({}) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Voice is unavailable');
      }
      const cfg = await res.json() as VoiceSession;

      const player = new AudioPlayer();
      // Fires when the agent has finished speaking, so the button can go back
      // to idle rather than looking stuck on "speaking".
      player.onQueueEmpty = () => setStatus(s => (s === 'speaking' ? 'idle' : s));
      playerRef.current = player;

      const ai = new GoogleGenAI({ apiKey: cfg.token, httpOptions: { apiVersion: 'v1alpha' } });

      // Resolve only once the socket is genuinely open. Resolving on the
      // session object alone is what made the kiosk's first press silent — the
      // first audio chunks were written before the WebSocket was ready.
      const session = await new Promise<LiveSession>((resolve, reject) => {
        let opened  = false;
        let pending: LiveSession | null = null;
        const settle = () => { if (opened && pending) resolve(pending); };

        void ai.live.connect({
          model: cfg.model,
          config: {
            responseModalities:  [Modality.AUDIO],
            systemInstruction:   cfg.systemInstruction,
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } },
            },
            tools: [{ functionDeclarations: guestTools() }],
          },
          callbacks: {
            onopen:  () => { opened = true; settle(); },
            onerror: (e: unknown) => reject(e instanceof Error ? e : new Error('Voice connection failed')),
            onclose: () => {
              sessionRef.current = null;
              setStatus(s => (s === 'error' ? s : 'idle'));
            },
            onmessage: (msg) => { void handleMessage(msg as unknown as Record<string, unknown>); },
          },
        }).then(s => { pending = s as unknown as LiveSession; settle(); }, reject);
      });

      sessionRef.current = session;
      return session;
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      connectingRef.current = false;
    }

    async function handleMessage(msg: Record<string, unknown>) {
      // Audio out.
      const sc = msg.serverContent as Record<string, unknown> | undefined;
      const parts = (sc?.modelTurn as { parts?: Array<Record<string, unknown>> } | undefined)?.parts;
      if (parts) {
        for (const part of parts) {
          const inline = part.inlineData as { data?: string; mimeType?: string } | undefined;
          if (inline?.data) {
            setStatus('speaking');
            playerRef.current?.playPCM(inline.data, 24000);
          }
          if (typeof part.text === 'string' && part.text.trim()) {
            setTranscript(part.text.trim());
          }
        }
      }

      // Barge-in: the model tells us the user interrupted. Drop everything
      // queued, or the agent keeps talking over them for several seconds.
      if (sc?.interrupted) {
        playerRef.current?.stop();
        setStatus('listening');
      }

      // Tool calls.
      const toolCall = msg.toolCall as { functionCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }> } | undefined;
      if (toolCall?.functionCalls?.length) {
        setStatus('thinking');
        const responses = [];
        // Sequential, not Promise.all: two add_item calls in one turn would
        // otherwise race on the same cart.
        for (const fc of toolCall.functionCalls) {
          let response: unknown;
          try {
            response = await runTool(fc.name, fc.args ?? {});
          } catch (err) {
            response = { status: 'error', message: err instanceof Error ? err.message : 'failed' };
          }
          responses.push({ id: fc.id, name: fc.name, response });
        }
        // Every call must get a response or the turn stalls forever.
        sessionRef.current?.sendToolResponse({ functionResponses: responses });
      }
    }
  }, [api, runTool]);

  // ── Push to talk ───────────────────────────────────────────────────────────

  const startTalking = useCallback(async () => {
    heldRef.current = true;
    const session = sessionRef.current ?? await connect();
    // The finger may have lifted while we were connecting.
    if (!session || !heldRef.current) return;

    try {
      playerRef.current?.stop();          // barge in on the agent
      const recorder = recorderRef.current ?? new AudioRecorder();
      recorderRef.current = recorder;
      await recorder.start((base64: string) => {
        sessionRef.current?.sendRealtimeInput({
          audio: { data: base64, mimeType: 'audio/pcm;rate=16000' },
        });
      });
      setStatus('listening');
    } catch (err) {
      setStatus('error');
      setError(
        (err as Error).name === 'NotAllowedError'
          ? 'Microphone permission was denied. You can still tap items on the menu.'
          : 'Could not use the microphone.',
      );
    }
  }, [connect]);

  const stopTalking = useCallback(() => {
    if (!heldRef.current) return;
    heldRef.current = false;
    recorderRef.current?.stop();
    // Tells the model the turn is over so it answers instead of waiting.
    sessionRef.current?.sendRealtimeInput({ audioStreamEnd: true });
    setStatus(s => (s === 'listening' ? 'thinking' : s));
  }, []);

  useEffect(() => () => {
    recorderRef.current?.destroy();
    playerRef.current?.stop();
    sessionRef.current?.close();
  }, []);

  if (!supported) {
    return (
      <p className="text-xs text-center text-slate-500 px-4 py-2">
        Voice ordering needs a newer browser. Tap items on the menu instead.
      </p>
    );
  }

  return (
    <div className="px-4 py-3 border-t border-slate-200 bg-white">
      {(transcript || error) && (
        <p className={`text-xs text-center mb-2 line-clamp-2 ${error ? 'text-red-700' : 'text-slate-500'}`}>
          {error ?? transcript}
        </p>
      )}

      <button
        // Pointer events cover mouse, touch and pen with one path, and
        // setPointerCapture means sliding a thumb off the button still ends the
        // turn — without it the recorder runs until the page is closed.
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); void startTalking(); }}
        onPointerUp={stopTalking}
        onPointerCancel={stopTalking}
        onContextMenu={e => e.preventDefault()}
        className={`w-full min-h-[60px] rounded-2xl font-bold text-white transition select-none touch-none ${
          status === 'listening' ? 'bg-red-600 scale-[0.99]'
          : status === 'speaking' ? 'bg-emerald-600'
          : status === 'thinking' || status === 'connecting' ? 'bg-slate-400'
          : status === 'error' ? 'bg-slate-500'
          : 'bg-slate-900'
        }`}
      >
        {LABEL[status]}
      </button>

      <p className="text-[11px] text-center text-slate-400 mt-1.5">
        Hold and speak — in English or Urdu
      </p>
    </div>
  );
}

const LABEL: Record<Status, string> = {
  idle:       'Hold to speak',
  connecting: 'Connecting…',
  listening:  'Listening — keep holding',
  thinking:   'One moment…',
  speaking:   'Speaking…',
  error:      'Tap to try again',
};

/**
 * The kiosk's tools with `session_id` stripped.
 *
 * The dine session is in the guest's token, so the model has no business
 * knowing it and no way to name a different one. This mirrors exactly what the
 * WhatsApp handler does for the same reason.
 */
function guestTools(): FunctionDeclaration[] {
  const strip = (d: FunctionDeclaration): FunctionDeclaration => {
    const props = { ...(d.parameters?.properties ?? {}) } as Record<string, unknown>;
    delete props.session_id;
    return {
      ...d,
      parameters: {
        ...d.parameters,
        properties: props,
        required: (d.parameters?.required ?? []).filter(r => r !== 'session_id'),
      },
    } as FunctionDeclaration;
  };

  // Imported lazily through a static list rather than pulling geminiTools'
  // localStorage menu cache into the guest bundle.
  return TOOLS.map(strip);
}

// Kept in step with src/lib/geminiTools.ts. Duplicated rather than imported so
// the guest bundle does not also pull in that module's menu-context fetching
// and localStorage cache, which a diner's phone has no use for.
const TOOLS: FunctionDeclaration[] = [
  {
    name: 'add_item',
    description:
      'Add a dish to the order. Pass the dish name exactly as the customer said it. ' +
      'Pass ALL customisations they mentioned as plain strings. If the server returns ' +
      'status="requires_input", speak ai_instruction and call add_item again with their answer.',
    parameters: {
      type: 'OBJECT',
      properties: {
        session_id:  { type: 'STRING' },
        dish_query:  { type: 'STRING', description: 'Dish name as the customer said it.' },
        modifiers:   { type: 'ARRAY', items: { type: 'STRING' }, description: 'All customisations mentioned.' },
        quantity:    { type: 'INTEGER', description: 'How many. Default 1.' },
        notes:       { type: 'STRING', description: 'Special instructions for this item.' },
      },
      required: ['session_id', 'dish_query'],
    },
  },
  {
    name: 'remove_item',
    description: 'Remove one item using the cart_item_id returned by a previous add_item.',
    parameters: {
      type: 'OBJECT',
      properties: {
        session_id:   { type: 'STRING' },
        cart_item_id: { type: 'STRING' },
      },
      required: ['session_id', 'cart_item_id'],
    },
  },
  {
    name: 'clear_cart',
    description: 'Remove ALL items and start the order fresh.',
    parameters: {
      type: 'OBJECT',
      properties: { session_id: { type: 'STRING' } },
      required: ['session_id'],
    },
  },
  {
    name: 'confirm_order',
    description:
      'Send the order to the kitchen, after the customer explicitly confirms. ' +
      'Always read back the full order and total BEFORE calling this. ' +
      'Read the returned message back to the customer word for word.',
    parameters: {
      type: 'OBJECT',
      properties: {
        session_id:    { type: 'STRING' },
        customer_name: { type: 'STRING', description: "The guest's name, if they gave one." },
      },
      required: ['session_id'],
    },
  },
] as unknown as FunctionDeclaration[];

function isSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.AudioContext !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia);
}
