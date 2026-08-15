// ─────────────────────────────────────────────────────────────────────────────
// Country → currency reference for onboarding.
//
// The onboarder picks a country, not a currency: "Pakistan" is something a
// restaurant owner knows about itself, whereas "is PKR one of Paddle's 33
// accepted currencies" is our problem, not theirs. This table is the bridge.
//
// Two distinct fields come out of one choice, and conflating them is the bug
// this module exists to prevent:
//   - `currency` is the ISO 4217 code sent to the payment gateway.
//   - `symbol`   is display only (menu prices, cart totals) and never reaches
//                Paddle.
// Before this existed the wizard collected only the symbol, so `currency`
// silently kept its schema default of PKR for every tenant on earth.
//
// Whether a country can take card payments is NOT encoded here — that is
// derived by checking `currency` against PADDLE_CURRENCIES, so adding a Paddle
// currency (or a second provider) never requires editing this list.
//
// Pure, import-free — usable from the browser wizard, the server, and tests.
// ─────────────────────────────────────────────────────────────────────────────

export interface Country {
  /** ISO 3166-1 alpha-2. */
  code:     string;
  name:     string;
  /** ISO 4217, sent to the gateway. */
  currency: string;
  /** Display only — never sent to Paddle. */
  symbol:   string;
}

// Sorted by name so the <select> needs no client-side sorting. Every currency
// Paddle accepts is represented by at least one country; the unsupported ones
// (PKR, AED, SAR, BDT, …) are deliberately present rather than hidden, because
// a Pakistani restaurant must still be able to onboard — as a cash tenant.
export const COUNTRIES: readonly Country[] = [
  { code: 'AR', name: 'Argentina',        currency: 'ARS', symbol: '$'   },
  { code: 'AU', name: 'Australia',        currency: 'AUD', symbol: 'A$'  },
  { code: 'AT', name: 'Austria',          currency: 'EUR', symbol: '€'   },
  { code: 'BD', name: 'Bangladesh',       currency: 'BDT', symbol: '৳'   },
  { code: 'BE', name: 'Belgium',          currency: 'EUR', symbol: '€'   },
  { code: 'BR', name: 'Brazil',           currency: 'BRL', symbol: 'R$'  },
  { code: 'CA', name: 'Canada',           currency: 'CAD', symbol: 'C$'  },
  { code: 'CL', name: 'Chile',            currency: 'CLP', symbol: '$'   },
  { code: 'CN', name: 'China',            currency: 'CNY', symbol: '¥'   },
  { code: 'CO', name: 'Colombia',         currency: 'COP', symbol: '$'   },
  { code: 'CZ', name: 'Czechia',          currency: 'CZK', symbol: 'Kč'  },
  { code: 'DK', name: 'Denmark',          currency: 'DKK', symbol: 'kr'  },
  { code: 'EG', name: 'Egypt',            currency: 'EGP', symbol: 'E£'  },
  { code: 'FI', name: 'Finland',          currency: 'EUR', symbol: '€'   },
  { code: 'FR', name: 'France',           currency: 'EUR', symbol: '€'   },
  { code: 'DE', name: 'Germany',          currency: 'EUR', symbol: '€'   },
  { code: 'GR', name: 'Greece',           currency: 'EUR', symbol: '€'   },
  { code: 'HK', name: 'Hong Kong',        currency: 'HKD', symbol: 'HK$' },
  { code: 'HU', name: 'Hungary',          currency: 'HUF', symbol: 'Ft'  },
  { code: 'IN', name: 'India',            currency: 'INR', symbol: '₹'   },
  { code: 'ID', name: 'Indonesia',        currency: 'IDR', symbol: 'Rp'  },
  { code: 'IE', name: 'Ireland',          currency: 'EUR', symbol: '€'   },
  { code: 'IL', name: 'Israel',           currency: 'ILS', symbol: '₪'   },
  { code: 'IT', name: 'Italy',            currency: 'EUR', symbol: '€'   },
  { code: 'JP', name: 'Japan',            currency: 'JPY', symbol: '¥'   },
  { code: 'KE', name: 'Kenya',            currency: 'KES', symbol: 'KSh' },
  { code: 'KW', name: 'Kuwait',           currency: 'KWD', symbol: 'KD'  },
  { code: 'MY', name: 'Malaysia',         currency: 'MYR', symbol: 'RM'  },
  { code: 'MX', name: 'Mexico',           currency: 'MXN', symbol: '$'   },
  { code: 'NL', name: 'Netherlands',      currency: 'EUR', symbol: '€'   },
  { code: 'NZ', name: 'New Zealand',      currency: 'NZD', symbol: 'NZ$' },
  { code: 'NG', name: 'Nigeria',          currency: 'NGN', symbol: '₦'   },
  { code: 'NO', name: 'Norway',           currency: 'NOK', symbol: 'kr'  },
  { code: 'PK', name: 'Pakistan',         currency: 'PKR', symbol: 'Rs.' },
  { code: 'PE', name: 'Peru',             currency: 'PEN', symbol: 'S/'  },
  { code: 'PH', name: 'Philippines',      currency: 'PHP', symbol: '₱'   },
  { code: 'PL', name: 'Poland',           currency: 'PLN', symbol: 'zł'  },
  { code: 'PT', name: 'Portugal',         currency: 'EUR', symbol: '€'   },
  { code: 'QA', name: 'Qatar',            currency: 'QAR', symbol: 'QR'  },
  { code: 'RU', name: 'Russia',           currency: 'RUB', symbol: '₽'   },
  { code: 'SA', name: 'Saudi Arabia',     currency: 'SAR', symbol: 'SR'  },
  { code: 'SG', name: 'Singapore',        currency: 'SGD', symbol: 'S$'  },
  { code: 'ZA', name: 'South Africa',     currency: 'ZAR', symbol: 'R'   },
  { code: 'KR', name: 'South Korea',      currency: 'KRW', symbol: '₩'   },
  { code: 'ES', name: 'Spain',            currency: 'EUR', symbol: '€'   },
  { code: 'LK', name: 'Sri Lanka',        currency: 'LKR', symbol: 'Rs'  },
  { code: 'SE', name: 'Sweden',           currency: 'SEK', symbol: 'kr'  },
  { code: 'CH', name: 'Switzerland',      currency: 'CHF', symbol: 'CHF' },
  { code: 'TW', name: 'Taiwan',           currency: 'TWD', symbol: 'NT$' },
  { code: 'TH', name: 'Thailand',         currency: 'THB', symbol: '฿'   },
  { code: 'TR', name: 'Türkiye',          currency: 'TRY', symbol: '₺'   },
  { code: 'UA', name: 'Ukraine',          currency: 'UAH', symbol: '₴'   },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED', symbol: 'AED' },
  { code: 'GB', name: 'United Kingdom',   currency: 'GBP', symbol: '£'   },
  { code: 'US', name: 'United States',    currency: 'USD', symbol: '$'   },
  { code: 'VN', name: 'Vietnam',          currency: 'VND', symbol: '₫'   },
] as const;

export function countryByCode(code: string): Country | undefined {
  const upper = code.toUpperCase();
  return COUNTRIES.find(c => c.code === upper);
}
