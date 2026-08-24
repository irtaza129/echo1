// ESC/POS receipt and kitchen-ticket builder.
//
// Thermal printers speak a byte protocol from the 1990s that every Epson-
// compatible unit implements: control sequences interleaved with text. There is
// no library dependency here because the useful subset is about a dozen
// commands, and pure byte assembly is trivially testable — which matters, since
// the alternative way to find a bug is to print a hundred wrong receipts.
//
// Encoding
// --------
// Text is written as CP437 by default, which is what these printers boot into.
// Anything outside it (an Urdu name, a curly quote pasted from a phone) is
// transliterated where there is an obvious ASCII equivalent and dropped
// otherwise. A printer fed a byte it cannot render prints a random glyph, and a
// receipt with garbage on it looks broken in a way a missing accent does not.

const ESC = 0x1b;
const GS  = 0x1d;

export const CMD = {
  INIT:          Buffer.from([ESC, 0x40]),
  ALIGN_LEFT:    Buffer.from([ESC, 0x61, 0]),
  ALIGN_CENTRE:  Buffer.from([ESC, 0x61, 1]),
  ALIGN_RIGHT:   Buffer.from([ESC, 0x61, 2]),
  BOLD_ON:       Buffer.from([ESC, 0x45, 1]),
  BOLD_OFF:      Buffer.from([ESC, 0x45, 0]),
  DOUBLE_ON:     Buffer.from([GS,  0x21, 0x11]),   // double width + height
  DOUBLE_OFF:    Buffer.from([GS,  0x21, 0x00]),
  /** Feed past the tear bar before cutting, or the cut lands mid-text. */
  CUT:           Buffer.from([GS,  0x56, 0x42, 0x03]),
  /** Pulse the cash drawer on pin 2. Drawers are wired to the printer, not the till. */
  DRAWER_KICK:   Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]),
  FEED:          (n: number) => Buffer.from([ESC, 0x64, n]),
} as const;

/** Characters a thermal printer cannot render, mapped to something it can. */
const TRANSLIT: Record<string, string> = {
  '—': '-', '–': '-', '−': '-',
  '“': '"', '”': '"', '‘': "'", '’': "'",
  '…': '...', '×': 'x', '·': '-',
  '₨': 'Rs', '€': 'EUR', '£': 'GBP', '½': '1/2', '¼': '1/4',
  'é': 'e', 'è': 'e', 'ê': 'e', 'á': 'a', 'à': 'a', 'ä': 'a',
  'í': 'i', 'ó': 'o', 'ö': 'o', 'ú': 'u', 'ü': 'u', 'ñ': 'n', 'ç': 'c',
};

/**
 * Make a string safe to print.
 *
 * Transliterate what has an equivalent, drop what does not. Dropping is
 * deliberate: an unrenderable byte prints as a random glyph, and a receipt
 * speckled with garbage reads as broken software to a customer, while a missing
 * accent reads as nothing at all.
 */
export function sanitise(text: string): string {
  let out = '';
  for (const ch of text) {
    if (TRANSLIT[ch]) { out += TRANSLIT[ch]; continue; }
    const code = ch.codePointAt(0) ?? 0;
    if (code === 10) { out += '\n'; continue; }
    if (code >= 0x20 && code <= 0x7e) { out += ch; continue; }
    // Everything else — Urdu, emoji, box drawing — is dropped.
  }
  return out;
}

export interface ReceiptLine {
  name:     string;
  quantity: number;
  total:    number;
  modifiers?: string[];
  notes?:   string | null;
}

export interface ReceiptData {
  restaurantName: string;
  addressLines?:  string[];
  orderNumber:    number | null;
  orderType:      string;
  tableLabel?:    string | null;
  placedAt:       string;
  currency:       string;
  lines:          ReceiptLine[];
  subtotal:       number;
  discount:       number;
  serviceCharge:  number;
  tax:            number;
  total:          number;
  payments?:      Array<{ method: string; amount: number; change?: number }>;
  footer?:        string;
  /** Characters per line. 48 for 80 mm paper, 32 for 58 mm. */
  width?:         number;
}

export class ReceiptBuilder {
  private readonly parts: Buffer[] = [];

  constructor(private readonly width = 48) {
    this.parts.push(CMD.INIT);
  }

  raw(b: Buffer): this { this.parts.push(b); return this; }

  text(s: string): this {
    this.parts.push(Buffer.from(sanitise(s), 'latin1'));
    return this;
  }

  line(s = ''): this { return this.text(s + '\n'); }

  centre(s: string): this {
    return this.raw(CMD.ALIGN_CENTRE).line(s).raw(CMD.ALIGN_LEFT);
  }

  bold(s: string): this {
    return this.raw(CMD.BOLD_ON).line(s).raw(CMD.BOLD_OFF);
  }

  big(s: string): this {
    return this.raw(CMD.ALIGN_CENTRE).raw(CMD.DOUBLE_ON)
      .line(s)
      .raw(CMD.DOUBLE_OFF).raw(CMD.ALIGN_LEFT);
  }

  rule(ch = '-'): this { return this.line(ch.repeat(this.width)); }

