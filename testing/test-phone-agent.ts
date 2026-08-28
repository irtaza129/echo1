// The phone agent's prompt, tools and DID normalisation.
//
//   npx tsx testing/test-phone-agent.ts
//
// Pure — no Asterisk, no trunk, no key. The failure mode being guarded against
// is not a crash: a phone prompt that forgets to speak first works fine in
// testing and leaves every real caller listening to silence.

import assert from 'node:assert';
import { PromptBuilder } from '../src/lib/PromptBuilder.js';
import { phoneTools } from '../telephony/phoneTools.js';
import { normaliseDid } from '../telephony/phoneRouting.js';
import { maskNumber } from '../telephony/callRepo.js';
import { allTools } from '../src/lib/geminiTools.js';

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const MENU = '## Mains\n- Chicken Karahi — 750\n- Naan — 50\n';
const base = {
  restaurantName: 'Savour Foods',
  gemini: { agentName: 'Echo', voice: 'Puck', languages: ['en', 'ur'], systemPromptExtras: '' },
  businessRules: { gstRate: 0.15 },
};

const phone   = PromptBuilder.build({ ...base, channel: 'phone', acceptsCard: false }, MENU);
const noHuman = phone;
const withHuman = PromptBuilder.build(
  { ...base, channel: 'phone', acceptsCard: false, canTransferToHuman: true }, MENU);

section('phone prompt');

check('the agent speaks first', () => {
  // On every other channel it waits. On a phone, silence reads as a dead line
  // and people hang up before saying anything.
  // Matched case-SENSITIVELY: /speak first/i would also match the kiosk's
  // 'Do NOT speak first', which is the opposite instruction.
  assert.match(phone, /SPEAK FIRST/);
  assert.match(phone, /The moment the call connects/);
  assert.doesNotMatch(phone, /Do NOT speak first/i);
});

check('greets with the restaurant name', () => {
  assert.match(phone, /Savour Foods, good afternoon/i);
});

check('asks the routing question, verbatim and first', () => {
  assert.match(
    phone,
    /Is this for delivery, pick-up or take-away — or did you have a question about dining in\?/,
    'the opening question must be exactly as specified',
  );
  // And it must come before item-taking, or the agent starts an order it may
  // then have to unwind.
  const askIdx  = phone.indexOf('did you have a question about dining in');
  const itemIdx = phone.indexOf('take the order');
  assert.ok(askIdx > -1 && itemIdx > askIdx, 'routing must precede order taking');
});

check('routes all three fulfilment types plus the enquiry branch', () => {
  assert.match(phone, /set_order_type\("delivery"\)/);
  assert.match(phone, /set_order_type\("pickup"\)/);
  assert.match(phone, /set_order_type\("takeaway"\)/);
  assert.match(phone, /this is an ENQUIRY/i);
});

check('an enquiry is not force-fed into the ordering flow', () => {
  assert.match(phone, /Do NOT try to turn an enquiry into an order/i);
});

check('demands an address for delivery', () => {
  assert.match(phone, /capture_address/);
  assert.match(phone, /landmark/i, 'a Pakistani address without a landmark is often undeliverable');
});

check('does not assume it has the caller number', () => {
  // PK trunks frequently do not deliver CLI, so assuming one produces orders
  // nobody can call back about.
  assert.match(phone, /Do NOT assume you already have their number/i);
  assert.match(phone, /Read the number back digit by digit/i);
});

check('never says tap or screen', () => {
  assert.match(phone, /Never say "tap", "the screen"/i);
});

check('reads numbers digit by digit', () => {
  assert.match(phone, /oh three double-one/i);
});

check('acknowledges poor line quality rather than guessing', () => {
  assert.match(phone, /If you are not sure what they said, ASK/i);
});

check('offers a transfer only when one is configured', () => {
  assert.match(withHuman, /call transfer_to_human/i);
  assert.match(noHuman,   /there is nobody to transfer to/i);
  assert.doesNotMatch(noHuman, /call transfer_to_human/i,
    'advertising a transfer with nowhere to go teaches the model to keep trying it');
});

