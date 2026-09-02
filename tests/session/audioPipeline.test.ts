import { describe, expect, it } from 'vitest';
import { negotiateAudioFormats, resolveAudioPipeline } from '../../src/session/audioPipeline.js';

describe('audioPipeline: negotiateAudioFormats', () => {
  it('picks mu-law passthrough for openai and elevenlabs', () => {
    expect(negotiateAudioFormats('openai')).toEqual({ input: 'g711_ulaw_8k', output: 'g711_ulaw_8k' });
    expect(negotiateAudioFormats('elevenlabs')).toEqual({ input: 'g711_ulaw_8k', output: 'g711_ulaw_8k' });
  });

  it('picks PCM16 16k/24k for gemini, which has no mu-law option', () => {
    expect(negotiateAudioFormats('gemini')).toEqual({ input: 'pcm16_16k', output: 'pcm16_24k' });
  });
});

describe('audioPipeline: resolveAudioPipeline', () => {
  it('is pure passthrough (no conversion) when the negotiated format is mu-law', () => {
    const pipeline = resolveAudioPipeline('g711_ulaw_8k');
    const chunk = { data: Buffer.from([1, 2, 3]), sampleRate: 8000 };
    expect(pipeline.inbound(chunk)).toBe(chunk); // same reference — genuinely a no-op
    expect(pipeline.outbound(chunk)).toBe(chunk);
  });

  it('converts mu-law telephony audio into PCM16 at the negotiated rate for gemini', () => {
    const pipeline = resolveAudioPipeline('pcm16_24k');
    // A single mu-law byte -> 2 bytes of PCM16 per sample; resampled 8k -> 24k triples the count.
    const chunk = { data: Buffer.from([0xff, 0x00, 0x80]), sampleRate: 8000 };
    const converted = pipeline.inbound(chunk);
    expect(converted.sampleRate).toBe(24000);
    expect(converted.data.length % 2).toBe(0);
    expect(converted.data.length).toBeGreaterThan(chunk.data.length);
  });

  it('converts PCM16 24k model audio back down to 8k mu-law for the phone leg', () => {
    const pipeline = resolveAudioPipeline('pcm16_24k');
    const pcmSamples = Buffer.alloc(240); // 120 samples @ 24kHz
    const converted = pipeline.outbound({ data: pcmSamples, sampleRate: 24000 });
    expect(converted.sampleRate).toBe(8000);
    // mu-law is 1 byte/sample; 120 samples @ 24k -> ~40 samples @ 8k
    expect(converted.data.length).toBeGreaterThan(30);
    expect(converted.data.length).toBeLessThan(50);
  });
});
