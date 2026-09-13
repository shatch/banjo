import { muLawToPcm16, pcm16ToMuLaw, resamplePcm16 } from '../telephony/audio/codec.js';
import type { AudioChunk, VoiceAIAudioFormat } from '../voice/types.js';

export interface AudioPipeline {
  /** Telephony's native format (always g711_ulaw_8k in this codebase) -> the negotiated Voice AI format. */
  inbound: (chunk: AudioChunk) => AudioChunk;
  /** Voice AI's output format -> telephony's native format. */
  outbound: (chunk: AudioChunk) => AudioChunk;
}

const RATE_BY_FORMAT: Record<VoiceAIAudioFormat, number> = {
  pcm16_8k: 8000,
  pcm16_16k: 16000,
  pcm16_24k: 24000,
  g711_ulaw_8k: 8000,
};

/**
 * Picks which audio formats to request from the Voice AI provider for a
 * given vendor. OpenAI (both `openai` and `openai-live`) and ElevenLabs
 * support G.711 mu-law directly, so when paired with Twilio (also native
 * mu-law) we request that and skip resampling entirely — a real latency/CPU
 * win. `openai-live` additionally requires input and output to be the SAME
 * format (one shared session.audio.format), which mu-law both ways satisfies;
 * its adapter throws if that ever stops being true. Gemini Live hard-requires
 * 16kHz PCM16 in / 24kHz PCM16 out, so it always needs the codec layer.
 */
export function negotiateAudioFormats(providerName: string): { input: VoiceAIAudioFormat; output: VoiceAIAudioFormat } {
  if (providerName === 'gemini') {
    return { input: 'pcm16_16k', output: 'pcm16_24k' };
  }
  return { input: 'g711_ulaw_8k', output: 'g711_ulaw_8k' };
}

/**
 * Resolves the audio conversion pipeline once per call, based on the
 * negotiated Voice AI format (telephony's native format is always
 * g711_ulaw_8k in this codebase — see TelephonyProvider.nativeAudioFormat).
 */
export function resolveAudioPipeline(outputFormat: VoiceAIAudioFormat): AudioPipeline {
  if (outputFormat === 'g711_ulaw_8k') {
    return { inbound: (c) => c, outbound: (c) => c }; // pure passthrough, both legs already mu-law
  }

  const targetRate = RATE_BY_FORMAT[outputFormat];

  return {
    inbound: (chunk) => {
      const pcm = muLawToPcm16(chunk.data);
      const resampled = chunk.sampleRate === targetRate ? pcm : resamplePcm16(pcm, { fromRate: chunk.sampleRate, toRate: targetRate });
      return { data: resampled, sampleRate: targetRate };
    },
    outbound: (chunk) => {
      const resampled = chunk.sampleRate === 8000 ? chunk.data : resamplePcm16(chunk.data, { fromRate: chunk.sampleRate, toRate: 8000 });
      const muLaw = pcm16ToMuLaw(resampled);
      return { data: muLaw, sampleRate: 8000 };
    },
  };
}
