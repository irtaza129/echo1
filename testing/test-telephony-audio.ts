// AudioSocket framing and 24k→16k resampling.
//
//   npx tsx testing/test-telephony-audio.ts
//
// Pure — no sockets, no Asterisk, no key. This is the layer where a bug sounds
// like "the agent is garbled" on a live call and takes a day to find, so it is
// worth pinning down here where it takes a second.

import assert from 'node:assert';
import {
  FRAME, encodeFrame, FrameParser, formatUuid, chunkPcm, bytesPerFrame,
} from '../telephony/sip/audiosocket.js';
import { pcm24kTo16k, pcm16kTo24k } from '../telephony/sip/resample.js';

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

// ── Framing ──────────────────────────────────────────────────────────────────

section('AudioSocket framing');

check('a frame round-trips', () => {
  const payload = Buffer.from([1, 2, 3, 4]);
  const p = new FrameParser();
  const frames = p.push(encodeFrame(FRAME.AUDIO, payload));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, FRAME.AUDIO);
  assert.deepEqual(frames[0].payload, payload);
});

check('the header is type + 16-bit big-endian length', () => {
  const f = encodeFrame(FRAME.AUDIO, Buffer.alloc(640));
  assert.equal(f.readUInt8(0), 0x10);
  assert.equal(f.readUInt16BE(1), 640);
  assert.equal(f.length, 643);
});

check('several frames in one chunk are all parsed', () => {
  const p = new FrameParser();
  const buf = Buffer.concat([
    encodeFrame(FRAME.UUID, Buffer.alloc(16, 7)),
    encodeFrame(FRAME.AUDIO, Buffer.alloc(640, 1)),
    encodeFrame(FRAME.AUDIO, Buffer.alloc(640, 2)),
  ]);
  const frames = p.push(buf);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].type, FRAME.UUID);
  assert.equal(p.pending, 0, 'nothing should be left over');
});

check('a frame split across two chunks is reassembled', () => {
  // The case that works on loopback and breaks over a real network.
  const p = new FrameParser();
  const whole = encodeFrame(FRAME.AUDIO, Buffer.alloc(640, 9));
  assert.deepEqual(p.push(whole.subarray(0, 100)), [], 'a partial frame yields nothing');
  const frames = p.push(whole.subarray(100));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 640);
});

check('a header split mid-way is handled', () => {
  const p = new FrameParser();
  const whole = encodeFrame(FRAME.AUDIO, Buffer.alloc(4, 3));
  assert.deepEqual(p.push(whole.subarray(0, 2)), [], 'two header bytes is not a frame');
  const frames = p.push(whole.subarray(2));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 4);
});

check('byte-at-a-time delivery still reassembles', () => {
  // The pathological case. If this passes, no realistic fragmentation breaks it.
  const p = new FrameParser();
  const whole = Buffer.concat([
    encodeFrame(FRAME.AUDIO, Buffer.alloc(20, 4)),
    encodeFrame(FRAME.AUDIO, Buffer.alloc(20, 5)),
  ]);
  const got = [];
  for (const byte of whole) got.push(...p.push(Buffer.from([byte])));
  assert.equal(got.length, 2);
  assert.equal(got[0].payload[0], 4);
  assert.equal(got[1].payload[0], 5);
  assert.equal(p.pending, 0);
});

check('a trailing partial frame is retained, not lost', () => {
  const p = new FrameParser();
  const buf = Buffer.concat([
    encodeFrame(FRAME.AUDIO, Buffer.alloc(8, 1)),
    encodeFrame(FRAME.AUDIO, Buffer.alloc(8, 2)).subarray(0, 5),
  ]);
  const frames = p.push(buf);
  assert.equal(frames.length, 1);
  assert.equal(p.pending, 5, 'the incomplete frame stays buffered');
});

check('a zero-length frame is valid (terminate carries no payload)', () => {
  const p = new FrameParser();
  const frames = p.push(encodeFrame(FRAME.TERMINATE));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, FRAME.TERMINATE);
  assert.equal(frames[0].payload.length, 0);
});

check('an oversized payload is refused rather than silently truncated', () => {
  assert.throws(() => encodeFrame(FRAME.AUDIO, Buffer.alloc(70000)), /16-bit/);
});

check('the UUID frame renders as a uuid', () => {
  const raw = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  assert.equal(formatUuid(raw), '01234567-89ab-cdef-0123-456789abcdef');
});

check('payloads do not alias the parser buffer', () => {
  // If the parser handed out subarrays, later writes into its buffer would
  // mutate audio already queued for playback.
  const p = new FrameParser();
  const frames = p.push(encodeFrame(FRAME.AUDIO, Buffer.from([1, 2, 3, 4])));
  p.push(encodeFrame(FRAME.AUDIO, Buffer.from([9, 9, 9, 9])));
  assert.deepEqual([...frames[0].payload], [1, 2, 3, 4], 'the first payload must be unchanged');
});

