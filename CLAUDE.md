# CLAUDE.md — Savour Foods Voice Kiosk

## Project Overview

This is a **production voice-activated food ordering kiosk** for Savour Foods. Customers speak their order in English, Urdu, or Roman Urdu; Google Gemini processes the speech in real-time, resolves menu items, and builds a cart through tool calls to a backend order-management service. A companion kitchen dashboard shows live order status for staff.

**Key business requirements:**
- Zero-friction ordering: the customer should never need to touch a screen
- Multi-lingual: seamlessly handle English, Urdu, and Roman Urdu in the same utterance
- Accurate item resolution: fuzzy-match dish names, validate required modifiers before adding to cart
- Real-time kitchen visibility: orders appear on the dashboard immediately after submission

---

## Architecture

```
Browser (React 19 + Vite)
  ├── App.tsx               — kiosk UI: menu grid, cart, voice controls
  ├── OrdersDashboard.tsx   — kitchen staff dashboard (polling)
  └── src/lib/
       ├── geminiTools.ts   — tool declarations, system instruction builder, menu context fetch
       └── audioUtils.ts    — Web Audio API: 16 kHz PCM recorder, 24 kHz queued player

Express server (server.ts, port 3000)
  ├── Vite dev middleware (dev) / static dist/ (prod)
  ├── POST /api/gemini-token — exchanges GEMINI_API_KEY for a 60-second ephemeral token;
  │     real key stays on server, browser only ever holds the short-lived token
  └── API proxy → Render backend (voiceai-hzyb.onrender.com)
        ├── /api/agent/*    — cart operations (resolve-item, remove-item, clear-cart, submit-order)
        ├── /api/menu       — full menu for UI grid
        └── /api/orders/*   — order CRUD for kitchen dashboard

Google Gemini Live API  (wss)
  └── gemini-3.1-flash-live-preview
        ├── Browser connects directly using the 60-second ephemeral token (not the real key)
        ├── Input:  16 kHz PCM chunks from AudioRecorder
        ├── Output: 24 kHz PCM chunks to AudioPlayer + function calls
        └── Tools:  add_item, remove_item, clear_cart, confirm_order (handled in App.tsx)

Render backend          (external REST service — not in this repo)
Supabase                (configured; currently reserved for future local backup sync)
Vercel                  (compatible — see "Vercel Deployment" note below)
```

### Data flow for a voice order

```
Customer presses PTT → App.tsx POSTs /api/gemini-token → server exchanges real key for 60s token
  → App creates new GoogleGenAI({ apiKey: ephemeralToken }) — real key never leaves server
  → AudioRecorder (16 kHz PCM base64) → Gemini Live WebSocket (using ephemeral token)
  → Gemini recognises intent → calls add_item(session_id, dish_query, modifiers, qty, notes)
  → App.tsx intercepts tool call → POST /api/agent/resolve-item
  → Render backend fuzzy-matches dish, validates modifiers
  → Returns {status:"ok", summary, unit_price, cart_item_id} or {status:"requires_input", ai_instruction}
  → App sends tool response back to Gemini
  → Gemini speaks confirmation to customer (24 kHz PCM → AudioPlayer)
  → Customer says "confirm" → Gemini calls confirm_order → POST /api/agent/submit-order
  → Order appears on kitchen dashboard within one 60 s poll cycle
```

---

## File Map

| Path | Responsibility |
|---|---|
| `server.ts` | Express entry point; Vite middleware; API proxy to Render; warm-up ping; **`/api/gemini-token` ephemeral token endpoint** |
| `src/App.tsx` | Main kiosk component; fetches ephemeral token; Gemini session lifecycle; cart state; tool-call dispatch |
| `src/OrdersDashboard.tsx` | Kitchen dashboard; order polling; status transitions |
| `src/lib/geminiTools.ts` | Tool declarations (FunctionDeclaration[]); system instruction builder; menu context fetch with retry+cache |
| `src/lib/audioUtils.ts` | AudioRecorder (ScriptProcessor, 16 kHz → PCM base64); AudioPlayer (queued BufferSource, 24 kHz) |
| `vite.config.ts` | Vite build; injects `process.env.GEMINI_API_KEY` at build time; conditional HMR |
| `vercel.json` | Production rewrites `/api/:path*` → Render `/api/v1/:path*` |

---

## Environment Variables

All secrets live in `.env` (never committed — see `.env.example`).

