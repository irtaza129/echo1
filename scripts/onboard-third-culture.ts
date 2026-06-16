import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { getRedis, redisKey, TTL } from '../src/lib/redis.js';
import { parseTenantConfig, type TenantConfig } from '../src/lib/tenantConfig.js';
import { tenantsRepo, tenantConfigsRepo, usersRepo, credentialsRepo } from '../src/lib/repo.js';

interface MenuCategoryRow { id: string; name: string; sortOrder: number }
interface MenuItemRow     { id: string; categoryId: string; name: string; description: string; price: number; available: boolean }
interface MenuData        { categories: MenuCategoryRow[]; items: MenuItemRow[] }

const ONE_YEAR = 365 * 24 * 60 * 60;
const BACKEND_URL = process.env.BACKEND_URL || 'https://voiceai-hzyb.onrender.com';

function buildMenuMarkdown(menu: MenuData, config: TenantConfig): string {
  const { categories, items } = menu;
  const cur  = config.businessRules.currencySymbol;
  let   md   = `# ${config.restaurantName} Menu\n\n`;
  const cats = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const cat of cats) {
    const catItems = items.filter(i => i.categoryId === cat.id && i.available !== false);
    if (catItems.length === 0) continue;
    md += `## ${cat.name}\n`;
    for (const item of catItems) {
      md += `- **${item.name}** — ${cur} ${item.price}`;
      if (item.description) md += `: ${item.description}`;
      md += '\n';
    }
    md += '\n';
  }
  return md.trim() || `# ${config.restaurantName} Menu\n\n(No items added yet)`;
}

