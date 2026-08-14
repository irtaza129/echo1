// ─────────────────────────────────────────────────────────────────────────────
// Paddle currency rules.
//
// Paddle only accepts a fixed set of currencies, and PKR is NOT one of them.
// This was confirmed against the live sandbox API, which rejects anything else
// with a 400 listing exactly these codes:
//
//   POST /transactions { unit_price: { currency_code: "PKR" } }
//   → 400 items.0.price.unit_price.currency_code:
//       must be one of the following: "ARS", "AUD", … "ZAR"
//
// So a tenant's currency decides whether Paddle can collect for them at all.
// Pakistani tenants stay cash-only until Safepay (payments/SafepayProvider.ts,
// already implemented) is wired into the order flow.
//
// Pure functions, no imports — usable from server (tsx) and tests.
// ─────────────────────────────────────────────────────────────────────────────

/** Every currency Paddle accepts, verbatim from the sandbox API's 400 response. */
export const PADDLE_CURRENCIES = [
  'ARS', 'AUD', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CZK', 'DKK', 'EUR',
  'GBP', 'HKD', 'HUF', 'ILS', 'INR', 'JPY', 'KRW', 'MXN', 'NOK', 'NZD', 'PEN',
  'PLN', 'RUB', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'UAH', 'USD', 'VND', 'ZAR',
] as const;

export type PaddleCurrency = typeof PADDLE_CURRENCIES[number];

// Currencies with no minor unit. Paddle wants amounts in the LOWEST denomination
// for every currency, but for these the lowest denomination IS the major unit —
// ¥1000 is "1000", not "100000". Getting this wrong overcharges by 100×, which
// is the kind of bug that only shows up in the one market you didn't test.
export const ZERO_DECIMAL_CURRENCIES = ['JPY', 'KRW', 'CLP'] as const;

export function isPaddleCurrency(code: string): code is PaddleCurrency {
  return (PADDLE_CURRENCIES as readonly string[]).includes(code.toUpperCase());
}

export function isZeroDecimal(code: string): boolean {
  return (ZERO_DECIMAL_CURRENCIES as readonly string[]).includes(code.toUpperCase());
}

/**
 * Convert our internal integer minor units (paisa/cents — payments/money.ts
 * works in 1/100ths regardless of currency) into the string Paddle expects.
 *
 * For a zero-decimal currency our 1/100th representation has to be divided back
 * down, because Paddle counts ¥ in whole yen.
 */
export function toPaddleAmount(minorUnits: number, currency: string): string {
  if (!Number.isFinite(minorUnits)) {
    throw new Error(`[PADDLE] invalid amount: ${minorUnits}`);
  }
  const amount = isZeroDecimal(currency)
    ? Math.round(minorUnits / 100)
    : Math.round(minorUnits);
  return String(amount);
}

/** Inverse of toPaddleAmount — Paddle's string back into our internal 1/100ths. */
export function fromPaddleAmount(amount: string | number, currency: string): number {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) throw new Error(`[PADDLE] invalid amount from Paddle: ${amount}`);
  return isZeroDecimal(currency) ? Math.round(n * 100) : Math.round(n);
}

/**
 * Guard used at tenant onboarding and before every checkout. Throwing here is
 * deliberate: silently falling back to another currency would charge the
 * customer the right number in the wrong money.
 */
export function assertPaddleCurrency(code: string): PaddleCurrency {
  const upper = code.toUpperCase();
  if (!isPaddleCurrency(upper)) {
    throw new Error(
      `[PADDLE] currency ${upper} is not supported by Paddle. ` +
      `Supported: ${PADDLE_CURRENCIES.join(', ')}. ` +
      `Tenants on ${upper} must use a different provider (cash, or Safepay for PKR).`,
    );
  }
  return upper;
}
