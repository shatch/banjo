/**
 * Vendor-agnostic Voice AI abstraction. Nothing outside src/voice/providers/*
 * should ever see a vendor-specific field/event name — every adapter
 * translates its own wire protocol into these shapes.
 */

export interface AudioChunk {
  /**
   * Raw audio bytes. NOT always PCM16 despite `VoiceAIProvider` treating
   * PCM16 as its canonical format — telephony/providers/types.ts's
   * TelephonyProvider emits AudioChunks in its *native* wire format
   * (mu-law for Twilio), and session/audioPipeline.ts's
   * resolveAudioPipeline() is what converts to/from the negotiated
   * VoiceAIProvider format, INCLUDING skipping conversion entirely when
   * both ends already agree on mu-law (the "passthrough" case). A telephony
   * provider that pre-converts before emitting breaks that contract
   * silently — this happened for real: Twilio's media handler once decoded
   * mu-law to PCM16 before emitting, which corrupted every inbound frame
   * whenever the passthrough path was active (OpenAI/ElevenLabs), because
   * CallSession forwarded PCM16 bytes to a session configured for mu-law
   * input with no error, just garbage audio.
   */
  data: Buffer;
  sampleRate: number; // e.g. 8000, 16000, 24000
  isFinal?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft-07-ish subset all three vendors accept). */
  parameters: Record<string, unknown>;
}

export interface NormalizedToolCall {
  /** Vendor's call id, or synthesized if the vendor doesn't provide one. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Kept for debugging/logging only — never branch on this outside the adapter. */
  rawVendorEvent?: unknown;
}

export type VoiceAIAudioFormat = 'pcm16_8k' | 'pcm16_16k' | 'pcm16_24k' | 'g711_ulaw_8k';

export interface VoiceAISessionConfig {
  instructions: string;
  tools: ToolDefinition[];
  voice?: string;
  languageHint?: string;
  inputAudioFormat: VoiceAIAudioFormat;
  outputAudioFormat: VoiceAIAudioFormat;
}

export class VoiceAIError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly vendorCode?: string,
  ) {
    super(message);
    this.name = 'VoiceAIError';
  }
}

export type VoiceAIEvent =
  | { type: 'connected' }
  | { type: 'audio_chunk'; chunk: AudioChunk }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; isFinal: boolean }
  | { type: 'tool_call'; call: NormalizedToolCall }
  | { type: 'turn_end' }
  | { type: 'interrupted' } // caller/callee barge-in — telephony must flush its playback buffer
  | { type: 'error'; error: VoiceAIError }
  | { type: 'disconnected'; reason: string };

export type VoiceAIEventListener = (event: VoiceAIEvent) => void;

/**
 * One implementation per vendor (OpenAI Realtime, Gemini Live, ElevenLabs
 * Conversational AI, ...). Selected at runtime via VOICE_AI_PROVIDER through
 * src/voice/factory.ts — application code never imports a provider directly.
 */
export interface VoiceAIProvider {
  readonly name: string;
  connect(config: VoiceAISessionConfig): Promise<void>;
  sendAudioChunk(chunk: AudioChunk): void;
  sendToolResult(toolCallId: string, result: unknown, isError?: boolean): void;
  /** Tell the model to stop speaking (barge-in). */
  interrupt(): void;
  /** Prompt the model to start speaking now, with no caller input needed — used for an inbound call's opening greeting. */
  triggerResponse(): void;
  /**
   * Forces the model's next turn to say `text` verbatim, as a one-off
   * per-response instruction override rather than a change to the session's
   * standing instructions. Exists so a tool whose argument IS the content
   * meant for the other party (e.g. a voicemail message) can make delivery
   * something the system enforces directly — CallSession calls this and
   * waits for the resulting turn_end BEFORE running such a tool's handler —
   * instead of trusting that an earlier, unconstrained model turn happened
   * to say the exact right words before the tool call reported it delivered.
   */
  sayVerbatim(text: string): void;
  disconnect(): Promise<void>;
  on(event: 'event', listener: VoiceAIEventListener): void;
  off(event: 'event', listener: VoiceAIEventListener): void;
}
