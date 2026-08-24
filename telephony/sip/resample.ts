// Sample-rate conversion for the phone bridge.
//
// Only ONE conversion is needed, and that is the whole point of the Asterisk
// `slin16` design: Asterisk transcodes the trunk's G.711 to 16 kHz linear for
// us, which is exactly what Gemini Live wants as input. So the inbound path
// needs no resampling at all.
//
// The outbound path does: Gemini speaks at 24 kHz and Asterisk wants 16 kHz.
// That is a fixed 3:2 ratio — every 3 input samples become 2 output samples —
// which is far kinder than the arbitrary ratios a naive design would produce.
//
// Why not a library
// -----------------
// The usual choices are native (node-speex-resampler, needs a compiler on the
// deploy host) or WASM (libsamplerate-js, ~200 KB and an async init). For one
// fixed ratio on 20 ms buffers, a small correct filter is less risk than either,
// and it has no install story.

/**
 * Downsample 24 kHz → 16 kHz mono 16-bit PCM.
 *
 * Decimating by taking 2 of every 3 samples would alias: 24 kHz audio carries
 * content up to 12 kHz, and anything above the new 8 kHz Nyquist folds back
 * into the audible band as a metallic warble. So this low-passes first.
 *
 * The filter is a windowed-sinc applied at the resampling step itself — the
 * output sample at position t is a weighted sum of the input samples around
 * 1.5t, with the weights forming a band-limited kernel. Combining the filter
 * and the rate change into one pass is both faster and simpler to reason about
 * than filtering into a temporary buffer and then decimating it.
 */

// Half-width of the kernel in INPUT samples. 12 taps either side is comfortably
// enough for speech at this ratio; more is inaudible and costs CPU per frame.
const TAPS = 12;

// Cutoff as a fraction of the INPUT rate. The output Nyquist is 8 kHz, which is
// 1/3 of 24 kHz; backing off to 0.30 leaves a transition band so the filter can
// actually reach stopband before aliasing starts.
const CUTOFF = 0.30;

function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

// Precomputed kernels, one per output-phase. With a 3:2 ratio the fractional
// offset of an output sample repeats every 2 outputs, so there are exactly 2
// distinct kernels and they can be built once at module load rather than
// recomputed for every 20 ms frame.
const PHASES = 2;
const kernels: Float32Array[] = [];

for (let phase = 0; phase < PHASES; phase++) {
  const centre = phase * 1.5;                 // input position of this output sample
  const frac   = centre - Math.floor(centre); // 0 or 0.5
  const k      = new Float32Array(TAPS * 2 + 1);
  let sum = 0;

  for (let i = -TAPS; i <= TAPS; i++) {
    const x = i - frac;
    // Blackman window — steeper stopband than Hamming, which matters because
    // anything that leaks through folds directly into speech frequencies.
    const w = 0.42
      - 0.5  * Math.cos((2 * Math.PI * (i + TAPS)) / (TAPS * 2))
      + 0.08 * Math.cos((4 * Math.PI * (i + TAPS)) / (TAPS * 2));
    const v = 2 * CUTOFF * sinc(2 * CUTOFF * x) * w;
    k[i + TAPS] = v;
    sum += v;
  }

  // Normalise to unity DC gain, so a constant input comes out at the same level
  // rather than quietly shifted.
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  kernels.push(k);
}

/**
 * @param pcm24 little-endian signed 16-bit mono at 24 kHz
 * @returns    little-endian signed 16-bit mono at 16 kHz
 */
export function pcm24kTo16k(pcm24: Buffer): Buffer {
  const inSamples = pcm24.length >> 1;
  if (inSamples === 0) return Buffer.alloc(0);

  const outSamples = Math.floor((inSamples * 2) / 3);
  const out = Buffer.alloc(outSamples * 2);

  for (let n = 0; n < outSamples; n++) {
    const centre = (n * 3) / 2;
    const base   = Math.floor(centre);
    const k      = kernels[n % PHASES];

    let acc = 0;
    for (let i = -TAPS; i <= TAPS; i++) {
      // Clamp at the edges rather than wrapping or zero-filling. Zero-filling
      // puts a step at every buffer boundary, which is an audible tick 50 times
      // a second; clamping just softens the very first and last samples.
      let idx = base + i;
      if (idx < 0) idx = 0;
      else if (idx >= inSamples) idx = inSamples - 1;

      acc += pcm24.readInt16LE(idx * 2) * k[i + TAPS];
    }

    // Clamp, do not wrap. An overflow that wraps turns a loud sound into a
    // full-scale crack in the caller's ear.
    const v = acc < -32768 ? -32768 : acc > 32767 ? 32767 : Math.round(acc);
    out.writeInt16LE(v, n * 2);
  }

  return out;
}

/** Convenience for the reverse direction, unused today but obvious to reach for. */
export function pcm16kTo24k(pcm16: Buffer): Buffer {
  const inSamples  = pcm16.length >> 1;
  if (inSamples === 0) return Buffer.alloc(0);
  const outSamples = Math.floor((inSamples * 3) / 2);
  const out = Buffer.alloc(outSamples * 2);

  for (let n = 0; n < outSamples; n++) {
    const pos  = (n * 2) / 3;
    const i0   = Math.floor(pos);
    const frac = pos - i0;
    const i1   = Math.min(i0 + 1, inSamples - 1);

    // Linear interpolation is adequate upward: no new frequency content is
    // created above the original Nyquist, so there is nothing to alias.
    const a = pcm16.readInt16LE(i0 * 2);
    const b = pcm16.readInt16LE(i1 * 2);
    const v = Math.round(a + (b - a) * frac);
    out.writeInt16LE(v < -32768 ? -32768 : v > 32767 ? 32767 : v, n * 2);
  }
  return out;
}
