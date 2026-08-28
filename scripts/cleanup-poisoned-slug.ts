/**
 * One-shot cleanup for the poisoned `tenant:slug:savour-foods` mapping AND any
 * admin-managed menu/orders that got written under the legitimate Savour Foods
 * tenantId (00000000-...) by mistake — typically by someone using the legacy
 * `agent1101` login (which hardcodes that tenantId) to save Johnny Jugnu's menu.
 *
 * Per CLAUDE.md, Savour Foods uses the Render backend for menu data and should
 * have NO admin-managed menu_data in Redis. If it does, /api/menu serves the
 * stale Redis copy instead of falling through to Render.
 *
 * Usage:
 *   npx tsx scripts/cleanup-poisoned-slug.ts             # dry-run
 *   npx tsx scripts/cleanup-poisoned-slug.ts --confirm   # apply
 *
 * Steps:
 *   A) Rogue-tenant cleanup — runs if tenant:slug:savour-foods points anywhere
 *      other than the legitimate ID. Deletes the rogue UUID's config, menu,
 *      orders, carts, credentials, audit log, the rogue user account, and the
 *      tenants:index entry.
 *   B) Legacy-override cleanup — runs unconditionally. Deletes any
 *      admin-managed menu_data, rendered menu cache, local carts and local
 *      orders that live under 00000000-... so the kiosk falls back to Render.
 *
 * Safe to re-run.
 */
import 'dotenv/config';
import axios from 'axios';
import { getRedis, redisKey } from '../src/lib/redis.js';

const LEGACY_SAVOUR_ID = '00000000-0000-4000-8000-000000000001';
const POISONED_SLUG    = 'savour-foods';
const CONFIRM          = process.argv.includes('--confirm');

async function scanAll(pattern: string): Promise<string[]> {
  const redis = getRedis();
  let cursor: string | number = 0;
  const out: string[] = [];
  do {
    // Annotated rather than inferred: `cursor` is both an argument to scan and
    // assigned from its result, and TS cannot break that circularity on its own.
    const [next, batch] = await redis.scan(cursor, { match: pattern, count: 200 }) as [string | number, string[]];
    cursor = next;
    out.push(...batch);
  } while (String(cursor) !== '0');
  return out;
}

async function deleteAll(keys: string[]): Promise<number> {
  const redis = getRedis();
  let n = 0;
  for (const k of keys) {
    try { await redis.del(k); n++; }
    catch (err) { console.warn(`  del failed for ${k}:`, err); }
  }
  return n;
}

// ── Step A — rogue tenant ────────────────────────────────────────────────────
async function cleanRogueTenant(): Promise<void> {
  const redis = getRedis();
  console.log('▶ Step A — rogue-tenant cleanup');

  const poisonedId = await redis.get<string>(`tenant:slug:${POISONED_SLUG}`);
  if (!poisonedId) {
    console.log(`  tenant:slug:${POISONED_SLUG} not in Redis. Skipping step A.\n`);
    return;
  }
  if (poisonedId === LEGACY_SAVOUR_ID) {
    console.log(`  tenant:slug:${POISONED_SLUG} already points to the legitimate ID. Skipping step A.\n`);
    return;
  }
  console.log(`  Poisoned: tenant:slug:${POISONED_SLUG} → ${poisonedId}`);

  const userKeys = await scanAll('user:email:*');
  const rogueUsers: string[] = [];
  for (const k of userKeys) {
    const u = await redis.get<{ tenantId?: string; slug?: string; email?: string }>(k);
    if (!u) continue;
    const isRogue =
      (u.slug === POISONED_SLUG || u.tenantId === poisonedId) &&
      u.tenantId !== LEGACY_SAVOUR_ID;
    if (isRogue) {
      console.log(`  rogue user → ${k} (email=${u.email}, slug=${u.slug}, tenantId=${u.tenantId})`);
      rogueUsers.push(k);
    }
  }

  const localCarts     = await scanAll(`local:cart:${poisonedId}:*`);
  const orderIds       = (await redis.lrange(redisKey.localOrders(poisonedId), 0, -1).catch(() => [])) as string[];
  const localOrderKeys = orderIds.map(id => redisKey.localOrder(id));

  const tenantKeys = [
    `tenant:slug:${POISONED_SLUG}`,
    redisKey.tenantConfig(poisonedId),
    redisKey.menuData(poisonedId),
    redisKey.menuContext(poisonedId),
    redisKey.credentialsKey(poisonedId),
    redisKey.auditLog(poisonedId),
    redisKey.localOrders(poisonedId),
    redisKey.localOrderCounter(poisonedId),
  ];

  const all = [...tenantKeys, ...localCarts, ...localOrderKeys, ...rogueUsers];
  console.log('  Will delete:');
  for (const k of all) console.log('    -', k);
  console.log(`  Will SREM ${redisKey.tenantsIndex} ${poisonedId}`);

  if (CONFIRM) {
    const n = await deleteAll(all);
    try { await redis.srem(redisKey.tenantsIndex, poisonedId); }
    catch (err) { console.warn('  srem tenants:index failed:', err); }
    console.log(`  ✓ Deleted ${n}/${all.length} keys.\n`);
  } else {
    console.log('  [dry-run] no changes.\n');
  }
}

