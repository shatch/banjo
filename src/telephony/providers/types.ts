import type { AudioChunk } from '../../voice/types.js';

export interface TelephonyCallMeta {
  callId: string; // our internal CallAttempt id
  providerCallId: string; // Twilio Call SID
  toNumber: string;
}

// Every variant carries `callId` via this intersection (rather than repeating
// the field on each arm) so a future variant can't accidentally omit it.
// TwilioProvider is a process-wide singleton (telephony/factory.ts)
// broadcasting to every registered listener — with two calls potentially
// live at once (an outbound negotiation, an inbound caller), CallSession
// needs a reliable way to ignore events that aren't its own rather than
// reacting to another session's audio/hangup/AMD signal.
export type TelephonyEvent = { callId: string } & (
  | { type: 'connected'; meta: TelephonyCallMeta }
  | { type: 'audio_chunk'; chunk: AudioChunk }
  // Matches exactly what Twilio's AnsweredBy callback param can send when a
  // call is originated with MachineDetection=Enable (the mode this repo
  // requests — see TwilioProvider.originateCall). 'machine_end_beep'/
  // '_silence'/'_other' are DetectMessageEnd-only values and were dropped
  // from this union for that reason; 'fax' was added since Enable mode can
  // return it and the union previously didn't account for it. Confirmed
  // against Twilio's Answering Machine Detection docs 2026-08.
  | { type: 'answering_machine_detected'; answeredBy: 'human' | 'machine_start' | 'fax' | 'unknown' }
  | { type: 'ended'; reason: string }
  | { type: 'error'; error: Error }
);

export type TelephonyEventListener = (event: TelephonyEvent) => void;

/**
 * Outbound call origination + media I/O, kept as its own interface (rather
 * than folded directly into TwilioProvider) so CallSession and its tests can
 * depend on a vendor-neutral contract for the audio-in/audio-out and
 * control-action surface — the same seam src/voice/'s VoiceAIProvider uses
 * for its own (currently multi-vendor) abstraction. Twilio is the only
 * implementation today; a LiveKit adapter was scaffolded early on but never
 * got past non-functional audio I/O placeholders and was removed.
 */
export interface TelephonyProvider {
  readonly name: string;
  readonly nativeAudioFormat: 'g711_ulaw_8k';

  originateCall(opts: {
    to: string;
    callId: string;
    answeringMachineDetection?: boolean;
  }): Promise<{ providerCallId: string }>;

  sendAudio(callId: string, chunk: AudioChunk): void;

  /** DTMF tones — a telephony-layer action (e.g. for navigating an IVR menu), not a voice-AI concern. */
  sendDigits(callId: string, digits: string): Promise<void>;

  /** Flush/clear the provider's outbound audio buffer — used on caller barge-in. */
  interrupt(callId: string): void;

  hangUp(callId: string): Promise<void>;

  on(event: 'event', listener: TelephonyEventListener): void;
  off(event: 'event', listener: TelephonyEventListener): void;
}
