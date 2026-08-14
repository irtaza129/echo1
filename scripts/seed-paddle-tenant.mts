import crypto from 'crypto';
import { getRedis, redisKey, TTL } from '../src/lib/redis.js';
import { parseTenantConfig, validatePaymentConfig } from '../src/lib/tenantConfig.js';

// ─────────────────────────────────────────────────────────────────────────────
// Seed a sandbox tenant that can actually take card payments.
//
// Why this exists: Savour Foods is PKR/cash, and Paddle cannot collect PKR, so
// the live tenant is (correctly) never offered a card option. Testing the card
// flow needs a tenant whose currency Paddle supports.
//
// Creates a SEPARATE tenant rather than mutating Savour Foods — nothing about
// the production tenant changes.
//
// Run:  npx tsx --env-file=.env scripts/seed-paddle-tenant.mts
// ─────────────────────────────────────────────────────────────────────────────

const SLUG      = process.env.SEED_SLUG     ?? 'paddle-test';
const CURRENCY  = process.env.SEED_CURRENCY ?? 'USD';
const TENANT_ID = '00000000-0000-4000-8000-0000000000p1'.replace('p', 'a');

const err = validatePaymentConfig('paddle', CURRENCY);
if (err) { console.error(`Refusing to seed: ${err}`); process.exit(1); }

const config = parseTenantConfig({
  tenantId:       TENANT_ID,
  slug:           SLUG,
  restaurantName: 'Paddle Test Kitchen',
  plan:           'growth',
  adapter:        { type: 'managed' },
  gemini: {
    agentName:          'Paddle Test Assistant',
    voice:              'Puck',
    languages:          ['en'],
    systemPromptExtras: '',
  },
  branding: {
    primaryColor: '#0A2540',
    logoUrl:      '',
    kioskTitle:   'Paddle Test Kitchen (sandbox)',
  },
  businessRules: {
    gstRate:            0,
    currencySymbol:     '$',
    currency:           CURRENCY,
    orderStatusMachine: ['pending', 'confirmed', 'preparing', 'ready', 'delivered'],
  },
  features: {
    deliveryOrders: false, tableNumbers: false,
    transcriptScreen: true, loyaltyPoints: false,
    pos: false, reservations: false,
  },
  payments: { provider: 'paddle', captureMode: 'auto', threeDSRequired: true },
  setupComplete: true,
});

const redis = getRedis();

await redis.set(redisKey.tenantConfig(TENANT_ID), config, { ex: TTL.TENANT_CONFIG });
await redis.set(`tenant:slug:${SLUG}`, TENANT_ID, { ex: 365 * 24 * 60 * 60 });
await redis.sadd(redisKey.tenantsIndex, TENANT_ID);

// A tiny menu so the voice agent has something real to resolve against.
await redis.set(redisKey.menuData(TENANT_ID), {
  categories: [{
    name: 'Mains',
    items: [
      { id: crypto.randomUUID(), name: 'Chicken Biryani', price: 12, available: true, category: 'Mains' },
      { id: crypto.randomUUID(), name: 'Beef Pulao',      price: 14, available: true, category: 'Mains' },
      { id: crypto.randomUUID(), name: 'Mango Lassi',     price: 4,  available: true, category: 'Drinks' },
    ],
  }],
}, { ex: TTL.TENANT_CONFIG });

console.log(`Seeded tenant "${SLUG}"`);
console.log(`  tenantId : ${TENANT_ID}`);
console.log(`  currency : ${CURRENCY} (Paddle-supported)`);
console.log(`  provider : paddle`);
console.log(`  kiosk    : http://localhost:3000/${SLUG}`);
console.log(`\nThe agent will offer "cash or card" for this tenant.`);