| Variable | Used in | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | `server.ts` only | Authenticates Gemini Live API calls — **never sent to the browser** |
| `SUPABASE_URL` | `server.ts` | Supabase project URL |
| `SUPABASE_KEY` | `server.ts` | Supabase anon/service key |
| `BACKEND_URL` | `server.ts` | Render backend base URL (defaults to `https://voiceai-hzyb.onrender.com`) |
| `NODE_ENV` | `server.ts`, `vite.config.ts` | `development` enables Vite middleware; `production` serves `dist/` |
| `DISABLE_HMR` | `vite.config.ts` | Set `true` in AI Studio environments to disable hot-module replacement |

**Critical:** `GEMINI_API_KEY` lives exclusively in the server process. The browser never sees the key — only the 60-second ephemeral token returned by `/api/gemini-token`.

### Vercel Deployment

The `/api/gemini-token` endpoint lives in `server.ts` but `vercel.json` rewrites all `/api/*` to the Render backend. To deploy on Vercel, create a Vercel serverless function at `api/gemini-token.ts`:

```typescript
// api/gemini-token.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) return res.status(500).json({ error: 'Server configuration error' });
  try {
    const r = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-live-preview:generateEphemeralToken',
      { ttl: '60s' },
      { headers: { 'x-goog-api-key': geminiApiKey }, timeout: 10000 }
    );
    const ephemeralToken = r.data.token ?? r.data.ephemeralToken;
    if (!ephemeralToken) throw new Error('No token in response');
    res.json({ ephemeralToken });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
```

Vercel serverless functions in `api/` take precedence over `vercel.json` rewrites, so `/api/gemini-token` will be served by this function and not forwarded to Render.

---

## API Routes (Express proxy)

Every `/api/*` route proxies to the Render backend. The local server adds only logging and error normalisation — no business logic lives here.

| Method | Local path | Backend path | Purpose |
|---|---|---|---|
| GET | `/api/agent/menu-context` | `/api/v1/agent/menu-context` | Markdown menu injected into Gemini system prompt |
| POST | `/api/agent/resolve-item` | `/api/v1/agent/resolve-item` | Fuzzy-match dish + validate modifiers; returns cart_item_id |
| POST | `/api/agent/remove-item` | `/api/v1/agent/remove-item` | Remove one item by cart_item_id |
| POST | `/api/agent/clear-cart` | `/api/v1/agent/clear-cart` | Empty the session cart |
| GET | `/api/agent/cart/:sessionId` | `/api/v1/agent/cart/:sessionId` | Retrieve current cart state |
| POST | `/api/agent/submit-order` | `/api/v1/agent/submit-order` | Finalise and persist order (expects 201) |
| GET | `/api/menu` | `/api/v1/menu` | Full menu for the UI grid |
| GET | `/api/orders` | `/api/v1/orders` | Orders by status for kitchen dashboard |
| PATCH | `/api/orders/:orderId/status` | `/api/v1/orders/:orderId/status` | Advance order status |
| GET | `/api/health` | (local) | Validate Supabase config |

---

## Gemini Live Session Lifecycle

```
connectToGemini()
  1. POST /api/gemini-token → server exchanges real API key for a 60-second ephemeral token
  2. new GoogleGenAI({ apiKey: ephemeralToken }).live.connect(model, {tools, systemInstruction, ...})
  3. Wait for BOTH session object AND WebSocket onopen before resolving
  4. Register: onmessage, onerror, onclose
  5. On failure: retry up to 3× with exponential backoff (1.5 s, 3 s, 4.5 s)

handleToggleRecording()
  PTT (push-to-talk):
  - Press: connectToGemini (if not connected) → audioRecorder.start(sendChunk)
  - Release: audioRecorder.stop() → session.sendRealtimeInput({audioStreamEnd:true})

onmessage handler
  - Audio chunks → audioPlayer.playPCM(base64, sampleRate)
  - toolCall → dispatch each functionCall to its handler → collect responses → session.sendToolResponse()
  - onQueueEmpty fires when Gemini finishes speaking → update status to IDLE / RECORDING

Cleanup
  - session.close() on component unmount
  - audioRecorder.destroy() + audioPlayer.stop() on unmount
```

**Invariants to preserve:**
- Never call `start()` if `isConnectingRef.current` is true (prevents duplicate connections)
- Never call `sendRealtimeInput` after `audioStreamEnd:true` on the same turn
- Always send a tool response for every function call in a batch, even if the backend call failed
- A fresh ephemeral token is fetched on every new `connectToGemini()` call (tokens are 60 s TTL)

---

## Audio Pipeline

### Recording (client → Gemini)
- `AudioContext` at 16 000 Hz
- `ScriptProcessorNode` (bufferSize 4096, mono)
- Each `onaudioprocess`: float32 → int16 (clamped) → Uint8Array → binary string → base64
- Sent as `{audio: {data: base64, mimeType: "audio/pcm;rate=16000"}}`

