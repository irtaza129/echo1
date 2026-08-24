// Assign, clear or list till PINs for a tenant's staff.
//
//   npx tsx --env-file=.env scripts/set-staff-pin.ts --list   --tenant <uuid>
//   npx tsx --env-file=.env scripts/set-staff-pin.ts --email <e> --pin 4817 --tenant <uuid>
//   npx tsx --env-file=.env scripts/set-staff-pin.ts --email <e> --clear   --tenant <uuid>
//   npx tsx --env-file=.env scripts/set-staff-pin.ts --tenants          # list tenants
//
// There is no admin UI for PINs yet (it lands with the Phase 2 till screens).
// This exists so PINs can be issued and tested now, and because a restaurant
// that needs to re-issue a PIN at 8pm on a Friday should not need a deploy.
//
// It writes exactly what PUT /api/pos/staff/:email/pin writes — same hashing,
// same validation, same fail-closed permissions — so nothing here is a
// back door around the route's rules.

import 'dotenv/config';
import * as db from '../src/lib/supabaseAdmin.js';
import { hashPin, isValidPinFormat, isWeakPin } from '../src/lib/pin.js';
import { findOrProvision, setPin, clearPin, listStaff } from '../src/lib/staffRepo.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function listTenants(): Promise<void> {
  const rows = await db.selectMany<{ id: string; slug: string; name: string }>('tenants', {
    select: 'id,slug,name', order: 'slug.asc', limit: '100',
  });
  console.log(`\n${rows.length} tenant(s):\n`);
  for (const t of rows) console.log(`  ${t.id}  ${t.slug.padEnd(24)} ${t.name}`);
  console.log('');
}

async function run(): Promise<void> {
  if (has('tenants')) { await listTenants(); return; }

  const tenantId = arg('tenant');
  if (!tenantId) {
    console.error('Missing --tenant <uuid>. Run with --tenants to list them.');
    process.exit(1);
  }

  if (has('list')) {
    const staff = await listStaff(tenantId);
    if (staff.length === 0) {
      console.log('\nNo staff rows for this tenant yet.');
      console.log('Invite one in the admin panel (Staff tab), then re-run this.\n');
      return;
    }
    console.log(`\n${staff.length} staff member(s):\n`);
    for (const s of staff) {
      const perms = Object.entries(s.permissions)
        .filter(([, v]) => v === true)
        .map(([k]) => k.replace('can_', ''))
        .join(', ') || 'none';
      console.log(`  ${s.email.padEnd(32)} ${s.role.padEnd(14)} PIN:${s.hasPin ? 'yes' : 'no '}  can: ${perms}`);
    }
    console.log('');
    return;
  }

  const email = arg('email');
  if (!email) {
    console.error('Missing --email <address>. Use --list to see who exists.');
    process.exit(1);
  }

  const staff = await findOrProvision(tenantId, email);
  if (!staff) {
    console.error(`No staff member "${email}" in tenant ${tenantId}.`);
    console.error('Invite them in the admin panel first, or check --list.');
    process.exit(1);
  }

  if (has('clear')) {
    await clearPin(tenantId, staff.id);
    console.log(`Cleared the till PIN for ${email}.`);
    return;
  }

  const pin = arg('pin');
  if (!pin) {
    console.error('Missing --pin <4-8 digits> (or --clear to remove one).');
    process.exit(1);
  }
  if (!isValidPinFormat(pin)) {
    console.error('A PIN must be 4 to 8 digits.');
    process.exit(1);
  }
  if (isWeakPin(pin)) {
    console.error('That PIN is too easy to guess — avoid repeated digits and runs like 1234.');
    process.exit(1);
  }

  await setPin(tenantId, staff.id, await hashPin(pin));
  console.log(`Set the till PIN for ${email} (${staff.role}).`);
  console.log('They can now enter it on the Till screen.');
  console.log('\nNote: a PIN identifies WHO is at the till. It grants no permissions on its own —');
  console.log('use PUT /api/pos/staff/:email/permissions to allow voids, discounts or refunds.');
}

run().catch(err => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
