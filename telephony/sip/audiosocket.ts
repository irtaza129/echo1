// AudioSocket framing.
//
// Asterisk's AudioSocket is a deliberately tiny TCP protocol: every message is
//
//     [type: 1 byte][length: 2 bytes big-endian][payload: length bytes]
//
// That is the entire specification. Keeping the codec in its own file, with no
// sockets in it, is what makes it testable — framing bugs are the single most
// likely source of garbled audio, and they are trivial to find with a unit test
// and miserable to find on a phone call.

export const FRAME = {
  /** Connection is going away. */
  TERMINATE: 0x00,
  /** 16-byte call UUID. Asterisk sends this once, first. */
  UUID:      0x01,
  /** Asterisk reporting a problem on its side. */
  ERROR:     0xff,
  /** Signed 16-bit linear PCM. The only payload type we send or care about. */
  AUDIO:     0x10,
} as const;

export interface AudioSocketFrame {
  type:    number;
  payload: Buffer;
}

/** Wrap a payload in a frame. Length is 16-bit, so a payload cannot exceed 65535. */
export function encodeFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > 0xffff) {
    throw new Error(`[AUDIOSOCKET] payload ${payload.length} exceeds the 16-bit length field`);
  }
  const header = Buffer.alloc(3);
  header.writeUInt8(type, 0);
  header.writeUInt16BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Incremental frame parser.
 *
 * TCP gives you a byte stream, not messages: one `data` event can carry half a
 * frame, or three and a half. Anything that assumes one read equals one frame
 * works perfectly on a developer's loopback and falls apart the moment there is
 * a real network between Asterisk and the app.
 */
export class FrameParser {
  private buffer = Buffer.alloc(0);

  /** Feed bytes in, get whole frames out. Partial frames are retained. */
  push(chunk: Buffer): AudioSocketFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const frames: AudioSocketFrame[] = [];
    let offset = 0;

    for (;;) {
      // Not even a header yet.
      if (this.buffer.length - offset < 3) break;

      const type   = this.buffer.readUInt8(offset);
      const length = this.buffer.readUInt16BE(offset + 1);

      // Header is complete but the body has not all arrived.
      if (this.buffer.length - offset < 3 + length) break;

      frames.push({
        type,
        // Copy rather than subarray: a view would keep the whole accumulated
        // buffer alive, and callers hold on to audio payloads while they queue.
        payload: Buffer.from(this.buffer.subarray(offset + 3, offset + 3 + length)),
      });
      offset += 3 + length;
    }

    // Keep only what has not been consumed.
    this.buffer = offset === 0
      ? this.buffer
      : Buffer.from(this.buffer.subarray(offset));

    return frames;
  }

  /** Bytes held pending more input — used by tests and for leak assertions. */
  get pending(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/** Asterisk sends the call UUID as 16 raw bytes; render it in the usual form. */
export function formatUuid(payload: Buffer): string {
  if (payload.length !== 16) return payload.toString('hex');
  const h = payload.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── Paced sending ────────────────────────────────────────────────────────────

/**
 * Split PCM into frames of one packetisation interval.
 *
 * Asterisk expects audio at the rate a phone call actually consumes it. Writing
 * a whole sentence in one go does not make it play faster — it makes Asterisk
 * buffer it, which destroys barge-in: the caller interrupts, we stop generating,
 * and the agent keeps talking for however many seconds are already queued
 * downstream where we can no longer drop them.
 *
 * 20 ms is the telephony default. At 16 kHz mono 16-bit that is
 * 16000 * 0.02 = 320 samples = 640 bytes.
 */
export const FRAME_MS = 20;

export function bytesPerFrame(sampleRate: number): number {
  return Math.round(sampleRate * (FRAME_MS / 1000)) * 2;   // 2 bytes per sample
}

export function chunkPcm(pcm: Buffer, sampleRate: number): Buffer[] {
  const size   = bytesPerFrame(sampleRate);
  const chunks: Buffer[] = [];
  for (let i = 0; i + size <= pcm.length; i += size) {
    chunks.push(Buffer.from(pcm.subarray(i, i + size)));
  }
  // A trailing partial frame is padded with silence rather than dropped:
  // dropping it clips the last few milliseconds off every utterance, which is
  // audible as a swallowed final consonant.
  const rest = pcm.length % size;
  if (rest !== 0) {
    const tail = Buffer.alloc(size);
    pcm.subarray(pcm.length - rest).copy(tail);
    chunks.push(tail);
  }
  return chunks;
}
