import { z } from 'zod';
// Pure, import-free module — safe to pull into browser-side onboarding code.
import { PADDLE_CURRENCIES, isPaddleCurrency } from '../../payments/paddleCurrency.js';

// ── Endpoint mapping (for CustomApiAdapter) ───────────────────────────────────
const EndpointMappingSchema = z.object({
  operation:   z.string(),  // "resolveItem" | "getMenu" | "submitOrder" etc.
  method:      z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  // Relative path (e.g. "/api/menu") or absolute URL — resolved against baseUrl from credentials
  path:        z.string(),
  // Optional field-path overrides: maps our field name → their JSON path (dot notation)
  fieldMappings: z.record(z.string(), z.string()).optional(),
  // Static params the adapter injects on every call (filters, branch ids, etc.),
  // discovered by the endpoint probe / OpenAPI import or entered by the onboarder.
  params: z.object({
    query:   z.record(z.string(), z.string()).optional(),
    body:    z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }).optional(),
});

// ── Full TenantConfig schema ──────────────────────────────────────────────────
export const TenantConfigSchema = z.object({
  tenantId:       z.string().uuid(),
  slug:           z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  restaurantName: z.string().min(1).max(255),
  // 'starter' | 'pro' | 'advanced' are the tiers sold today, named to match the
  // Paddle catalogue (see src/lib/plans.ts). 'growth' and 'enterprise' predate
  // it and are kept ONLY so stored configs written before the catalogue existed
  // still parse — dropping them would throw on read and take those tenants'
  // kiosks offline. They are not offered in onboarding.
  plan:           z.enum(['starter', 'pro', 'advanced', 'growth', 'enterprise']),

  // 'pos' is the native point-of-sale adapter: menu, cart and orders served
  // from this app's own Postgres with no upstream at all (adapter/PosAdapter.ts).
  // It is what a tenant running our POS uses; 'managed' remains the Render/
  // FastAPI backend, and the other two are third-party integrations.
  adapter: z.object({
    type:             z.enum(['managed', 'custom_api', 'webhook', 'pos']),
    endpointMappings: z.array(EndpointMappingSchema).optional(),
  }),

  gemini: z.object({
    agentName:          z.string().default('Assistant'),
    voice:              z.string().default('Puck'),
    languages:          z.array(z.string()).default(['en']),
    systemPromptExtras: z.string().default(''),
    modelOverride:      z.string().optional(),
  }),

  branding: z.object({
    primaryColor: z.string().default('#000000'),
    logoUrl:      z.string().default(''),
    kioskTitle:   z.string().default('Welcome'),
  }),

  businessRules: z.object({
    gstRate:            z.number().min(0).max(1).default(0),
    currencySymbol:     z.string().default('$'),
    // ISO currency code used for payment gateway calls (display uses the symbol).
    //
    // The default is PKR for the legacy Savour Foods config, which predates this
    // field. Onboarding now always sets it explicitly from the chosen country
    // (src/lib/countries.ts) — relying on this default for a new tenant is a bug,
    // because it silently makes every non-Pakistani restaurant PKR and therefore
    // ineligible for Paddle.
    currency:           z.string().default('PKR'),
    // ISO 3166-1 alpha-2 of the restaurant's country. Optional because configs
    // written before onboarding collected it have no value to migrate from;
    // `currency` remains the field the gateway actually reads.
    country:            z.string().length(2).optional(),
    orderStatusMachine: z.array(z.string()).default([
      'pending', 'confirmed', 'preparing', 'ready', 'delivered',
    ]),
    // POS-only settings. Always present (default object), unlike `payments`/
    // `channels` below, because PosAdapter and routes/pos.ts read it directly
    // without optional chaining.
    pos: z.object({
      serviceChargeRate: z.number().min(0).max(1).default(0),
      // Whether the tender screen offers a tip line. Off by default: tipping is
      // not customary in every market this ships to, and an always-present tip
      // prompt reads as a demand rather than an option.
      tipEnabled:        z.boolean().default(false),
      // Blind close hides the expected-cash figure from the operator counting
      // the drawer, so the count is a genuine count rather than a number typed
      // to match. Managers still see the variance after the fact.
      blindClose:        z.boolean().default(false),
    }).default({ serviceChargeRate: 0, tipEnabled: false, blindClose: false }),
    // Reservations-only settings. Same always-present rationale as `pos` above.
    reservations: z.object({
      maxPartySize:    z.number().int().min(1).default(20),
      minLeadMinutes:  z.number().int().min(0).default(30),
      maxAdvanceDays:  z.number().int().min(1).default(60),
      defaultDuration: z.number().int().min(15).default(90),
      slotMinutes:     z.number().int().min(5).default(30),
      depositRequired: z.boolean().default(false),
      depositAmount:   z.number().min(0).default(0),
    }).default({
      maxPartySize: 20, minLeadMinutes: 30, maxAdvanceDays: 60,
      defaultDuration: 90, slotMinutes: 30, depositRequired: false, depositAmount: 0,
    }),
  }),

  // Optional so existing configs parse unchanged. Absent → cash (today's behaviour).
  //
  // Choosing `paddle` is only valid when businessRules.currency is one of the 33
  // currencies Paddle accepts — it rejects PKR outright. That pairing is checked
  // by validatePaymentConfig() at onboarding/save time rather than as a schema
  // refinement, because a refinement runs on every parse — including every read
  // — and one bad stored config would then throw the tenant's kiosk offline
  // instead of merely blocking card payments.
  payments: z.object({
    provider:        z.enum(['cash', 'safepay', 'paddle']).default('cash'),
    captureMode:     z.enum(['auto', 'manual']).default('auto'),
    threeDSRequired: z.boolean().default(true),
  }).optional(),

  features: z.object({
    deliveryOrders:  z.boolean().default(false),
    tableNumbers:    z.boolean().default(false),
    transcriptScreen: z.boolean().default(false),
    loyaltyPoints:   z.boolean().default(false),
    // Independently sellable modules — see requireFeature middleware.
    pos:             z.boolean().default(false),
    reservations:    z.boolean().default(false),
  }),

  // Channel configuration — optional so existing configs parse unchanged
  channels: z.object({
    whatsapp: z.object({
      enabled:           z.boolean().default(false),
      // WhatsApp Business phone number ID from Meta Developer Console
      wabaPhoneNumberId: z.string().optional(),
      displayName:       z.string().optional(),
    }).optional(),

    // Inbound phone agent over a SIP trunk. `didNumber` is the dialled number in
    // E.164 and is what maps a ringing call back to this tenant — the same role
    // wabaPhoneNumberId plays for WhatsApp. It must be unique across tenants;
    // that is enforced at save time, not here, because a schema refinement would
    // need to see every other tenant's config on every parse.
    phone: z.object({
      enabled:          z.boolean().default(false),
      didNumber:        z.string().optional(),
      // Overrides the generated greeting. Left empty, the agent greets with the
      // restaurant name and asks the delivery/pickup/takeaway/dine-in question.
      greetingOverride: z.string().default(''),
      // E.164 number to bridge the caller to when they ask for a human. Empty
      // disables the transfer_to_human tool entirely rather than offering a
      // transfer that then fails.
      transferTo:       z.string().default(''),
      // Hard cap so a stuck session cannot bill minutes indefinitely.
      maxCallSeconds:   z.number().int().min(60).max(3600).default(600),
    }).optional(),

    // QR self-ordering at the table.
    qr: z.object({
      enabled:        z.boolean().default(false),
      // Require the PIN printed on the table card in addition to scanning the
      // QR. Turning this off makes a photographed QR sufficient to order to that
      // table from anywhere — offered because some venues want zero friction,
      // but it is not the default.
      requirePin:     z.boolean().default(true),
      // Guests may send orders straight to the kitchen, or have the cashier
      // accept the first one. 'staff_accept' is the safer default for a new site.
      orderMode:      z.enum(['direct', 'staff_accept']).default('direct'),
      // Seconds a Call Waiter button stays disabled after a press.
      waiterCooldown: z.number().int().min(0).max(600).default(60),
    }).optional(),
  }).optional(),

  setupComplete: z.boolean().default(false),
  setupStep: z.number().min(0).max(7).default(0),
});

