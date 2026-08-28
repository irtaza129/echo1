# CLAUDE.md — Echo POS

## What this is

A **multi-tenant restaurant point-of-sale** built around a voice agent. Restaurants
sign up, configure their menu and persona, and get a till plus four customer-facing
ordering channels — all writing to one order ledger.

**Voice is the product, not a feature.** Every customer-facing channel is voice-first;
tapping is the fallback. Treat it that way when changing anything.

| Channel | Who uses it | Where |
|---|---|---|
| **Kiosk** | Walk-up customer, screen in the restaurant | `src/App.tsx` |
| **Table QR** | Diner on their own phone | `src/guest/` (separate bundle) |
| **Phone** | Caller on a SIP trunk | `telephony/` |
| **WhatsApp** | Customer messaging the business number | `telephony/WhatsAppHandler.ts` |
| **Till** | Cashier / manager | `src/pos/` |

---

## Architecture

```
Browser (React 19 + Vite, TWO entry points)
  ├── index.html → src/main.tsx     staff: kiosk, admin, super-admin, TILL
  └── guest.html → src/guest/       diner's phone: menu, voice, tracking, call waiter
                                    (never receives the till bundle — see vite.config.ts)

Express (server.ts, port 3000)
  ├── /api/auth/*        login, register, verify
  ├── /api/admin/*       tenant config, menu, staff, usage, audit
  ├── /api/super/*       platform owner
  ├── /api/agent/*       voice tools (kiosk) — soft tenant resolution, no login
  ├── /api/pos/*         the till       [requireAuth → attachAdapter → requireFeature('pos')]
  ├── /api/pos/stream    SSE event feed [same chain]
  ├── /api/reservations/*                [same chain, requireFeature('reservations')]
  ├── /api/guest/*       diner's phone  [requireGuest ONLY — its own gate]
  ├── /api/billing/*     Paddle (SaaS subscriptions)
  ├── /api/payments/*    diner card payments
  └── /telephony/whatsapp/webhook

Postgres (Supabase)   ← the single order ledger, and platform state
Redis (Upstash)       ← carts, caches, routing, rate-limit counters. NEVER orders.
Asterisk + SIP trunk  ← phone channel (optional, SIP_ENABLED)
Gemini Live API       ← the voice agent, on every channel
```

### The adapter layer

`config.adapter.type` decides where a tenant's menu and orders live:

| Type | Menu + orders |
|---|---|
| `pos` | **Our own Postgres.** The native POS. |
| `managed` | The external Render/FastAPI backend. |
| `custom_api` | The tenant's own REST API, via `endpointMappings`. |
| `webhook` | Fire-and-forget POST to the tenant's URL. |

Routes call `req.adapter.*` and never branch on tenant. If you find yourself
writing `if (tenant is X)` in a route, the logic belongs in an adapter.

---

## Non-negotiables

These are the rules that took real bugs to learn. Breaking one is not a style
disagreement.

1. **One order ledger.** Every channel submits through `req.adapter.submitOrder`.
   Orders live in Postgres `public.orders`. Redis holds carts and caches only.
   `orders.source` (`pos|kiosk|phone|whatsapp|qr|web`) is a closed set with a DB
   check constraint, because it drives channel attribution.

2. **Totals are computed server-side, once.** `computeTotals()` in
   `src/lib/posRepo.ts` is the only version that counts. The till prices a basket
   through `POST /api/pos/quote`, which runs that same function. Never do money
   arithmetic in a component.

3. **Never patch totals incrementally.** Re-derive from live lines
   (`ordersRepo.recomputeTotals`). Incremental addition makes the result depend on
   the order edits happened in.

4. **Never discount or void below what has been paid.** Both paths preview the
   result and refuse *before* writing, so a rejected action changes nothing.

5. **Manager approval is a server check.** `approve()` in `routes/pos.ts`
   re-identifies the PIN and reads that operator's stored permissions, including
   `max_discount_pct`. `ManagerApproval.tsx` is a convenience, not the control.

6. **Guest and staff tokens are mutually exclusive.** `requireAuth` rejects
   `role: 'guest'`; `requireGuest` accepts nothing else. A guest token is validly
   signed for a real tenant, so "is this token valid?" is never sufficient.
   Both directions are asserted in `testing/test-guest-isolation.ts`.

7. **Guests are identified by their token, never by the request.** `tableId` and
   `dineSessionId` come from the JWT. Nothing in `routes/guest.ts` reads a table
   from a body or query.

8. **The real Gemini key never reaches a browser.** Kiosk and guest both get a
   60-second ephemeral token. The server-side phone bridge uses the real key
   because it *is* the server.

9. **Tool calls run sequentially, never `Promise.all`.** Two `add_item` calls in
   one turn race on the same cart. `session_id` is stripped from tools on every
   channel except the kiosk — the session is the call/table/number.

10. **A failed side-effect never fails a committed sale.** Audit writes, prints,
    and event publishes are best-effort *after* the money moved. Returning non-2xx
    invites the client to retry the sale.

---

## File map

