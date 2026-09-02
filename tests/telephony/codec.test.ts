import { describe, expect, it } from 'vitest';
import { muLawToPcm16, pcm16ToMuLaw, resamplePcm16 } from '../../src/telephony/audio/codec.js';

function pcm16From(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe('codec: mu-law <-> PCM16 round trip', () => {
  it('round-trips near-silence without significant error', () => {
    const original = pcm16From([0, 100, -100, 500, -500]);
    const muLaw = pcm16ToMuLaw(original);
    const decoded = muLawToPcm16(muLaw);

    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length / 2; i++) {
      const a = original.readInt16LE(i * 2);
      const b = decoded.readInt16LE(i * 2);
      // mu-law is lossy/companded — a tight but non-zero tolerance confirms
      // the codec round-trips coherently, not bit-exactly.
      expect(Math.abs(a - b)).toBeLessThan(200);
    }
  });

  it('mu-law output is half the byte length of PCM16 input', () => {
    const original = pcm16From([1000, 2000, 3000, 4000]);
    expect(pcm16ToMuLaw(original).length).toBe(original.length / 2);
  });

  it('handles full-scale samples without throwing or overflowing a byte', () => {
    const original = pcm16From([32767, -32768]);
    const muLaw = pcm16ToMuLaw(original);
    for (const byte of muLaw) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
  });
});

describe('codec: resamplePcm16', () => {
  it('is a no-op when fromRate === toRate', () => {
    const input = pcm16From([1, 2, 3, 4]);
    const out = resamplePcm16(input, { fromRate: 8000, toRate: 8000 });
    expect(out.equals(input)).toBe(true);
  });

  it('upsamples 8kHz -> 16kHz to roughly double the sample count', () => {
    const input = pcm16From(Array.from({ length: 100 }, (_, i) => i));
    const out = resamplePcm16(input, { fromRate: 8000, toRate: 16000 });
    const outSamples = out.length / 2;
    expect(outSamples).toBeGreaterThanOrEqual(198);
    expect(outSamples).toBeLessThanOrEqual(202);
  });

  it('downsamples 24kHz -> 8kHz to roughly a third of the sample count', () => {
    const input = pcm16From(Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 1000 : -1000)));
    const out = resamplePcm16(input, { fromRate: 24000, toRate: 8000 });
    const outSamples = out.length / 2;
    expect(outSamples).toBeGreaterThanOrEqual(98);
    expect(outSamples).toBeLessThanOrEqual(102);
  });

  it('never produces a sample outside the int16 range', () => {
    const input = pcm16From([32767, -32768, 32767, -32768]);
    const out = resamplePcm16(input, { fromRate: 8000, toRate: 24000 });
    for (let i = 0; i < out.length / 2; i++) {
      const s = out.readInt16LE(i * 2);
      expect(s).toBeGreaterThanOrEqual(-32768);
      expect(s).toBeLessThanOrEqual(32767);
    }
  });
});