### Playback (Gemini → speaker)
- `AudioContext` at 24 000 Hz
- Each PCM chunk: base64 → int16 → float32 (÷ 32768) → `AudioBuffer`
- `BufferSource.start(nextTime)` schedules sequential playback without gaps
- `onQueueEmpty` callback fires when the last scheduled buffer ends

**Do not change sample rates** without updating the `mimeType` sent to Gemini and the `AudioContext` constructor in `AudioPlayer`.

---

## Cart Data Model

```typescript
interface CartItem {
  cart_item_id: string;   // server-assigned UUID
  summary: string;        // human-readable, e.g. "Special Choice Pulao × 1 (leg, chest, boxed)"
  quantity: number;
  unit_price: number;
}
```

GST is calculated in the UI only: `subtotal * 0.15`. It is NOT stored in the cart — do not move tax calculation to the backend without updating `OrdersDashboard` totals as well.

---

## Order Status Machine

```
pending → confirmed → preparing → ready → out_for_delivery → delivered
```

- `pending` and `confirmed` both appear in the "Incoming" column on the dashboard
- `out_for_delivery` is a valid terminal-ish state for delivery orders; do not skip it
- Status transitions are driven by kitchen staff button clicks in `OrdersDashboard.tsx`
- The backend enforces valid transitions; the frontend does not need to re-validate

---

## Session ID

Each kiosk browser tab generates a `sessionIdRef` UUID with `crypto.randomUUID()` on mount. This ID is passed in every tool call and identifies the cart on the backend. It is not rotated between orders — clearing the cart resets its contents but keeps the same session ID for the browser session lifetime.

---

## Menu Context Caching

`fetchMenuContext()` in `geminiTools.ts`:
1. Tries up to 4 times with exponential backoff (1.5 s, 3 s, 4.5 s)
2. Writes successful response to `localStorage` key `savour_menu_context_v1`
3. Falls back to the cached version if all attempts fail
4. Treats any JSON-shaped response (error object) as a failure and retries

The cache has no TTL. If the menu changes, staff must clear `localStorage` on the kiosk browser or bump the cache key version in `geminiTools.ts`.

---

## Production Checklist

Before every deployment, verify all of the following:

### Secrets & Configuration
- [ ] `.env` is in `.gitignore` and has NOT been committed — check `git log -- .env`
- [ ] `GEMINI_API_KEY` rotated if the old key was ever exposed in version control
- [ ] `BACKEND_URL` points to the correct production Render service
- [ ] `NODE_ENV=production` is set in the hosting environment
- [ ] Vercel environment variables mirror `.env` (set via Vercel dashboard, not `vercel.json`)

### Build & Types
- [ ] `npm run lint` (tsc --noEmit) passes with zero errors
- [ ] `npm run build` completes without warnings about undefined env vars
- [ ] Bundle size reviewed — no accidental inclusion of dev-only modules

### Functionality (manual smoke test on staging)
- [ ] Voice order end-to-end: speak an item, hear confirmation, cart updates
- [ ] Multi-item order with modifiers resolves correctly
- [ ] `requires_input` flow: Gemini asks follow-up, re-calls `add_item` with updated modifiers
- [ ] Manual cart add/remove buttons (if any) and manual "Confirm Order" button
- [ ] Kitchen dashboard loads, displays orders, and status transitions work
- [ ] First PTT press connects and plays back audio (cold-start scenario)
- [ ] Network error during `resolve-item` → Gemini receives error response and recovers gracefully

### Security
- [ ] No API keys logged to the browser console in production builds
- [ ] Proxy routes do not forward arbitrary headers that could leak internal info
- [ ] `express.json()` body size limit is appropriate (default 100 kb is fine for this use case)
- [ ] Supabase key used is the anon key, not the service-role key, if Supabase is activated

---

## Code Quality Standards

### General
- TypeScript strict mode is on — never use `any` except at genuine JSON boundary points (API responses); cast to a typed interface immediately after
- No `console.log` in production paths; use prefixed logging (`[AGENT]`, `[ORDERS]`, `[AUDIO]`) so logs are filterable
- Handle every `Promise` rejection — unhandled rejections crash the Node process in production
- Prefer `const` over `let`; never `var`

### React
- State updates that depend on previous state must use the functional updater form: `setCart(prev => ...)`
- Never mutate `ref.current` inside a render; refs are for values that must survive re-renders without triggering them
- `useEffect` cleanup functions must disconnect/stop/destroy any resource they open (WebSocket, AudioContext, timers)
- Avoid storing derived values in state if they can be computed from existing state during render