async function run() {
  const email = 'thirdculture@thirdculture.com';
  // Generate a random secure password for the new tenant admin
  const password = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '') + 'Tcc2026!';
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  const slug = 'third-culture-coffee';
  const restaurantName = 'Third Culture Coffee';

  console.log(`[ONBOARD] Starting onboarding for ${restaurantName}...`);
  console.log(`[ONBOARD] Checking if tenant with slug "${slug}" already exists...`);
  
  let tenantId = crypto.randomUUID();
  let existingTenant: any = null;
  try {
    existingTenant = await tenantsRepo.findBySlug(slug);
    if (existingTenant) {
      tenantId = existingTenant.id;
      console.log(`[ONBOARD] Reusing existing Tenant ID: ${tenantId}`);
    } else {
      console.log(`[ONBOARD] Generated new Tenant ID: ${tenantId}`);
    }
  } catch (err) {
    console.warn('[ONBOARD] Failed to check for existing tenant, assuming new UUID:', (err as Error).message);
  }

  console.log(`[ONBOARD] Generated Slug: ${slug}`);
  console.log(`[ONBOARD] Admin Email: ${email}`);
  console.log(`[ONBOARD] Generated Admin Password: ${password}`);

  // Create the TenantConfig object
  const config = parseTenantConfig({
    tenantId,
    slug,
    restaurantName,
    plan: 'starter',
    adapter: { type: 'managed' },
    gemini: {
      agentName: `${restaurantName} Assistant`,
      voice: 'Puck',
      languages: ['en'],
      systemPromptExtras: [
        'COFFEE & FOOD RECOMMENDATION RULES:',
        '- Always suggest pairing any hot or iced coffee order with a fresh sweet pastry (like an Almond Croissant or Chocolate Brownie) or a savory item (like a Beef Brisket sandwich or Egg & Sausage Bagel).',
        '- If they order a Hot Latte or Cappuccino, ask if they prefer regular milk or a milk alternative (e.g. Macadamia short bread hint/mention, etc.).',
        '- Confirm the item names exactly as they are on the menu (e.g. "Matilda Cake" or "Espresso Tonic").',
      ].join('\n'),
    },
    branding: {
      primaryColor: '#6F4E37', // Coffee Brown
      logoUrl: '',
      kioskTitle: `Welcome to ${restaurantName}`,
    },
    businessRules: {
      gstRate: 0.05, // 5% GST as requested
      currencySymbol: 'Rs.', // Pakistani Rupees
      orderStatusMachine: ['pending', 'confirmed', 'preparing', 'ready', 'delivered'],
    },
    features: {
      deliveryOrders: false,
      tableNumbers: true,
      transcriptScreen: true,
      loyaltyPoints: false,
    },
  });

  // Read the parsed menu items from the JSON file
  const parsedMenuPath = 'scripts/parsed_menu.json';
  if (!fs.existsSync(parsedMenuPath)) {
    throw new Error(`Parsed menu JSON file not found at ${parsedMenuPath}`);
  }
  const menuData = JSON.parse(fs.readFileSync(parsedMenuPath, 'utf8')) as MenuData;
  console.log(`[ONBOARD] Loaded menu: ${menuData.categories.length} categories, ${menuData.items.length} items`);

  // Build the markdown prompt for Gemini
  const menuMarkdown = buildMenuMarkdown(menuData, config);

  const redis = getRedis();
  const emailKey = `user:email:${email.toLowerCase()}`;
  const slugKey  = `tenant:slug:${slug}`;

  // 1. Write to Redis
  console.log('[ONBOARD] Writing to Redis...');
  await Promise.all([
    redis.set(emailKey, { email: email.toLowerCase(), passwordHash, tenantId, slug, role: 'tenant_admin' }, { ex: ONE_YEAR }),
    redis.set(slugKey,  tenantId, { ex: ONE_YEAR }),
    redis.set(redisKey.tenantConfig(tenantId), config, { ex: TTL.TENANT_CONFIG }),
    redis.sadd(redisKey.tenantsIndex, tenantId),
    redis.set(redisKey.menuData(tenantId), menuData),
    redis.set(redisKey.menuContext(tenantId), menuMarkdown, { ex: TTL.MENU_CONTEXT }),
  ]);
  console.log('[ONBOARD] Redis write completed successfully.');

  // 2. Write to PostgreSQL (Supabase) via repos
  console.log('[ONBOARD] Writing to PostgreSQL (Supabase)...');
  try {
    if (!existingTenant) {
      await tenantsRepo.upsert({
        id: tenantId,
        slug,
        name: restaurantName,
        plan: 'starter',
        status: 'active',
      });
      console.log('  - Tenants table updated.');
    } else {
      console.log('  - Tenants table row already exists, skipping insert to avoid trigger issue.');
    }

    await tenantConfigsRepo.upsert(tenantId, config, undefined);
    console.log('  - Tenant configs table updated.');

    await usersRepo.upsert({
      tenantId,
      email: email.toLowerCase(),
      passwordHash,
      role: 'tenant_admin',
    });
    console.log('  - Platform users table updated.');
  } catch (err) {
    console.error('[ONBOARD] PostgreSQL write failed:', err);
    throw err;
  }

  // 3. Sync Menu to FastAPI Backend
  console.log('[ONBOARD] Syncing menu to FastAPI backend...');
  const flatDishes = menuData.items.map(item => {
    const cat = menuData.categories.find(c => c.id === item.categoryId);
    return {
      category:    cat?.name ?? 'Uncategorised',
      name:        item.name,
      description: item.description,
      price:       item.price,
      base_price:  item.price,
      tag:         '',
      available:   item.available,
    };
  });

  try {
    const res = await axios.post(
      `${BACKEND_URL}/api/v1/admin/menu`,
      { dishes: flatDishes },
      { headers: { 'X-Tenant-ID': tenantId }, timeout: 30_000 },
    );
    console.log(`[ONBOARD] FastAPI sync succeeded! Response status: ${res.status}`);
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? ((err.response?.data as { detail?: string })?.detail ?? err.message)
      : String(err);
    console.error('[ONBOARD] FastAPI sync failed:', msg);
    throw new Error(`FastAPI sync failed: ${msg}`);
  }

  console.log('\n[ONBOARD] Onboarding completed successfully! 🎉');
  console.log('--------------------------------------------------');
  console.log(`Restaurant ID (Tenant ID): ${tenantId}`);
  console.log(`Restaurant Slug:           ${slug}`);
  console.log(`Login Email:               ${email}`);
  console.log(`Login Password:            ${password}`);
  console.log('--------------------------------------------------');
}

run().catch(err => {
  console.error('[ONBOARD] Fatal onboarding error:', err);
  process.exit(1);
});