  /**
   * Left text, right-aligned value, dot leader between.
   *
   * The right column is never truncated and the left always is: a name that
   * runs long is still recognisable clipped, but a price with a digit missing
   * is a wrong number on a document the customer keeps.
   */
  row(left: string, right: string): this {
    const l = sanitise(left);
    const r = sanitise(right);
    const room = this.width - r.length - 1;
    const cut  = room <= 0 ? '' : l.length > room ? l.slice(0, room) : l;
    const gap  = Math.max(1, this.width - cut.length - r.length);
    return this.line(cut + ' '.repeat(gap) + r);
  }

  feedAndCut(): this { return this.raw(CMD.FEED(4)).raw(CMD.CUT); }

  kickDrawer(): this { return this.raw(CMD.DRAWER_KICK); }

  build(): Buffer { return Buffer.concat(this.parts); }
}

const money = (n: number, cur: string) => `${cur} ${n.toFixed(2)}`;

/** A customer's receipt. */
export function buildReceipt(d: ReceiptData): Buffer {
  const w = d.width ?? 48;
  const b = new ReceiptBuilder(w);

  b.raw(CMD.ALIGN_CENTRE).raw(CMD.BOLD_ON).raw(CMD.DOUBLE_ON)
    .line(d.restaurantName)
    .raw(CMD.DOUBLE_OFF).raw(CMD.BOLD_OFF);

  for (const l of d.addressLines ?? []) b.line(l);
  b.raw(CMD.ALIGN_LEFT).line();

  b.row('Order', `#${d.orderNumber ?? '-'}`);
  b.row('Type', d.orderType.replace('_', ' '));
  if (d.tableLabel) b.row('Table', d.tableLabel);
  b.row('Date', new Date(d.placedAt).toLocaleString());
  b.rule();

  for (const line of d.lines) {
    b.row(`${line.quantity}x ${line.name}`, money(line.total, d.currency));
    for (const m of line.modifiers ?? []) b.line(`   + ${m}`);
    if (line.notes) b.line(`   * ${line.notes}`);
  }

  b.rule();
  b.row('Subtotal', money(d.subtotal, d.currency));
  if (d.discount      > 0) b.row('Discount',       `-${money(d.discount, d.currency)}`);
  if (d.serviceCharge > 0) b.row('Service charge', money(d.serviceCharge, d.currency));
  if (d.tax           > 0) b.row('Tax',            money(d.tax, d.currency));

  b.raw(CMD.BOLD_ON).row('TOTAL', money(d.total, d.currency)).raw(CMD.BOLD_OFF);

  if (d.payments?.length) {
    b.line();
    for (const p of d.payments) {
      b.row(p.method.toUpperCase(), money(p.amount, d.currency));
      if (p.change && p.change > 0) b.row('Change', money(p.change, d.currency));
    }
  }

  b.line();
  b.centre(d.footer ?? 'Thank you');
  return b.feedAndCut().build();
}

export interface TicketData {
  orderNumber: number | null;
  orderType:   string;
  tableLabel?: string | null;
  placedAt:    string;
  station?:    string | null;
  lines:       Array<{ name: string; quantity: number; modifiers?: string[]; notes?: string | null; seat?: number | null }>;
  /** Set on a reprint so the kitchen does not cook it twice. */
  reprint?:    boolean;
  width?:      number;
}

/**
 * A kitchen ticket.
 *
 * Deliberately not a receipt with the prices removed. A cook reads this at
 * arm's length in a hot room, so the order number is double height, quantities
 * lead every line, and money never appears — it is not information the kitchen
 * can act on.
 */
export function buildKitchenTicket(t: TicketData): Buffer {
  const w = t.width ?? 48;
  const b = new ReceiptBuilder(w);

  if (t.reprint) {
    // Loud, because the cost of a cook missing this is a duplicate dish.
    b.raw(CMD.ALIGN_CENTRE).raw(CMD.BOLD_ON)
      .line('*** REPRINT — MAY ALREADY BE MADE ***')
      .raw(CMD.BOLD_OFF).raw(CMD.ALIGN_LEFT);
  }

  b.big(`#${t.orderNumber ?? '-'}`);

  const where = t.tableLabel ? `TABLE ${t.tableLabel}` : t.orderType.replace('_', ' ').toUpperCase();
  b.raw(CMD.ALIGN_CENTRE).raw(CMD.BOLD_ON).line(where).raw(CMD.BOLD_OFF).raw(CMD.ALIGN_LEFT);

  if (t.station) b.centre(t.station);
  b.line(new Date(t.placedAt).toLocaleTimeString());
  b.rule('=');

  for (const l of t.lines) {
    b.raw(CMD.BOLD_ON).line(`${l.quantity} x ${l.name}`).raw(CMD.BOLD_OFF);
    for (const m of l.modifiers ?? []) b.line(`    + ${m}`);
    // Notes are what the customer actually asked for — no onions, extra spicy.
    // Bold because missing one means the plate comes back.
    if (l.notes) b.raw(CMD.BOLD_ON).line(`    ** ${l.notes}`).raw(CMD.BOLD_OFF);
    if (l.seat) b.line(`    seat ${l.seat}`);
    b.line();
  }

  return b.feedAndCut().build();
}
