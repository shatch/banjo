import { config } from '../config/index.js';
import { ElevenLabsProvider } from './providers/elevenlabs.js';
import { GeminiLiveProvider } from './providers/gemini.js';
import { OpenAIRealtimeProvider } from './providers/openai.js';
import { OpenAILiveProvider } from './providers/openaiLive.js';
import type { VoiceAIProvider } from './types.js';

/**
 * Vendor-keyed registry/factory. Application code (session/callSession.ts)
 * should only ever call createVoiceAIProvider() and program against the
 * VoiceAIProvider interface — never import a provider class directly.
 */
export function createVoiceAIProvider(): VoiceAIProvider {
  switch (config.VOICE_AI_PROVIDER) {
    case 'openai':
      return new OpenAIRealtimeProvider();
    case 'openai-live':
      return new OpenAILiveProvider();
    case 'gemini':
      return new GeminiLiveProvider();
    case 'elevenlabs':
      return new ElevenLabsProvider();
    default: {
      // Defensive: VOICE_AI_PROVIDER is a Zod enum in src/config/index.ts, so
      // this should be unreachable at runtime — but guard against a future
      // enum addition that forgets to wire up a provider here.
      const exhaustiveCheck: never = config.VOICE_AI_PROVIDER;
      throw new Error(`Unrecognized VOICE_AI_PROVIDER: ${String(exhaustiveCheck)}`);
    }
  }
}
