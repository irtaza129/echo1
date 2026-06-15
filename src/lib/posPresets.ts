// ─────────────────────────────────────────────────────────────────────────────
// POS / backend integration presets
//
// A friendly, non-technical catalogue of the ways a restaurant can connect its
// ordering system to the voice agent. The onboarding wizard and admin dashboard
// render these as plain-language cards so a restaurant owner can pick "I use
// Foodics" instead of hand-entering REST endpoints and JSON field paths.
//
// Pure data — no React, no Node imports — so both the browser (Vite) and the
// server (tsx) can import it. The technical endpoint/field mapping lists that
// used to be duplicated inside OnboardingWizard.tsx and AdminDashboard.tsx now
// live here as the single source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export type PresetAdapterType = 'managed' | 'custom_api' | 'webhook';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Static values the adapter injects into every call for an operation — the
// "what info to pass" that a generic mapping can't infer. Discovered via the
// probe / OpenAPI import and confirmed by the onboarder, or entered by hand.
export interface EndpointParams {
  query?:   Record<string, string>;  // appended as ?key=value
  body?:    Record<string, string>;  // merged into the JSON request body
  headers?: Record<string, string>;  // sent as request headers
}

export interface EndpointMapping {
  operation:      string;
  method:         HttpMethod;
  path:           string;
  fieldMappings:  Record<string, string>;
  /** Static params injected on every call (filters, branch ids, etc.). */
  params?:        EndpointParams;
}

// A requirement surfaced by endpoint discovery, rendered as an input field.
export interface DiscoveredField {
  name:        string;
  in:          'query' | 'body' | 'header';
  required:    boolean;
  description?: string;
  example?:    string;
}

export interface ProbeResult {
  ok:           boolean;
  source:       'openapi' | 'probe' | 'none';
  authRequired: boolean;
  fields:       DiscoveredField[];
  sampleStatus?: number;
  message?:     string;
}

// The operations the agent needs to drive an ordering backend. Used to render
// the (advanced) endpoint editor and to seed default mappings for a preset.
export const ENDPOINT_OPERATIONS = [
  { key: 'getMenuForUI',      label: 'Menu (kiosk display)',   defaultMethod: 'GET'   as HttpMethod, defaultPath: '/api/v1/menu' },
  { key: 'resolveItem',       label: 'Add to Cart',            defaultMethod: 'POST'  as HttpMethod, defaultPath: '/api/v1/agent/resolve-item' },
  { key: 'submitOrder',       label: 'Submit Order',           defaultMethod: 'POST'  as HttpMethod, defaultPath: '/api/v1/agent/submit-order' },
  { key: 'getOrders',         label: 'Get Orders (kitchen)',   defaultMethod: 'GET'   as HttpMethod, defaultPath: '/api/v1/orders' },
  { key: 'updateOrderStatus', label: 'Update Order Status',    defaultMethod: 'PATCH' as HttpMethod, defaultPath: '/api/v1/orders' },
  { key: 'getMenuContext',    label: 'AI Menu Context',        defaultMethod: 'GET'   as HttpMethod, defaultPath: '/api/v1/agent/menu-context' },
] as const;

// Fields the "Add to Cart" response must surface back to the agent. Shown in the
// advanced "Response Field Mappings" editor so a technical installer can remap a
// POS that returns these under different JSON keys.
export const RESOLVE_ITEM_MAP_FIELDS = [
  { key: 'status',         hint: '"ok" / "not_found" / "requires_input"' },
  { key: 'cart_item_id',   hint: 'Unique item ID for remove operations' },
  { key: 'unit_price',     hint: 'Item price as a number' },
  { key: 'summary',        hint: 'Item display name / description' },
  { key: 'ai_instruction', hint: 'Prompt text when requires_input' },
] as const;

// Build the full default mapping set (used as the starting point for any
// custom_api / webhook preset, then optionally overridden per-preset below).
export function defaultEndpointMappings(): EndpointMapping[] {
  return ENDPOINT_OPERATIONS.map(op => ({
    operation:     op.key,
    method:        op.defaultMethod,
    path:          op.defaultPath,
    fieldMappings: {},
  }));
}

