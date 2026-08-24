// Serialises read-modify-write mutations of a single cart.
//
// The cart lives under one Redis key and every mutation reads it, changes it and
// writes it back. Two concurrent writers both read the pre-state and the second
// write silently discards the first item — which is exactly what happens when a
// model emits two add_item calls in one turn, and it is why a customer who says
// "a pulao and a coke" could end up with only the coke.
//
// This started life inside telephony/toolDispatch.ts, guarding the WhatsApp path
// only. The race was never WhatsApp-specific: the kiosk, phone and QR channels
// all drive the same model through the same cart. It belongs next to the
// read-modify-write it protects — PosAdapter — so every channel gets it.
//
// SCOPE: per-process. It fully covers the dominant case (several tool calls in
// one turn, one request, one process). A multi-instance deployment would need a
// Redis lock or a Lua compare-and-set; noted here rather than silently assumed
// away, because the failure mode is a wrong order rather than an error.

const locks = new Map<string, Promise<unknown>>();

export function withCartLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(lockKey) ?? Promise.resolve();
  // Run regardless of how the previous holder settled: one failed add_item must
  // not wedge the cart for the rest of the conversation.
  const run  = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(lockKey, tail);
  void tail.then(() => {
    // Bound the map — without this it grows one entry per session, forever.
    if (locks.get(lockKey) === tail) locks.delete(lockKey);
  });
  return run;
}
