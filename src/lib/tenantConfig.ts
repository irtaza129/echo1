import { z } from 'zod';

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
  plan:           z.enum(['starter', 'growth', 'enterprise']),

  adapter: z.object({
    type:             z.enum(['managed', 'custom_api', 'webhook']),
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
    currency:           z.string().default('PKR'),
    orderStatusMachine: z.array(z.string()).default([
      'pending', 'confirmed', 'preparing', 'ready', 'delivered',
    ]),
    // POS-only settings. Always present (default object), unlike `payments`/
    // `channels` below, because PosAdapter and routes/pos.ts read it directly
    // without optional chaining.
    pos: z.object({
      serviceChargeRate: z.number().min(0).max(1).default(0),
    }).default({ serviceChargeRate: 0 }),
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
  payments: z.object({
    provider:        z.enum(['cash', 'safepay']).default('cash'),
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
  }).optional(),

  setupComplete: z.boolean().default(false),
  setupStep: z.number().min(0).max(7).default(0),
});

export type TenantConfig      = z.infer<typeof TenantConfigSchema>;
export type EndpointMapping   = z.infer<typeof EndpointMappingSchema>;
export type AdapterType       = TenantConfig['adapter']['type'];
export type FeatureModule     = keyof TenantConfig['features'];

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
