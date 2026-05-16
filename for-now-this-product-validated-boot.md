# SaaS Multi-Tenant Architecture Plan — Voice Kiosk Platform

## Context

The current product is a single-tenant voice kiosk hardcoded for Savour Foods:
`Gemini ←→ server.ts ←→ BACKEND_URL (Render) ←→ Supabase`

The goal is to convert this into a B2B SaaS platform where clients sign up, configure their backend connection through a UI, and get a working kiosk — without us manually creating a new deployment per client. The core Gemini engine stays the same; only configuration and the adapter layer change per tenant.

---

## The Core Architecture: Three Planes

```
┌─────────────────────────────────────────────────────────────┐
│  CONTROL PLANE (Next.js + PostgreSQL)                       │
│  Tenant sign-up → configure adapter → deploy kiosk URL     │
│  Admin panel: oversee all tenants, billing, usage          │
└──────────────────────┬──────────────────────────────────────┘
                       │ reads TenantConfig on request
┌──────────────────────▼──────────────────────────────────────┐
│  KIOSK ENGINE (current server.ts — refactored)             │
│  Shared Express server, tenant-aware via JWT               │
│  Prompt builder reads TenantConfig                         │
│  AdapterFactory resolves the right adapter per tenant      │
└──────────────────────┬──────────────────────────────────────┘
                       │ IRestaurantAdapter
        ┌──────────────┼───────────────────┐
        ▼              ▼                   ▼
  ManagedBackend   CustomApiAdapter   WebhookAdapter
  (our Render,     (client's own      (we POST to
  X-Tenant-ID      REST API)          their URL)
  header)
```

---

## Clean Class System Design

### 1. The Adapter Interface (define once, never change)

```typescript
// adapter/IRestaurantAdapter.ts
interface IRestaurantAdapter {
  getMenuContext(): Promise<string>;              // markdown → Gemini prompt
  getMenuForUI(): Promise<MenuItem[]>;            // grid display

  resolveItem(p: ResolveItemParams): Promise<ResolveItemResult>;
  removeItem(cartItemId: string, sessionId: string): Promise<void>;
  clearCart(sessionId: string): Promise<void>;
  getCart(sessionId: string): Promise<CartItem[]>;

  submitOrder(p: SubmitOrderParams): Promise<OrderResult>;
  getOrders(filter?: OrderFilter): Promise<Order[]>;
  updateOrderStatus(orderId: string, status: string): Promise<void>;
}
```

### 2. Adapter Implementations

| Class | When to use | What it does |
|-------|------------|--------------|
| `ManagedBackendAdapter` | Client has no backend | Calls our Render backend with `X-Tenant-ID` header — current behaviour, just parameterised |
| `CustomApiAdapter` | Client has their own POS/API | Generic HTTP client driven by `endpointMappings` in TenantConfig; maps their response shape to our types |
| `WebhookAdapter` | Client wants push events | We POST to their URL; they update us via webhook |

### 3. AdapterFactory

```typescript
// adapter/AdapterFactory.ts
class AdapterFactory {
  static create(config: TenantConfig, credentials: AdapterCredentials): IRestaurantAdapter {
    switch (config.adapter.type) {
      case 'managed':     return new ManagedBackendAdapter(config);
      case 'custom_api':  return new CustomApiAdapter(config, credentials);
      case 'webhook':     return new WebhookAdapter(config, credentials);
    }
  }
}
```

### 4. TenantConfig Schema (Zod-validated)

```typescript
interface TenantConfig {
  tenantId: string;
  slug: string;                  // savour-foods (used in kiosk URL)
  restaurantName: string;
  plan: 'starter' | 'growth' | 'enterprise';

  adapter: {
    type: 'managed' | 'custom_api' | 'webhook';
    endpointMappings?: EndpointMapping[];   // for custom_api only
  };

  gemini: {
    agentName: string;           // "Savour Assistant"
    voice: string;               // Gemini voice name
    languages: string[];         // ['en', 'ur', 'roman-ur']
    systemPromptExtras: string;  // "Always upsell the deal of the day."
    modelOverride?: string;      // override default model per tenant
  };

  branding: {
    primaryColor: string;
    logoUrl: string;
    kioskTitle: string;
  };

  businessRules: {
    gstRate: number;             // 0.15
    currencySymbol: string;      // "₨"
    orderStatusMachine: string[];
  };

  features: {
    deliveryOrders: boolean;
    tableNumbers: boolean;
    transcriptScreen: boolean;
    loyaltyPoints: boolean;
  };
}
```

