// The system prompt the table voice agent runs on.
//
//   npx tsx testing/test-guest-voice.ts
//
// Pure — no DB, no network, no key. These assertions exist because the failure
// mode is not a crash: a prompt that asks a seated diner "are you dine-in or
// delivery?" works perfectly, and is simply wrong every single time.

import assert from 'node:assert';
import { PromptBuilder } from '../src/lib/PromptBuilder.js';

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const MENU = '## Mains\n- Chicken Karahi — 750\n- Naan — 50\n';

const base = {
  restaurantName: 'Test Kitchen',
  gemini: { agentName: 'Echo', voice: 'Puck', languages: ['en', 'ur'], systemPromptExtras: '' },
  businessRules: { gstRate: 0.15 },
};

const qr    = PromptBuilder.build({ ...base, channel: 'qr', tableLabel: '6', acceptsCard: false }, MENU);
const kiosk = PromptBuilder.build({ ...base, channel: 'kiosk', acceptsCard: true }, MENU);
const wa    = PromptBuilder.build({ ...base, channel: 'whatsapp', acceptsCard: false }, MENU);

section('table voice prompt (channel: qr)');

check('names the table so the agent never has to ask', () => {
  assert.match(qr, /TABLE 6/i, 'the prompt should state which table this is');
});

check('is told explicitly not to ask for a table number', () => {
  assert.match(qr, /NEVER ask for a table number/i);
});

check('is told not to ask for name, phone or address', () => {
  // A diner is sitting in the room. Asking for a delivery address is the kind
  // of thing that makes the whole product feel like a form.
  assert.match(qr, /phone number or an address/i);
});

check('never offers pickup or delivery', () => {
  assert.match(qr, /ALWAYS a dine-in order/i);
  assert.doesNotMatch(qr, /Is this dine-in, pickup, or takeaway/i,
    'the order-type question must not appear for a seated diner');
});

check('never raises payment', () => {
  assert.match(qr, /Never mention payment|Do NOT ask how they want to pay/i);
  assert.doesNotMatch(qr, /Will you pay by cash or card/i,
    'a waiter settles the bill at the end — the agent must not ask');
});

check('points at the Call waiter button rather than improvising', () => {
  assert.match(qr, /Call waiter/i);
});

check('still carries the menu and the strict menu rules', () => {
  assert.match(qr, /Chicken Karahi/);
  assert.match(qr, /ONLY offer, discuss, or confirm items/i);
  assert.match(qr, /NEVER confirm that an item is available until add_item returns/i);
});

check('still carries the language-matching rules', () => {
  assert.match(qr, /Detect the language they used/i);
  assert.match(qr, /Roman Urdu/);
});

section('the other channels are unchanged');

check('kiosk still asks the order type', () => {
  assert.match(kiosk, /Is this dine-in, pickup, or takeaway/i);
});

check('kiosk still offers card when the tenant takes it', () => {
  assert.match(kiosk, /Will you pay by cash or card/i);
});

check('a cash-only kiosk does not offer card', () => {
  const cashOnly = PromptBuilder.build({ ...base, channel: 'kiosk', acceptsCard: false }, MENU);
  assert.doesNotMatch(cashOnly, /Will you pay by cash or card/i);
  assert.match(cashOnly, /takes cash at the counter only/i);
});

check('whatsapp still says text-only and is unaffected by the qr branch', () => {
  assert.match(wa, /TEXT REPLIES ONLY/i);
  assert.doesNotMatch(wa, /TABLE 6/i);
});

section('degrading safely');

check('a qr prompt without a table label still forbids asking', () => {
  // If the label is somehow missing, the agent must fall back to "their table",
  // never to asking — the whole point is that it already knows.
  const noLabel = PromptBuilder.build({ ...base, channel: 'qr', acceptsCard: false }, MENU);
  assert.match(noLabel, /their table/i);
  assert.match(noLabel, /NEVER ask for a table number/i);
  assert.doesNotMatch(noLabel, /undefined/, 'a missing label must not leak "undefined" into the prompt');
});

check('tenant extras still reach the qr prompt', () => {
  const withExtras = PromptBuilder.build({
    ...base,
    gemini: { ...base.gemini, systemPromptExtras: 'Cola Next is the cola brand.' },
    channel: 'qr', tableLabel: '6', acceptsCard: false,
  }, MENU);
  assert.match(withExtras, /Cola Next is the cola brand/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
