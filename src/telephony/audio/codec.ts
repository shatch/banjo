/**
 * G.711 µ-law <-> PCM16LE codec, plus a naive PCM16 resampler.
 *
 * Pure functions, no I/O — these exist so the telephony providers (which
 * speak 8kHz µ-law on the wire) and the voice/ layer (which speaks the
 * canonical PCM16LE format defined in src/voice/types.ts) can convert
 * between the two without either side knowing about the other's format.
 */

// Standard ITU-T G.711 µ-law constants.
const MULAW_BIAS = 0x84; // 132 — added to the magnitude before segmenting
const MULAW_CLIP = 32635; // max 16-bit magnitude before clipping, avoids overflow in the biased value

/**
 * Decode a single µ-law byte to a 16-bit signed linear PCM sample.
 *
 * µ-law bytes are transmitted bit-inverted (1's complement) on the wire, so
 * the first step un-inverts before pulling out sign/exponent/mantissa. This
 * is the classic segment-based G.711 decode (as published in, e.g., the
 * Sun/CCITT reference implementation and re-derived countless times since).
 */
function muLawByteToPcm16Sample(muLawByte: number): number {
  const inverted = ~muLawByte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;

  let magnitude = ((mantissa << 3) + MULAW_BIAS) << exponent;
  magnitude -= MULAW_BIAS;

  return sign ? -magnitude : magnitude;
}

/**
 * Encode a single 16-bit signed linear PCM sample to a µ-law byte.
 *
 * Mirrors muLawByteToPcm16Sample(): bias the magnitude, find which of the 8
 * exponential "segments" it falls in (via a leading-bit scan rather than a
 * lookup table — simpler to read, and this isn't a hot enough path in a v1
 * scaffold to need a table), pull the 4-bit mantissa from within that
 * segment, then re-invert for the wire.
 */
function pcm16SampleToMuLawByte(pcmSample: number): number {
  const sign = pcmSample < 0 ? 0x80 : 0x00;
  let magnitude = Math.abs(pcmSample);
  if (magnitude > MULAW_CLIP) magnitude = MULAW_CLIP;
  magnitude += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }

  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode a buffer of G.711 µ-law bytes to canonical PCM16LE. */
export function muLawToPcm16(input: Buffer): Buffer {
  const out = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    out.writeInt16LE(muLawByteToPcm16Sample(input[i] as number), i * 2);
  }
  return out;
}

/** Encode a buffer of PCM16LE samples to G.711 µ-law bytes. */
export function pcm16ToMuLaw(input: Buffer): Buffer {
  const sampleCount = Math.floor(input.length / 2);
  const out = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = pcm16SampleToMuLawByte(input.readInt16LE(i * 2));
  }
  return out;
}

/**
 * Naive linear-interpolation resampler over 16-bit PCM LE samples (mono).
 *
 * CORRECTNESS-ONLY for this v1 scaffold, not production audio quality:
 * linear interpolation has no anti-aliasing, so upsampling is fine but
 * downsampling can introduce audible artifacts on content with significant
 * high-frequency energy. A proper resampling library (e.g. libsamplerate
 * bindings, or a windowed-sinc implementation) is a flagged future upgrade,
 * not a blocker for getting the pipeline working end-to-end.
 */
export function resamplePcm16(input: Buffer, opts: { fromRate: number; toRate: number }): Buffer {
  const { fromRate, toRate } = opts;
  if (fromRate === toRate) return Buffer.from(input);

  const inSampleCount = Math.floor(input.length / 2);
  if (inSampleCount === 0) return Buffer.alloc(0);
  if (inSampleCount === 1) {
    // Nothing to interpolate between — just repeat the single sample.
    const single = input.readInt16LE(0);
    const outSampleCount = Math.max(1, Math.round(inSampleCount * (toRate / fromRate)));
    const out = Buffer.alloc(outSampleCount * 2);
    for (let i = 0; i < outSampleCount; i++) out.writeInt16LE(single, i * 2);
    return out;
  }

  const outSampleCount = Math.max(1, Math.round(inSampleCount * (toRate / fromRate)));
  const out = Buffer.alloc(outSampleCount * 2);

  // Map each output sample index back to a fractional position in the input
  // and linearly interpolate between its two nearest neighbors.
  const step = (inSampleCount - 1) / Math.max(1, outSampleCount - 1);
  for (let i = 0; i < outSampleCount; i++) {
    const srcPos = i * step;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, inSampleCount - 1);
    const frac = srcPos - idx0;

    const s0 = input.readInt16LE(idx0 * 2);
    const s1 = input.readInt16LE(idx1 * 2);
    const interpolated = Math.round(s0 + (s1 - s0) * frac);

    out.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
  }

  return out;
}