check('still carries the menu and strict menu rules', () => {
  assert.match(phone, /Chicken Karahi/);
  assert.match(phone, /ONLY offer, discuss, or confirm items/i);
});

check('still carries the language rules', () => {
  assert.match(phone, /Detect the language they used/i);
});

section('other channels are unaffected');

check('kiosk still waits for the customer', () => {
  const kiosk = PromptBuilder.build({ ...base, channel: 'kiosk', acceptsCard: true }, MENU);
  assert.match(kiosk, /Do NOT speak first/i);
  assert.doesNotMatch(kiosk, /The moment the call connects/,
    'the phone greeting instruction must not leak into the kiosk prompt');
});

check('the table channel is untouched by the phone branch', () => {
  const qr = PromptBuilder.build({ ...base, channel: 'qr', tableLabel: '6', acceptsCard: false }, MENU);
  assert.match(qr, /TABLE 6/);
  assert.doesNotMatch(qr, /delivery, pick-up or take-away/i,
    'a seated diner is never asked how they want their food delivered');
});

section('phone tools');

const tools     = phoneTools({ canTransfer: true });
const noXfer    = phoneTools({ canTransfer: false });
const names     = tools.map(t => t.name);

check('carries the ordering tools plus the phone-only ones', () => {
  for (const n of ['add_item', 'remove_item', 'clear_cart', 'confirm_order',
                   'set_order_type', 'capture_address', 'check_hours', 'end_call']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

check('transfer_to_human appears only when there is somewhere to transfer', () => {
  assert.ok(names.includes('transfer_to_human'));
  assert.ok(!noXfer.map(t => t.name).includes('transfer_to_human'));
});

check('session_id is stripped from every tool', () => {
  // The session IS the call. A model that can name a session id can name the
  // wrong one — the same reasoning as WhatsApp and the table app.
  for (const t of tools) {
    const props = (t.parameters?.properties ?? {}) as Record<string, unknown>;
    assert.ok(!('session_id' in props), `${t.name} still exposes session_id`);
    assert.ok(!(t.parameters?.required ?? []).includes('session_id'),
      `${t.name} still requires session_id`);
  }
});

check('add_item keeps its real parameters after stripping', () => {
  const add   = tools.find(t => t.name === 'add_item')!;
  const props = (add.parameters?.properties ?? {}) as Record<string, unknown>;
  assert.ok('dish_query' in props, 'stripping must not remove anything else');
  assert.ok('modifiers'  in props);
  assert.ok((add.parameters?.required ?? []).includes('dish_query'));
});

check('building phone tools does NOT mutate the shared kiosk tools', () => {
  // The real hazard. phoneTools maps over allTools to strip session_id; if it
  // edited those objects in place instead of copying, the kiosk and WhatsApp
  // would silently lose session_id too — and every one of their tool calls
  // would start failing, far from this file.
  phoneTools({ canTransfer: false });
  phoneTools({ canTransfer: true });

  const kioskAdd = allTools.find(t => t.name === 'add_item')!;
  const props    = (kioskAdd.parameters?.properties ?? {}) as Record<string, unknown>;
  assert.ok('session_id' in props,
    'allTools.add_item must STILL carry session_id after phoneTools ran');
  assert.ok((kioskAdd.parameters?.required ?? []).includes('session_id'),
    'and must still require it');
});

section('DID routing and masking');

check('DID comparison ignores formatting', () => {
  // A tenant types "+92 300 123 4567"; Asterisk delivers "923001234567".
  assert.equal(normaliseDid('+92 300 123 4567'), '923001234567');
  assert.equal(normaliseDid('(042) 111-000-111'), '042111000111');
  assert.equal(normaliseDid('923001234567'), '923001234567');
});

check('an empty or junk DID normalises to nothing, not a match', () => {
  assert.equal(normaliseDid(''), '');
  assert.equal(normaliseDid('anonymous'), '');
});

check('caller numbers are masked for logs', () => {
  assert.equal(maskNumber('923001234567'), '****4567');
  assert.equal(maskNumber('123'), '****');
  assert.equal(maskNumber(null), 'unknown');
  assert.equal(maskNumber(undefined), 'unknown');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