### 5. PromptBuilder (pure, fast, no hardcoded Savour logic)

```typescript
// lib/PromptBuilder.ts
class PromptBuilder {
  static build(config: TenantConfig, menuContext: string): string {
    // Reads config.gemini, config.businessRules, config.branding
    // Injects restaurant name, languages, GST rate, extras
    // Never references "Savour Foods" — that comes from config
    return builtSystemInstruction;
  }
}
```

### 6. Tenant Middleware (Express)

```typescript
// middleware/tenant.ts
async function tenantMiddleware(req, res, next) {
  const tenantId = req.jwt.tenantId;
  const config = await configCache.get(tenantId)     // Redis first
                 ?? await db.tenantConfigs.get(tenantId); // fallback
  const credentials = await credentialStore.get(tenantId); // decrypted
  req.adapter = AdapterFactory.create(config, credentials);
  req.tenantConfig = config;
  next();
}
```

---

## Role System

| Role | Scope | Capabilities |
|------|-------|-------------|
| `super_admin` | Platform-wide | All tenants, billing override, adapter templates, impersonate tenant admin |
| `tenant_admin` | Own tenant only | Full config edit, manage staff users, view all orders, export transcripts |
| `manager` | Own tenant | View/update orders, view transcripts |
| `staff` | Own tenant | View assigned orders, mark status |
| `kiosk` | Machine role | Agent API endpoints only — no UI, no config access |

JWT payload: `{ sub: userId, tenantId, role, iat, exp }`

---

## Database Schema (PostgreSQL via Supabase)

```sql
tenants          (id, slug, name, plan, status, stripe_customer_id, created_at)
tenant_configs   (tenant_id→tenants, config JSONB, updated_at, updated_by→users)
adapter_credentials (tenant_id→tenants, credentials_enc BYTEA, iv BYTEA) -- AES-256-GCM
users            (id, tenant_id→tenants, email, password_hash, role, created_at)
kiosk_sessions   (session_id, tenant_id→tenants, created_at, last_active)
audit_log        (id, tenant_id, actor_id, action, payload JSONB, created_at)
```

Row-level security: every query scoped by `tenant_id`. `super_admin` bypasses RLS.

---

## Redis Key Schema

| Key | TTL | Purpose |
|-----|-----|---------|
| `tenant:config:{tenantId}` | 5 min | Config cache — avoids DB hit per request |
| `menu:{tenantId}` | 6 h | Menu context (replaces client-side localStorage) |
| `rate:{tenantId}:{endpoint}` | sliding | Per-tenant rate limiting (replaces IP-based) |
| `session:{sessionId}` | 12 h | Maps kiosk session UUID → tenantId |

---

## Control Plane UI (Next.js — separate app)

### Tenant Onboarding Wizard (8 steps)
1. Sign up (email + password)
2. Choose plan (Starter / Growth / Enterprise)
3. Restaurant info (name, logo, timezone)
4. Select adapter type with explanation of each
5. Configure adapter (paste API URL + key for CustomApiAdapter; or auto for Managed)
6. Test connection (we call their API, show pass/fail)
7. Customize Gemini persona (name, voice, extra prompt, languages)
8. Set business rules → generate kiosk URL: `app.yourdomain.com/kiosk/{slug}`

### Admin Panel (super_admin only)
- Tenant list: status, plan, last-active, monthly API calls
- Per-tenant: config override, usage graph, raw audit log
- Adapter template library (reusable endpoint mapping presets for Foodics, Revel, etc.)
- Billing dashboard (Stripe)

### Tenant Admin Dashboard
- Config edit (all TenantConfig fields)
- Staff user management
- Order history + transcripts
- Usage metrics (tokens used, cost estimate)

---

## Background Workers (BullMQ — Redis-backed, Node.js native)

