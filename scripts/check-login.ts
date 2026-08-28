// Why can this account not log in?
//
//   npx tsx --env-file=.env scripts/check-login.ts --all
//   npx tsx --env-file=.env scripts/check-login.ts --email someone@example.com
//   npx tsx --env-file=.env scripts/check-login.ts --email someone@example.com --password '...'
//
// /api/auth/login answers 401 "Invalid credentials" for every one of five
// distinct causes: no such account, a revoked one, a wrong password, a lookup
// that failed, and (as 403) a reserved slug. That is correct for a public
// endpoint — telling an attacker which of those it hit is how you enumerate
// accounts — and useless for an operator, who then has no way to tell "wrong
// password" from "this account was never migrated".
//
// This runs the same checks with the answers visible. It reads only, and prints
// neither the stored hash nor the supplied password.
//
// WITHOUT --password it reports everything except whether the password matches,
// which is the useful mode: those are the conditions an operator can actually
// fix, and none of them requires knowing the customer's password.

import crypto from 'node:crypto';
import { selectMany } from '../src/lib/supabaseAdmin.js';
import { tenantsRepo, tenantConfigsRepo, REVOKED_PASSWORD_HASH } from '../src/lib/repo.js';
import { getRedis } from '../src/lib/redis.js';

// Mirrors RESERVED_SLUGS in server.ts. Duplicated deliberately: this script must
// report what the server WOULD do, so if the two ever drift the check that
// matters is the server's and this file should be corrected to match it.
const RESERVED = new Set([
  'savour-foods', 'admin', 'api', 'kiosk', 'super',
  'login', 'signup', 'dashboard', 'health', 'static', 'assets',
]);

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const EMAIL    = arg('email')?.toLowerCase();
const PASSWORD = arg('password');
const ALL      = process.argv.includes('--all');

interface Row { email: string; role: string; tenant_id: string; password_hash: string }

async function check(u: Row, password?: string): Promise<string[]> {
  const issues: string[] = [];
  const hash = String(u.password_hash ?? '');

  if (hash === REVOKED_PASSWORD_HASH) {
    issues.push('REVOKED — this login was deliberately disabled (staff removal)');
  } else if (!/^[0-9a-f]{64}$/.test(hash)) {
    issues.push(`password_hash is not a sha256 digest (length ${hash.length}) — login can never match`);
  }

  const tenant = await tenantsRepo.findById(u.tenant_id).catch(() => {
    throw new Error('tenants lookup FAILED — this is the condition that used to surface as 401');
  });
  if (!tenant) {
    issues.push('no tenants row — the JWT would carry the uuid as its slug, so the app routes nowhere');
  } else if (RESERVED.has(tenant.slug)) {
    issues.push(`slug "${tenant.slug}" is reserved — the server refuses this login with 403`);
  }

  const config = await tenantConfigsRepo.get(u.tenant_id).catch(() => null);
  if (!config) {
    issues.push('no tenant_configs row — login succeeds but the app has no config to load');
  }

  if (password !== undefined) {
    const supplied = crypto.createHash('sha256').update(password).digest('hex');
    issues.push(supplied === hash
      ? 'password MATCHES'
      : 'password does NOT match the stored hash');
  }

  return issues;
}

async function main(): Promise<void> {
  if (!EMAIL && !ALL) {
    console.error('Pass --email <addr>, or --all to audit every account.');
    process.exitCode = 1;
    return;
  }

  const rows = await selectMany<Row>('platform_users', {
    select: 'email,role,tenant_id,password_hash',
    ...(EMAIL ? { email: `eq.${EMAIL}` } : { limit: '500' }),
  });

  if (EMAIL && rows.length === 0) {
    console.log(`\n  ${EMAIL}: NO platform_users ROW.\n`);
    // The legacy Redis record is the difference between "never existed" and
    // "existed before the cutover and was never migrated" — two very different
    // problems that the login endpoint reports identically.
    const legacy = await getRedis().get<unknown>(`user:email:${EMAIL}`).catch(() => null);
    console.log(legacy
      ? '  A legacy Redis record EXISTS. This account predates the cutover and was\n' +
        '  never backfilled — run scripts/backfill-platform-state.ts --write.'
      : '  No legacy Redis record either. This address has never had an account,\n' +
        '  or it was removed. Check scripts/prune-stale-logins.ts backups.');
    console.log('\n  Note: `agent1101` is NOT an account here — it is a hardcoded username\n' +
                '  gated on the AUTH_PASSWORD_HASH env var, and is off unless that is set.\n');
    return;
  }

  let clean = 0;
  for (const u of rows) {
    const issues = await check(u, PASSWORD);
    const blocking = issues.filter(i => i !== 'password MATCHES');
    if (blocking.length === 0) { clean++; if (!EMAIL) continue; }
    console.log(`\n  ${u.email}  (role ${u.role}, tenant ${u.tenant_id})`);
    for (const i of issues) console.log(`    - ${i}`);
  }

  console.log(`\n  ${clean}/${rows.length} account(s) have nothing blocking login.`);
  if (!PASSWORD && clean === rows.length) {
    console.log('  Anything failing now is the password itself, or a transient lookup failure.');
  }
}

main().catch(err => { console.error('[CHECK-LOGIN]', (err as Error).message); process.exit(1); });