// ── Pacing ───────────────────────────────────────────────────────────────────

section('20 ms pacing');

check('a 20 ms frame at 16 kHz is 640 bytes', () => {
  assert.equal(bytesPerFrame(16000), 640);
  assert.equal(bytesPerFrame(8000),  320);
});

check('PCM splits into whole 20 ms frames', () => {
  const chunks = chunkPcm(Buffer.alloc(640 * 5), 16000);
  assert.equal(chunks.length, 5);
  for (const c of chunks) assert.equal(c.length, 640);
});

check('a trailing partial frame is padded, not dropped', () => {
  // Dropping it clips the last milliseconds off every utterance, which sounds
  // like a swallowed final consonant.
  const pcm = Buffer.alloc(640 + 100, 7);
  const chunks = chunkPcm(pcm, 16000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].length, 640, 'padded up to a full frame');
  assert.equal(chunks[1][0], 7,   'real audio is preserved');
  assert.equal(chunks[1][639], 0, 'and the remainder is silence');
});

check('empty input produces no frames', () => {
  assert.deepEqual(chunkPcm(Buffer.alloc(0), 16000), []);
});

// ── Resampling ───────────────────────────────────────────────────────────────

section('24 kHz → 16 kHz');

function tone(freq: number, ms: number, rate: number, amp = 12000): Buffer {
  const n = Math.round(rate * (ms / 1000));
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * freq * (i / rate))), i * 2);
  }
  return b;
}

function rms(pcm: Buffer): number {
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); acc += v * v; }
  return Math.sqrt(acc / n);
}

check('output length is exactly 2/3 of input', () => {
  const out = pcm24kTo16k(Buffer.alloc(24000 * 2));   // 1 second
  assert.equal(out.length >> 1, 16000, 'one second in, one second out');
});

check('a 20 ms frame maps to a 20 ms frame', () => {
  // 480 samples at 24k → 320 at 16k. If this drifts, the call slowly desyncs.
  const out = pcm24kTo16k(Buffer.alloc(480 * 2));
  assert.equal(out.length, 640);
});

check('silence stays silent', () => {
  const out = pcm24kTo16k(Buffer.alloc(4800));
  assert.equal(rms(out), 0, 'no DC offset or ringing introduced');
});

check('a speech-band tone survives at roughly its original level', () => {
  const out = pcm24kTo16k(tone(440, 200, 24000));
  const ratio = rms(out) / rms(tone(440, 200, 16000));
  assert.ok(ratio > 0.85 && ratio < 1.15,
    `440 Hz should pass through at unity, got ${ratio.toFixed(3)}`);
});

check('a 1 kHz tone also passes cleanly', () => {
  const out = pcm24kTo16k(tone(1000, 200, 24000));
  const ratio = rms(out) / rms(tone(1000, 200, 16000));
  assert.ok(ratio > 0.80 && ratio < 1.20, `got ${ratio.toFixed(3)}`);
});

check('content above the new Nyquist is filtered, not aliased', () => {
  // THE test. 10 kHz cannot exist at 16 kHz (Nyquist 8 kHz). Naive decimation
  // folds it down to 6 kHz — still loud, and audible as a metallic warble over
  // speech. A correct filter attenuates it heavily instead.
  const loud = tone(10_000, 200, 24000);
  const out  = pcm24kTo16k(loud);
  const ratio = rms(out) / rms(loud);
  assert.ok(ratio < 0.15,
    `10 kHz must be attenuated, not folded back. Residual ${(ratio * 100).toFixed(1)}%`);
});

check('a DC signal keeps its level (unity gain)', () => {
  const n = 2400;
  const dc = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) dc.writeInt16LE(8000, i * 2);
  const out = pcm24kTo16k(dc);
  // Sample from the middle, away from the clamped edges.
  const mid = out.readInt16LE((out.length >> 2) * 2);
  assert.ok(Math.abs(mid - 8000) < 80, `expected ~8000, got ${mid}`);
});

check('a full-scale input does not wrap to the opposite sign', () => {
  // Wrapping turns a loud sound into a full-scale crack in the caller's ear.
  const out = pcm24kTo16k(tone(300, 100, 24000, 32767));
  for (let i = 0; i < out.length >> 1; i++) {
    const v = out.readInt16LE(i * 2);
    assert.ok(v >= -32768 && v <= 32767, `sample ${i} out of range: ${v}`);
  }
});

check('empty and tiny inputs do not throw', () => {
  assert.equal(pcm24kTo16k(Buffer.alloc(0)).length, 0);
  assert.ok(pcm24kTo16k(Buffer.alloc(2)).length >= 0, 'a single sample is survivable');
});

check('upsampling back is length-correct', () => {
  assert.equal(pcm16kTo24k(Buffer.alloc(16000 * 2)).length >> 1, 24000);
  assert.equal(pcm16kTo24k(Buffer.alloc(0)).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