> **Note on Celery:** Celery is Python-specific. BullMQ is the exact equivalent for Node.js/TypeScript — same Redis backend, same queue/worker/retry/cron patterns. Use BullMQ; add Celery only if a Python microservice is introduced later.

| Queue | Job | Trigger | Purpose |
|-------|-----|---------|---------|
| `menu-sync` | `refreshMenuContext` | Hourly cron + manual trigger | Re-fetch menu from client backend, invalidate Redis `menu:{tenantId}` |
| `connection-test` | `testAdapterConnection` | After config save | Validate adapter credentials actually work |
| `order-webhook` | `deliverOrderEvent` | Order status change | POST to client's webhook URL if WebhookAdapter |
| `tenant-provision` | `provisionTenant` | After sign-up + payment | Create DB rows, set up RLS policies, send welcome email |

---

## Deployment Model

**Recommended: Shared multi-tenant server (Option A)**

Single Express server reads `tenantId` from JWT on every request. Config loaded from Redis cache. No per-client deployments to manage.

```
yourdomain.com/kiosk/{slug}          → shared kiosk engine (Express)
admin.yourdomain.com                 → control plane (Next.js)
admin.yourdomain.com/super           → admin panel (super_admin only)
```

Infrastructure cost: ~$50/month shared (Redis + PostgreSQL + 1 Render service) regardless of number of tenants. Per-tenant marginal cost is near zero until volume requires horizontal scaling.

**Escape hatch:** Any tenant can be "ejected" to a dedicated Render instance by setting `TENANT_ID` env var — same codebase, no code changes needed.

---

## Additional Stack Required

| Tool | Role | Why not X |
|------|------|-----------|
| **PostgreSQL** (Supabase hosted) | Tenant registry, configs, audit | Already have Supabase in project |
| **Redis** (Upstash serverless) | Config cache, menu cache, rate limit, job queue | Upstash = no-ops Redis, Vercel-compatible |
| **BullMQ** | Background jobs | Native Node.js, same Redis instance |
| **Next.js 14+** | Control plane UI | App Router + Server Actions = less boilerplate than standalone React |
| **Stripe** | Subscription billing | Best API, best SaaS precedent |
| **Zod** | Runtime config validation | Already in TS ecosystem; validates TenantConfig on save |
| **AES-256-GCM** (Node crypto) | Credential encryption at rest | No extra dep; built-in |
| **Better Auth** or **Auth.js** | Control plane auth | Handles OAuth + magic link for tenant sign-up |
| **Resend** | Transactional email | Welcome, invite staff, billing alerts |

---

## Phased Task Breakdown

### Phase 0 — Foundation (2–3 weeks)
- [ ] PostgreSQL schema: `tenants`, `users`, `tenant_configs`, `adapter_credentials`, `audit_log`
- [ ] Supabase RLS policies (tenant isolation enforced at DB level)
- [ ] JWT auth with `tenantId` + `role` claims (replace current HMAC token)
- [ ] Credential encryption utility (AES-256-GCM encrypt/decrypt)
- [ ] Zod schema for `TenantConfig` with full validation
- [ ] Redis setup (Upstash)

### Phase 1 — Adapter Layer (1–2 weeks)
- [ ] `IRestaurantAdapter` interface (`adapter/IRestaurantAdapter.ts`)
- [ ] `ManagedBackendAdapter` — wraps current proxy logic, adds `X-Tenant-ID` header
- [ ] `AdapterFactory` class
- [ ] Tenant middleware in Express (loads config + credentials, injects adapter)
- [ ] Refactor all `server.ts` proxy routes to use `req.adapter` instead of direct axios calls
- [ ] Per-tenant rate limiting in Redis (replace IP-based limiters)

### Phase 2 — Core Kiosk Refactor (1 week)
- [ ] `PromptBuilder` class — no hardcoded Savour Foods logic
- [ ] Menu context cache moved server-side to Redis (keyed by tenantId)
- [ ] Tenant-scoped ephemeral tokens (store `tenantId` in token metadata)
- [ ] Kiosk URL routing: `GET /kiosk/:slug` → serves same `App.tsx`, passes `tenantId` via config endpoint
- [ ] `GET /api/tenant-config` endpoint (public, returns non-sensitive branding/UI config)