| Path | Responsibility |
|---|---|
| `server.ts` | Express entry, auth, rate limits, agent/menu/order routes, SPA + guest routing |
| `routes/pos.ts` | Till: tables, orders, tabs, tender, refunds, shifts, PINs, KDS, print, reports |
| `routes/guest.ts` | Diner's phone. Its own gate, no `attachAdapter` |
| `routes/stream.ts` | SSE. Read the comment on why it is not `EventSource` |
| `routes/reservations.ts` | Bookings, availability, waitlist |
| `routes/billing.ts` | Paddle webhook + tenant subscription |
| `middleware/tenant.ts` | `attachAdapter` — soft tenant resolution, 403 on JWT/header mismatch |
| `middleware/guest.ts` | `requireGuest` — the mirror of `requireAuth` |
| `middleware/requireFeature.ts` | Module entitlement, fails closed |
| `adapter/` | `IRestaurantAdapter` + four implementations + fuzzy matching |
| `payments/` | `IPaymentProvider`: cash, Paddle, Safepay |
| `telephony/` | WhatsApp, phone agent, shared tool dispatch |
| `telephony/sip/` | AudioSocket framing, resampling, ARI. See `README-asterisk.md` |
| `src/pos/` | The till: order entry, tender, KDS, shift, bookings, reports |
| `src/guest/` | The diner's phone app (separate Vite entry) |
| `src/lib/posRepo.ts` | Orders, payments, shifts, tables — **money lives here** |
| `src/lib/posEvents.ts` | In-process event bus behind the SSE stream |
| `src/lib/escpos.ts` | Receipt and kitchen-ticket bytes |
| `src/lib/PromptBuilder.ts` | System prompt per channel (`kiosk｜whatsapp｜qr｜phone`) |
| `migrations/` | **Canonical schema.** `db/schema.sql` is a stale reference only |

---

## Operator scripts

There is no admin UI for these yet.

```bash
# Turn modules on for a tenant (requireFeature fails closed, so nothing works until this runs)
npx tsx --env-file=.env scripts/enable-pos.ts --slug <slug> [--native] [--qr] [--phone --did '+92…'] [--show]

# Till PINs
npx tsx --env-file=.env scripts/set-staff-pin.ts --tenants
npx tsx --env-file=.env scripts/set-staff-pin.ts --tenant <uuid> --email <e> --pin 4817

# Tables + printable QR cards (writes cards.html)
npx tsx --env-file=.env scripts/table-qr.ts --slug <slug> --add "1,2,3"
npx tsx --env-file=.env scripts/table-qr.ts --slug <slug> --issue-all --base https://…

# Move a tenant's Redis menu/orders into Postgres, then switch them to the native POS
npx tsx --env-file=.env scripts/backfill-pos.ts --tenant <uuid> --write --activate
```

---

## Testing

```bash
npm run lint          # tsc --noEmit — covers src, routes, telephony, scripts, adapter, middleware
npm test              # ~200 checks, no DB or network needed
npm run build

# Live suites — real Postgres, each cleans up after itself in a finally
npm run test:live    -- --tenant <uuid>   # till: create → tab → split tender → X report
npm run test:guest   -- --slug <slug>     # QR: scan → PIN → call waiter → voice session
npm run test:kds     -- --tenant <uuid>   # bump → order ready → recall
npm run test:reports -- --tenant <uuid>
```

Tests are bare `tsx` + `node:assert`. No runner. Add new suites to `scripts.test`.

---

## Conventions

- **TypeScript strict.** `any` only at a genuine JSON boundary, cast immediately.
- **Prefixed logs** (`[POS]`, `[GUEST]`, `[PHONE]`, `[AUDIOSOCKET]`) so they filter.
- **Money is `numeric(12,2)`**, never float. Gateway amounts are integer minor units.
- **Comments explain *why*.** The codebase is dense with rationale for decisions
  that look arbitrary — read it before "simplifying" something.
- Functional `setState` updaters; `useEffect` cleanups must release what they open.

---

## Known gaps

Honest list. None of these is secretly finished.

- **Phone channel is untested end-to-end.** The code and its unit/transport tests
  are done; it has never handled a real call because it needs Asterisk, a trunk and
  a static IP. Trunk **must** offer G.711 — G.729 presents as a connected call with
  total silence.
- **FBR / PRA e-invoicing is not built.** Legally required for Pakistani
  restaurants. Design as a `TaxAuthorityProvider` mirroring `IPaymentProvider`, with
  a durable retry queue: a failed submission must never block a sale nor be dropped.
- **Safepay is implemented but unwired.** `payments/SafepayProvider.ts` is complete
  and unreachable; Paddle rejects PKR, so PKR tenants are cash-only until it is wired.
- **No inventory, no multi-branch.** `orders.branch_id` exists and is inert.
- **14 pre-existing tables have RLS enabled with no policies** (`orders`, `dishes`,
  `billing_*`, `users`…). Latent only because the app uses the service-role key.
- **`platform_users.password_hash` is sha256.** Till PINs correctly use scrypt;
  account passwords still do not.
- **Legacy `agent1101` login** exists for the original kiosk. It is now disabled
  unless `AUTH_PASSWORD_HASH` is explicitly set (it used to default to a hash in
  version control).
- `ScriptProcessorNode` is deprecated — migrate to `AudioWorkletNode` eventually.
- Session ids are never expired server-side.

---

## Common failure modes

| Symptom | Cause | Look at |
|---|---|---|
| `/api/pos/*` returns 403 | `features.pos` is false | `scripts/enable-pos.ts` |
| Till shows an empty menu | Tenant is `pos` but menu never backfilled | `scripts/backfill-pos.ts` |
| Every order write fails | POS migrations not applied | boot log `[SCHEMA] MISMATCH` |
| Orders appear late | SSE not connected | Till header badge; `routes/stream.ts` |
| QR scan says code invalid | `channels.qr.enabled` false, or token rotated | `scripts/table-qr.ts` |
| Guest gets 403 everywhere | Staff token being used as a guest one | `middleware/guest.ts` |
| Phone call is silent | Trunk negotiated G.729 | `telephony/sip/README-asterisk.md` |
| First PTT press silent | WebSocket not open before audio | dual-flag connect in `App.tsx` |
| Kitchen ticket shows money | Wrong builder | `buildKitchenTicket`, not `buildReceipt` |
