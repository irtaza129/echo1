import net from 'net';

// Sending bytes to a thermal printer.
//
// Network printers listen on TCP 9100 (the JetDirect convention) and accept a
// raw byte stream — no handshake, no protocol, no acknowledgement. That last
// part matters: a successful write means the bytes reached the printer's
// socket, NOT that anything was printed. A printer out of paper accepts the
// job and silently drops it.
//
// So this never reports success as certainty, and the till never treats a
// failed print as a failed sale. A receipt is a nice-to-have; the money has
// already moved.

export interface PrinterTarget {
  host: string;
  port?: number;
  /** Characters per line: 48 for 80 mm paper, 32 for 58 mm. */
  width?: number;
}

const CONNECT_TIMEOUT_MS = 4000;
const WRITE_TIMEOUT_MS   = 8000;

export interface PrintResult {
  ok:     boolean;
  error?: string;
}

/**
 * Write a job to a network printer.
 *
 * Never throws — the caller is a route handler that has already taken money.
 */
export function printRaw(target: PrinterTarget, data: Buffer): Promise<PrintResult> {
  return new Promise(resolve => {
    const port = target.port ?? 9100;
    let settled = false;

    const done = (r: PrintResult) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(r);
    };

    const socket = net.createConnection({ host: target.host, port });

    // A printer that is switched off does not refuse the connection — it simply
    // never answers, so without an explicit timeout this hangs until the OS
    // gives up, which can be minutes with a cashier waiting.
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.on('timeout', () => done({ ok: false, error: `printer ${target.host}:${port} did not respond` }));
    socket.on('error',   (err) => done({ ok: false, error: err.message }));

    socket.on('connect', () => {
      socket.setTimeout(WRITE_TIMEOUT_MS);
      socket.write(data, err => {
        if (err) { done({ ok: false, error: err.message }); return; }
        // Half-close so the printer sees end-of-job, then let it settle before
        // dropping the socket — destroying immediately can truncate the tail on
        // some firmware.
        socket.end();
        setTimeout(() => done({ ok: true }), 150);
      });
    });
  });
}

/**
 * Where a tenant's printers live.
 *
 * Stored in adapter credentials rather than TenantConfig because an IP on the
 * restaurant's LAN is closer to infrastructure than to settings, and because
 * TenantConfig is served to the browser in places.
 */
export interface PrinterConfig {
  receipt?: PrinterTarget;
  kitchen?: PrinterTarget;
}

export function parsePrinterConfig(raw: unknown): PrinterConfig {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;

  const one = (v: unknown): PrinterTarget | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const t = v as Record<string, unknown>;
    if (typeof t.host !== 'string' || !t.host) return undefined;
    return {
      host:  t.host,
      port:  typeof t.port  === 'number' ? t.port  : 9100,
      width: typeof t.width === 'number' ? t.width : 48,
    };
  };

  return { receipt: one(o.receipt), kitchen: one(o.kitchen) };
}