### Phase 3 — Control Plane UI (3–4 weeks)
- [ ] Next.js app scaffold (separate repo or monorepo `/apps/control-plane`)
- [ ] Sign-up flow + Stripe checkout
- [ ] Onboarding wizard (8 steps above)
- [ ] Adapter connection test UI + backend endpoint (`POST /api/admin/test-connection`)
- [ ] Tenant admin dashboard (config edit form, live preview)
- [ ] Staff user invite flow (email → set password)

### Phase 4 — Admin Panel (1–2 weeks)
- [ ] Super admin tenant list with health indicators
- [ ] Per-tenant config override (impersonate tenant admin)
- [ ] Audit log viewer
- [ ] Usage metrics (tokens, calls, cost) — aggregated from `audit_log`
- [ ] Adapter template library (Foodics, Revel presets)

### Phase 5 — CustomApiAdapter (2 weeks)
- [ ] Endpoint mapping schema (`EndpointMapping[]` in TenantConfig)
- [ ] `CustomApiAdapter` — generic HTTP client using `endpointMappings`
- [ ] Schema mapping: client response → `CartItem` / `Order` (configurable field paths via jsonpath)
- [ ] Credential store + decryption in adapter constructor
- [ ] Connection test job in BullMQ

### Phase 6 — Background Workers (1 week)
- [ ] BullMQ setup (Redis connection, worker process)
- [ ] `menu-sync` queue + hourly cron
- [ ] `connection-test` queue (triggered after config save)
- [ ] `tenant-provision` queue (post sign-up automation)
- [ ] Worker process deployed as separate Render service (same codebase, `npm run worker`)

### Phase 7 — Billing (1–2 weeks)
- [ ] Stripe customer creation on sign-up
- [ ] Plan tiers mapped to `features` flags in TenantConfig
- [ ] Usage metering: count API calls per tenant in `audit_log`, report to Stripe
- [ ] Webhook: Stripe `customer.subscription.updated` → update tenant `plan` + `status`

---

## Timeline Summary

| Milestone | Phases | Weeks |
|-----------|--------|-------|
| MVP SaaS (onboard first external client) | 0–3 | 7–10 |
| Full platform (custom adapters + billing) | 0–7 | 12–16 |

---

## Critical Files to Create / Modify

| Path | Action | Purpose |
|------|--------|---------|
| `adapter/IRestaurantAdapter.ts` | Create | Core interface |
| `adapter/ManagedBackendAdapter.ts` | Create | Wraps current proxy |
| `adapter/CustomApiAdapter.ts` | Create | Generic HTTP client |
| `adapter/AdapterFactory.ts` | Create | Factory |
| `lib/PromptBuilder.ts` | Create | Replaces `buildSystemInstruction` in `geminiTools.ts` |
| `lib/TenantConfig.ts` | Create | Zod schema + types |
| `middleware/tenant.ts` | Create | Express tenant resolver |
| `server.ts` | Modify | Use `req.adapter`, JWT auth, Redis config cache |
| `src/lib/geminiTools.ts` | Modify | Remove hardcoded Savour logic; accept config param |
| `src/App.tsx` | Modify | Fetch `TenantConfig` from `/api/tenant-config`; use for branding + features |

---

## Verification Checklist (after each phase)

- Phase 0: `POST /api/auth/login` returns JWT with `tenantId` + `role`; credentials decrypt correctly
- Phase 1: Existing Savour Foods kiosk works through `ManagedBackendAdapter` with `X-Tenant-ID: savour-foods` header
- Phase 2: Two kiosk tabs with different `slug` values load different menus + prompts from same server
- Phase 3: New tenant completes wizard, gets kiosk URL, voice order works end-to-end
- Phase 4: Super admin sees all tenants; can edit config without tenant admin credentials
- Phase 5: `CustomApiAdapter` passes connection test, resolves item from external API
- Phase 6: Menu refresh job fires hourly; Redis `menu:{tenantId}` invalidated on run
- Phase 7: Downgrading plan disables `features.transcriptScreen`; Stripe webhook updates status to `suspended` on payment failure
