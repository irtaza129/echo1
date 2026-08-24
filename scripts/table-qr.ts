// Create tables and issue their QR + PIN, then write a printable card.
//
//   npx tsx --env-file=.env scripts/table-qr.ts --slug fassih --list
//   npx tsx --env-file=.env scripts/table-qr.ts --slug fassih --add "1,2,3,4" --area Main
//   npx tsx --env-file=.env scripts/table-qr.ts --slug fassih --issue-all --base http://localhost:3000
//   npx tsx --env-file=.env scripts/table-qr.ts --slug fassih --issue "Table 3"
//
// --issue-all writes cards.html, one A6 card per table: the table name, the QR,
// and the PIN. Open it and print.
//
// The PIN is shown ONCE, here and in that file. It is stored only as a scrypt
// hash, so it can never be read back — losing it means re-issuing that table,
// which is a two-second operation and a reprint of one card.

import 'dotenv/config';
import fs from 'fs';
import QRCode from 'qrcode';
import * as db from '../src/lib/supabaseAdmin.js';
import { tablesRepo } from '../src/lib/posRepo.js';
import { tableQrRepo, type VenueTableRow } from '../src/lib/dineRepo.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (n: string) => process.argv.includes(`--${n}`);

async function resolveTenant(): Promise<{ id: string; slug: string }> {
  const slug = arg('slug');
  const id   = arg('tenant');
  if (id)   { const r = await db.selectOne<{ id: string; slug: string }>('tenants', { id: `eq.${id}`, select: 'id,slug' });
              if (r) return r; }
  if (slug) { const r = await db.selectOne<{ id: string; slug: string }>('tenants', { slug: `eq.${slug}`, select: 'id,slug' });
              if (r) return r; }
  console.error('Pass --slug <slug> or --tenant <uuid>.');
  process.exit(1);
}

async function run(): Promise<void> {
  const tenant = await resolveTenant();
  const base   = (arg('base') ?? 'http://localhost:3000').replace(/\/$/, '');

  // ── Add tables ────────────────────────────────────────────────────────────
  const add = arg('add');
  if (add) {
    const area   = arg('area') ?? 'Main';
    const seats  = Number(arg('seats')) || 4;
    const labels = add.split(',').map(l => l.trim()).filter(Boolean);

    for (const label of labels) {
      try {
        await tablesRepo.create({ tenantId: tenant.id, area, label, seats });
        console.log(`  + ${area} / ${label}`);
      } catch (err) {
        // (tenant_id, area, label) is unique, so re-running is safe and says so
        // rather than creating a duplicate table.
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  · ${area} / ${label} — ${/duplicate|unique/i.test(msg) ? 'already exists' : msg}`);
      }
    }
  }

  const tables = await db.selectMany<VenueTableRow>('venue_tables', {
    tenant_id: `eq.${tenant.id}`, order: 'area.asc,label.asc',
  });

  if (has('list') || (!add && !has('issue-all') && !arg('issue'))) {
    console.log(`\n${tables.length} table(s) for ${tenant.slug}:\n`);
    for (const t of tables) {
      console.log(`  ${t.area.padEnd(12)} ${t.label.padEnd(10)} ${t.seats} seats  ` +
                  `QR:${t.qr_token ? 'yes' : 'no '}  PIN:${t.pin_hash ? 'set' : 'not set'}`);
    }
    console.log('\nIssue codes with --issue-all, or --issue "<label>".\n');
    return;
  }

  // ── Issue credentials ─────────────────────────────────────────────────────
  const only   = arg('issue');
  const target = only ? tables.filter(t => t.label === only) : tables;

  if (target.length === 0) {
    console.error(only ? `No table labelled "${only}".` : 'No tables yet — add some with --add.');
    process.exit(1);
  }

  const cards: Array<{ area: string; label: string; pin: string; url: string; qrSvg: string }> = [];

  for (const t of target) {
    const { qrToken, pin } = await tableQrRepo.issueCredentials(tenant.id, t.id);
    const url = `${base}/t/${tenant.slug}/${qrToken}`;

    // Error correction M, not H. A table card is printed once and lives under
    // glass; M keeps the module count low enough to scan from a phone held at
    // arm's length, which matters more here than surviving damage.
    const qrSvg = await QRCode.toString(url, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 260,
    });

    cards.push({ area: t.area, label: t.label, pin, url, qrSvg });
    console.log(`  ${t.area} / ${t.label}   PIN ${pin}   ${url}`);
  }

  const out = arg('out') ?? 'cards.html';
  fs.writeFileSync(out, renderCards(tenant.slug, cards));
  console.log(`\nWrote ${cards.length} card(s) to ${out} — open it and print.`);
  console.log('The PINs above are shown ONCE. They are stored hashed and cannot be read back.\n');
}

function renderCards(
  slug: string,
  cards: Array<{ area: string; label: string; pin: string; url: string; qrSvg: string }>,
): string {
  // A6 cards, one per page, sized in mm so the print is predictable rather than
  // depending on the browser's pixel density.
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Table cards — ${esc(slug)}</title>
<style>
  @page { size: A6; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card {
    width: 105mm; height: 148mm; padding: 10mm;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; page-break-after: always; border: 1px dashed #ccc;
  }
  .area  { font-size: 10pt; letter-spacing: .18em; text-transform: uppercase; color: #777; }
  .label { font-size: 34pt; font-weight: 800; line-height: 1; margin: 2mm 0 4mm; }
  .qr    { width: 55mm; height: 55mm; }
  .qr svg { width: 100%; height: 100%; }
  .lead  { font-size: 10pt; color: #444; margin-top: 4mm; }
  .pinbox { margin-top: 3mm; padding: 3mm 6mm; border: 2px solid #111; border-radius: 3mm; }
  .pinlabel { font-size: 8pt; letter-spacing: .18em; text-transform: uppercase; color: #777; }
  .pin   { font-size: 24pt; font-weight: 800; letter-spacing: .3em; line-height: 1.1; }
  .url   { font-size: 6pt; color: #aaa; margin-top: 4mm; word-break: break-all; }
  @media screen { body { background: #eee; padding: 10mm; }
                  .card { background: #fff; margin: 0 auto 8mm; box-shadow: 0 2px 8px rgba(0,0,0,.15); } }
</style></head><body>
${cards.map(c => `  <div class="card">
    <div class="area">${esc(c.area)}</div>
    <div class="label">${esc(c.label)}</div>
    <div class="qr">${c.qrSvg}</div>
    <div class="lead">Scan to see the menu and order</div>
    <div class="pinbox">
      <div class="pinlabel">PIN</div>
      <div class="pin">${esc(c.pin)}</div>
    </div>
    <div class="url">${esc(c.url)}</div>
  </div>`).join('\n')}
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

run().catch(err => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