export interface PosPreset {
  id:               string;
  /** Brand / option name shown on the card, e.g. "Foodics". */
  name:             string;
  /** One-line plain-language description for the card. */
  tagline:          string;
  /** Emoji/icon glyph shown on the card (kept as text to avoid an icon dep). */
  icon:             string;
  adapterType:      PresetAdapterType;
  recommended?:     boolean;
  /** Whether to show the simple connection fields. */
  needsBaseUrl:     boolean;
  needsApiKey:      boolean;
  needsWebhookUrl:  boolean;
  baseUrlLabel?:    string;
  baseUrlPlaceholder?: string;
  apiKeyLabel?:     string;
  /** Plain-language "where do I find this?" help shown under the key field. */
  apiKeyHelp?:      string;
  webhookUrlLabel?: string;
  webhookUrlHelp?:  string;
  /** Friendly note explaining what happens after they connect. */
  setupNote?:       string;
  docsUrl?:         string;
  /** Pre-filled endpoint mappings; omit to use platform defaults. */
  endpointMappings?: EndpointMapping[];
}

export const POS_PRESETS: PosPreset[] = [
  {
    id:           'managed',
    name:         'Savour Managed',
    tagline:      "We host everything — nothing to set up. Best for most restaurants.",
    icon:         '✨',
    adapterType:  'managed',
    recommended:  true,
    needsBaseUrl:    false,
    needsApiKey:     false,
    needsWebhookUrl: false,
    setupNote:    'You build your menu right here in the dashboard and the AI uses it instantly. No POS account or developer needed.',
  },
  {
    id:           'foodics',
    name:         'Foodics',
    tagline:      'Already on Foodics Cloud POS? Connect your account.',
    icon:         '🍽️',
    adapterType:  'custom_api',
    needsBaseUrl:    true,
    needsApiKey:     true,
    needsWebhookUrl: false,
    baseUrlLabel:    'Foodics API URL',
    baseUrlPlaceholder: 'https://api.foodics.com/v5',
    apiKeyLabel:     'Foodics API Token',
    apiKeyHelp:      'In Foodics: Settings → Apps & Integrations → API Keys → Generate token. Paste it here — we store it encrypted.',
    setupNote:      'Your menu and orders stay in Foodics. The first time you connect, our team helps map your menu fields (a one-time, 5-minute step).',
    docsUrl:        'https://developers.foodics.com',
  },
  {
    id:           'custom_api',
    name:         'My own POS / website',
    tagline:      'Connect any system that has a REST API.',
    icon:         '🔌',
    adapterType:  'custom_api',
    needsBaseUrl:    true,
    needsApiKey:     true,
    needsWebhookUrl: false,
    baseUrlLabel:    'Your backend URL',
    baseUrlPlaceholder: 'https://api.myrestaurant.com',
    apiKeyLabel:     'API Key (optional)',
    apiKeyHelp:      'If your system needs a key to accept requests, paste it here. Leave blank for public endpoints.',
    setupNote:      'Use the Advanced settings below to point each operation at the right endpoint on your system.',
  },
  {
    id:           'webhook',
    name:         'Notify my system (Webhook)',
    tagline:      'Send each order to a webhook — Zapier, Make, or your own URL.',
    icon:         '📨',
    adapterType:  'webhook',
    needsBaseUrl:    false,
    needsApiKey:     false,
    needsWebhookUrl: true,
    webhookUrlLabel: 'Webhook URL',
    webhookUrlHelp:  'We POST each confirmed order to this address. Build your menu here in the dashboard for the AI to use.',
    setupNote:      'Best when you just want orders pushed somewhere (a kitchen printer service, Zapier flow, or your own endpoint).',
  },
];

export function getPreset(id: string): PosPreset | undefined {
  return POS_PRESETS.find(p => p.id === id);
}

// Map a saved adapter type back to its most likely preset id, so the admin
// dashboard can highlight the right card when an existing tenant loads.
export function presetIdForAdapterType(type: string): string {
  if (type === 'managed') return 'managed';
  if (type === 'webhook') return 'webhook';
  return 'custom_api';
}
