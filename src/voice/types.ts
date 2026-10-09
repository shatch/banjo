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
  /**
   * The vendor's raw arguments payload, set ONLY when the adapter could not
   * parse it (a truncated JSON string, most often). `arguments` is then empty
   * — which is otherwise indistinguishable from a deliberate no-argument call
   * — so CallSession uses this to tell the model its call was cut off and
   * should be sent again, rather than failing it as invalid input. A real
   * call once hit this: the model never retried, and went on to assert an
   * availability answer it had never actually checked.
   */
  unparsedArguments?: string;
  /** Kept for debugging/logging only — never branch on this outside the adapter. */
  rawVendorEvent?: unknown;
}

export type VoiceAIAudioFormat = 'pcm16_8k' | 'pcm16_16k' | 'pcm16_24k' | 'g711_ulaw_8k';

export interface VoiceAISessionConfig {
  instructions: string;
  /**
   * Optional voice-layer-only prompt, for a provider that splits its voice
   * front-end from a separate reasoning/tool-calling backend (openai-live).
   * Such a provider gives this to the voice layer and `instructions` to the
   * backend; every other provider ignores it and uses `instructions` alone.
   */
  frontendInstructions?: string;
  tools: ToolDefinition[];
  voice?: string;
  languageHint?: string;
  inputAudioFormat: VoiceAIAudioFormat;
  outputAudioFormat: VoiceAIAudioFormat;
}

/** What was actually spoken for a sayVerbatim() request, against what was intended — from VoiceAIProvider.verbatimDeliveryReport, or built by CallSession from the transcript. */
export interface VerbatimDeliveryReport {
  intended: string;
  /** Transcript of the model's own speech from the sayVerbatim() call until the report was taken. */
  spoken: string;
  matched: boolean;
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
  | {
      type: 'transcript';
      role: 'user' | 'assistant';
      text: string;
      isFinal: boolean;
      /** Final user transcript only: the model already started replying before this transcript went final (a full-duplex provider can), so there is no reply left to wait for. */
      answered?: boolean;
    }
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
  /**
   * `respond: false` leaves the model waiting for the other party instead of prompting it to speak now (#133: a
   * callee who cut in while Banjo was ending the call). Honoured by `openai` only. `openai-live` must continue the
   * backend response that is waiting on the result, and Gemini and ElevenLabs don't prompt a response here anyway.
   */
  sendToolResult(toolCallId: string, result: unknown, isError?: boolean, options?: { respond?: boolean }): void;
  /** Tell the model to stop speaking (barge-in). */
  interrupt(): void;
  /**
   * Prompt the model to start speaking now, with no caller input needed — used for an inbound call's opening greeting
   * and the silence watchdog's nudge. `cue`, if given, is a one-time instruction for this response only (CallSession
   * uses it so a nudge before Banjo's first words says the disclosure, #118). Unlike sayVerbatim() there's no delivery
   * tracking. A provider with no way to send it ignores it.
   */
  triggerResponse(cue?: string): void;
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
  /**
   * Optional; false for a provider that never emits 'interrupted' on a
   * barge-in (openai-live — full duplex, no interruption event). CallSession
   * then treats the callee's words during a verbatim delivery as the sign
   * they answered (#71). Absent means it does emit them.
   */
  readonly emitsInterruptions?: boolean;
  sayVerbatim(text: string): void;
  /**
   * Optional. A provider that cannot guarantee verbatim delivery (openai-live
   * has no verbatim-playback mechanism at all) reports what was actually
   * spoken for the most recent sayVerbatim() call. CallSession reads it once
   * the forced speech finishes and hands it to the tool handler, so the
   * recorded outcome reflects what the callee heard. Undefined if
   * sayVerbatim() was never called. For providers without this method,
   * CallSession checks the provider's own final transcript instead (#71).
   */
  verbatimDeliveryReport?(): VerbatimDeliveryReport | undefined;
  disconnect(): Promise<void>;
  on(event: 'event', listener: VoiceAIEventListener): void;
  off(event: 'event', listener: VoiceAIEventListener): void;
}