// ── Step B — legacy Savour override ──────────────────────────────────────────
async function cleanLegacyOverride(): Promise<void> {
  const redis = getRedis();
  console.log('▶ Step B — legacy Savour override cleanup');

  const menuData     = await redis.get<unknown>(redisKey.menuData(LEGACY_SAVOUR_ID));
  const menuRendered = await redis.get<unknown>(redisKey.menuContext(LEGACY_SAVOUR_ID));
  const localCarts   = await scanAll(`local:cart:${LEGACY_SAVOUR_ID}:*`);
  const orderIds     = (await redis.lrange(redisKey.localOrders(LEGACY_SAVOUR_ID), 0, -1).catch(() => [])) as string[];
  const localOrders  = orderIds.map(id => redisKey.localOrder(id));

  const overrideKeys: string[] = [];
  if (menuData)     overrideKeys.push(redisKey.menuData(LEGACY_SAVOUR_ID));
  if (menuRendered) overrideKeys.push(redisKey.menuContext(LEGACY_SAVOUR_ID));
  overrideKeys.push(...localCarts);
  if (orderIds.length > 0) {
    overrideKeys.push(redisKey.localOrders(LEGACY_SAVOUR_ID));
    overrideKeys.push(redisKey.localOrderCounter(LEGACY_SAVOUR_ID));
    overrideKeys.push(...localOrders);
  }

  if (overrideKeys.length === 0) {
    console.log('  No override keys found under the legitimate Savour ID. Nothing to clean.\n');
    return;
  }

  console.log('  Will delete (legacy Savour ID should use Render backend, not Redis):');
  for (const k of overrideKeys) console.log('    -', k);

  if (CONFIRM) {
    const n = await deleteAll(overrideKeys);
    console.log(`  ✓ Deleted ${n}/${overrideKeys.length} keys.\n`);
  } else {
    console.log('  [dry-run] no changes.\n');
  }
}

// ── Step C — Supabase v_menu contamination report ───────────────────────────
// v_menu is the source of truth for Savour's menu now (server.ts reads from
// it directly). If Johnny's items were synced into the underlying table under
// Savour's tenant_id (e.g. via the legacy agent1101 login + admin "Save menu"
// → /api/v1/admin/menu), they show up under Savour in v_menu. We can't reliably
// DELETE through PostgREST without knowing the underlying table name and
// without risking destruction of legitimate data, so this step REPORTS only
// and emits the exact SQL to paste into the Supabase SQL editor.
async function reportSupabaseContamination(): Promise<void> {
  console.log('▶ Step C — Supabase v_menu contamination report (informational)');

  const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const apiKey  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;
  if (!baseUrl || !apiKey) {
    console.log('  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or legacy SUPABASE_KEY) not set — skipping.\n');
    return;
  }

  let rows: Array<{ dish_id: number; dish_name: string | null; category: string; display_price: number | string }>;
  try {
    const res = await axios.get(`${baseUrl}/rest/v1/v_menu`, {
      params: {
        select:    'dish_id,dish_name,category,display_price',
        tenant_id: `eq.${LEGACY_SAVOUR_ID}`,
      },
      headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeout: 15_000,
    });
    rows = res.data;
  } catch (err) {
    console.log('  v_menu query failed:', (err as Error).message, '— skipping.\n');
    return;
  }

  // Heuristic contamination signals:
  //   - empty/null dish_name (placeholder rows)
  //   - category is one Savour does not own (Wraps, Burger — distinct from "Savour Krispo")
  // Savour's real burgers live under "Savour Krispo". A bare "Burger" category
  // under the Savour tenant_id is almost certainly Johnny Jugnu spillover.
  const SUSPECT_CATEGORIES = new Set(['Wraps', 'Burger']);
  const suspects = rows.filter(r =>
    !r.dish_name || r.dish_name.trim() === '' || SUSPECT_CATEGORIES.has(r.category),
  );

  if (suspects.length === 0) {
    console.log(`  v_menu has ${rows.length} rows for Savour, no obvious contamination found.\n`);
    return;
  }

  console.log(`  Found ${suspects.length} suspect row(s) under Savour tenant_id in v_menu:`);
  for (const r of suspects) {
    console.log(`    - dish_id=${r.dish_id}  category=${r.category}  name="${r.dish_name ?? ''}"  price=${r.display_price}`);
  }

  const ids = suspects.map(r => r.dish_id).join(', ');
  console.log('\n  Paste this in the Supabase SQL editor to remove them. Adjust the table');
  console.log('  name if your dishes table is not literally called "dishes":');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  DELETE FROM dishes`);
  console.log(`   WHERE tenant_id = '${LEGACY_SAVOUR_ID}'`);
  console.log(`     AND dish_id IN (${ids});`);
  console.log('  ─────────────────────────────────────────────────────────────\n');
}

async function main() {
  console.log('━━━ Poisoned-slug + legacy-override + v_menu cleanup ━━━');
  console.log(`mode: ${CONFIRM ? 'EXECUTE (--confirm)' : 'DRY RUN (pass --confirm to apply)'}\n`);

  await cleanRogueTenant();
  await cleanLegacyOverride();
  await reportSupabaseContamination();

  if (CONFIRM) {
    console.log('Done. Restart the server and clear browser sessionStorage so any stale JWT is dropped.');
  } else {
    console.log('Dry-run complete. Re-run with --confirm to execute Redis changes.');
    console.log('(Step C is always informational — run the printed SQL manually if applicable.)');
  }
}

main().catch(err => { console.error('Cleanup failed:', err); process.exit(1); });