export type TenantConfig      = z.infer<typeof TenantConfigSchema>;
export type EndpointMapping   = z.infer<typeof EndpointMappingSchema>;
export type AdapterType       = TenantConfig['adapter']['type'];
export type FeatureModule     = keyof TenantConfig['features'];

// ── payment/currency compatibility ───────────────────────────────────────────

// Call this wherever a tenant's payment settings are SAVED (onboarding wizard,
// settings screen, seed scripts) — not on read. Returns an error string to show
// the onboarder, or null when the combination is valid.
//
// The rule exists because the choice of currency and the choice of gateway are
// not independent: Paddle accepts 33 currencies and PKR is not among them, so a
// Pakistani tenant who picks Paddle would have every single card order rejected
// at the gateway with no way to recover at runtime.
export function validatePaymentConfig(
  provider: 'cash' | 'safepay' | 'paddle',
  currency: string,
): string | null {
  if (provider !== 'paddle') return null;

  const upper = currency.toUpperCase();
  if (isPaddleCurrency(upper)) return null;

  return `Paddle cannot collect in ${upper}. Choose a currency Paddle supports ` +
         `(${PADDLE_CURRENCIES.slice(0, 8).join(', ')}, …), or select ` +
         `cash${upper === 'PKR' ? ' — Safepay support for PKR is planned' : ''}.`;
}

// Credentials stored separately (encrypted) — not in TenantConfig
export interface AdapterCredentials {
  // Restaurant backend / POS
  apiKey?:    string;
  apiSecret?: string;
  baseUrl?:   string;
  webhookUrl?: string;
  // Payment gateway (Safepay etc.) — never logged, never returned to the browser
  paymentApiKey?:        string;
  paymentSecret?:        string;
  paymentWebhookSecret?: string;
  paymentApiBase?:       string;
  paymentCheckoutBase?:  string;
  paymentEnvironment?:   string;  // 'sandbox' | 'production'
  merchantId?:           string;
  [key: string]: string | undefined;
}

// What the DB row looks like before parsing
export interface RawTenantConfigRow {
  tenant_id:  string;
  config:     unknown;
  updated_at: string;
}

export function parseTenantConfig(raw: unknown): TenantConfig {
  return TenantConfigSchema.parse(raw);
}
