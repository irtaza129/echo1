import crypto from 'crypto';

// Hashing for staff terminal PINs.
//
// A PIN is short by design — a cashier types it forty times a shift, so it is
// four digits, which is 10,000 possibilities. Every property of a good password
// hash that usually feels optional becomes load-bearing at that size:
//
//   • scrypt, not sha256. platform_users.password_hash is sha256 today; at
//     10,000 candidates a GPU clears that space in microseconds. scrypt with
//     N=16384 makes an offline sweep of one leaked hash cost real time and
//     memory, and it is in Node's standard library, so no new dependency.
//   • A per-PIN random salt, so two staff who both pick 1234 do not share a
//     hash, and one cracked PIN does not reveal the other.
//   • timingSafeEqual on compare, so response time never leaks how much of the
//     hash matched.
//
// None of this replaces rate limiting. Offline resistance is what this file
// buys; online resistance is the lockout in routes/pos.ts, and that is the
// control that actually matters against someone standing at the terminal.

const N = 16384;   // CPU/memory cost
const R = 8;       // block size
const P = 1;       // parallelisation
const KEYLEN     = 32;
const SALT_BYTES = 16;

// scrypt needs maxmem above roughly 128 * N * r; Node's default is 32 MB, and
// 128 * 16384 * 8 is 16 MB — under the default but close enough that it is
// worth being explicit rather than relying on it.
const MAXMEM = 64 * 1024 * 1024;

function derive(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key as Buffer)));
  });
}

/** Format: `scrypt$N$r$p$saltHex$hashHex` — self-describing so the parameters can change later. */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key  = await derive(pin, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
    const salt     = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');

    // Read the cost parameters back from the stored string rather than using
    // today's constants, so raising N later does not invalidate every PIN.
    const key = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(pin.normalize('NFKC'), salt, expected.length,
        { N: Number(nStr), r: Number(rStr), p: Number(pStr), maxmem: MAXMEM },
        (err, k) => (err ? reject(err) : resolve(k as Buffer)));
    });

    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    // A malformed stored hash must read as "wrong PIN", never as an exception
    // that a caller might mistake for a system fault and retry around.
    return false;
  }
}

/**
 * A PIN must be 4–8 digits. Digits only, because the terminal shows a numeric
 * keypad and a PIN nobody can type is a PIN that gets written on the monitor.
 */
export function isValidPinFormat(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

// Rejects PINs that are trivially guessable within the handful of attempts the
// lockout allows. `0000`, `1234` and `1111` are, in survey after survey, a
// double-digit percentage of all four-digit PINs chosen by humans.
const BANNED = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '0123', '1212', '2580', '1004', '2000', '1122', '6969',
]);

export function isWeakPin(pin: string): boolean {
  if (BANNED.has(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true;                       // all one digit

  // Straight runs up or down, at any length: 3456, 87654.
  const asc  = pin.split('').every((d, i, a) => i === 0 || Number(d) === Number(a[i - 1]) + 1);
  const desc = pin.split('').every((d, i, a) => i === 0 || Number(d) === Number(a[i - 1]) - 1);
  return asc || desc;
}
