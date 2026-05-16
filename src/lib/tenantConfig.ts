import { z } from 'zod';

// ── Endpoint mapping (for CustomApiAdapter) ───────────────────────────────────
const EndpointMappingSchema = z.object({
  operation:   z.string(),  // "resolveItem" | "getMenu" | "submitOrder" etc.
  method:      z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url:         z.string().url(),
  // Optional field-path overrides: maps our field name → their JSON path
  fieldMappings: z.record(z.string(), z.string()).optional(),
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
    orderStatusMachine: z.array(z.string()).default([
      'pending', 'confirmed', 'preparing', 'ready', 'delivered',
    ]),
  }),

  features: z.object({
    deliveryOrders:  z.boolean().default(false),
    tableNumbers:    z.boolean().default(false),
    transcriptScreen: z.boolean().default(false),
    loyaltyPoints:   z.boolean().default(false),
  }),
});

export type TenantConfig      = z.infer<typeof TenantConfigSchema>;
export type EndpointMapping   = z.infer<typeof EndpointMappingSchema>;
export type AdapterType       = TenantConfig['adapter']['type'];

// Credentials stored separately (encrypted) — not in TenantConfig
export interface AdapterCredentials {
  apiKey?:    string;
  apiSecret?: string;
  baseUrl?:   string;
  webhookUrl?: string;
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