### Backend / Proxy
- Every proxy route must forward the exact HTTP status code returned by the backend — do not flatten to 200
- Log request bodies only at debug level or behind a `NODE_ENV !== 'production'` guard in final form
- Validate `req.params.orderId` format before forwarding to prevent path-injection

### Gemini Integration
- Always send a `sendToolResponse` for every function call received, even on error — failing to respond stalls the Gemini turn indefinitely
- The system instruction is rebuilt on every `connectToGemini` call so menu changes take effect on reconnect without a page reload; keep `buildSystemInstruction` pure and fast
- Do not add blocking `await` inside the `onmessage` callback for audio chunks — audio processing must stay synchronous or use a queue

### Audio
- ScriptProcessor is deprecated but required for compatibility — if migrating to AudioWorklet, test on all target browsers before removing the old path
- Always call `audioRecorder.destroy()` (not just `stop()`) on component unmount to close the AudioContext and release the microphone

---

## Double-Check Protocol

For any non-trivial change, work through this before marking done:

1. **Read the relevant files** before editing — never patch from memory
2. **Trace the full data flow** for the feature being changed: input → state → API call → response → UI update
3. **Check both success and error paths** — the error path is where production bugs live
4. **Verify Gemini tool response shape** matches what `App.tsx` expects when adding or changing tools
5. **Test the audio timing** when touching `audioUtils.ts` — incorrect `nextTime` scheduling causes overlapping or gapped speech
6. **Confirm the proxy status code** is forwarded correctly when adding a new route to `server.ts`
7. **Run `npm run lint`** after every change — type errors in Gemini tool declarations are a common source of silent runtime failures
8. **Check localStorage** if changing the menu context cache key or schema — stale cache causes Gemini to use the wrong menu

---

## Common Failure Modes

| Symptom | Likely cause | Where to look |
|---|---|---|
| First PTT press produces no audio | WebSocket not yet open when audio starts | `connectToGemini` dual-flag coordinator (`wsOpen` + `pendingSession`) in `App.tsx` |
| `/api/gemini-token` returns 404 or error | Model may not support ephemeral tokens yet, or wrong endpoint | Check server logs `[TOKEN]`; verify the `generateEphemeralToken` endpoint with Google's docs |
| Gemini doesn't respond after `add_item` | Missing or malformed `sendToolResponse` | Tool call handler in `App.tsx` `onmessage` |
| Cart shows item but backend disagrees | Tool response optimistically updates UI before backend confirms | `add_item` handler — only add to local cart on `status === "ok"` |
| `requires_input` loop never ends | Gemini re-sends the same modifiers | System instruction MUST say to re-call `add_item` with the customer's new input, not the original |
| Kitchen dashboard shows stale orders | 60 s polling interval; status update race | `OrdersDashboard.tsx` poll vs. optimistic update after PATCH |
| Render backend returns 503 on first request | Free-tier cold start | Warm-up ping in `server.ts` startup; increase axios timeout if needed |
| Menu context fetch fails silently | All 4 retries exhausted, cache is stale | Check `localStorage.getItem('savour_menu_context_v1')` in browser dev tools |

---

## Known Technical Debt

- **[RESOLVED]** `GEMINI_API_KEY` baked into bundle — server now vends a 60-second ephemeral token via `POST /api/gemini-token`; the real key is used only inside the Node.js process and never appears in any browser network request.
- **[RESOLVED]** No rate limiting — `express-rate-limit` added: 200 req/15 min general, 100 req/15 min for agent routes, 10 req/min for token endpoint.
- **[RESOLVED]** Supabase client imported but unused — removed entirely from `server.ts` and `package.json`.
- **[RESOLVED]** Menu cache had no TTL — cache now stores `cached_at` timestamp; entries expire after 6 hours.
- **[RESOLVED]** Implicit `any` types throughout — typed interfaces added for `MenuItem`, `ResolveItemResponse`, `SubmitOrderResponse`, `GeminiLiveSession`; `@types/react` installed to fix JSX type inference.

**Remaining:**
- `ScriptProcessorNode` is deprecated — plan migration to `AudioWorkletNode`; test on all target browsers before removing the old path.
- Session IDs are never expired or invalidated server-side — the backend must enforce this.
- The `generateEphemeralToken` endpoint availability depends on Google's support for `gemini-3.1-flash-live-preview`. If unavailable, `[TOKEN]` errors will appear in server logs — either wait for Google to enable it or migrate to a GA model that supports it.
- For Vercel deployment: add `api/gemini-token.ts` serverless function (see "Vercel Deployment" note in Environment Variables section).
