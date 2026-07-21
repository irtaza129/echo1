// ─────────────────────────────────────────────────────────────────────────────
// Money helpers — PKR, integer paisa.
//
// The rest of the app currently tracks prices as rupee `number`s (e.g. 850) and
// rounds GST with Math.round. Floating-point rupees are fine for display but
// unsafe for ledgers and gateway amounts. Internally the payment layer works in
// integer **paisa** (1 rupee = 100 paisa) so totals never drift.
//
// Pure functions, no imports — usable from server (tsx) and tests.
// ─────────────────────────────────────────────────────────────────────────────

export const PAISA_PER_RUPEE = 100;

/** Convert a rupee amount (possibly fractional) to integer paisa, safely rounded. */
export function rupeesToPaisa(rupees: number): number {
  if (!Number.isFinite(rupees)) throw new Error(`[MONEY] invalid rupee amount: ${rupees}`);
  return Math.round(rupees * PAISA_PER_RUPEE);
}

/** Convert integer paisa back to a rupee number (for display / legacy fields). */
export function paisaToRupees(paisa: number): number {
  return paisa / PAISA_PER_RUPEE;
}

/** Format paisa as a human string, e.g. 123450 → "PKR 1,234.50". */
export function formatPaisa(paisa: number, currency = 'PKR'): string {
  const rupees = paisaToRupees(paisa);
  const formatted = rupees.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${formatted}`;
}

/**
 * Safepay's order/init endpoint expects the amount in the major unit (rupees)
 * as a number with up to 2 decimal places. Convert from our internal paisa.
 */
export function paisaToGatewayAmount(paisa: number): number {
  return Math.round(paisa) / PAISA_PER_RUPEE;
}
