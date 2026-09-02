import type { CalendarProvider } from '../calendar/types.js';
import type { TelephonyProvider } from '../telephony/providers/types.js';

/**
 * Passed to every inbound live-call tool handler (src/inbound/tools.ts) —
 * the inbound equivalent of src/session/types.ts's CallContext. Deliberately
 * has no Task/CallAttempt — see src/inbound/schema.ts's doc comment for why
 * that state machine doesn't fit an inbound arrival.
 */
export interface InboundCallContext {
  /** Our DB row id (inboundCalls.id) — the FK target for inboundBookings, NOT what TelephonyProvider methods are keyed by. */
  inboundCallId: string;
  /** Twilio's own CallSid — what every TelephonyProvider method (hangUp/sendDigits/interrupt/sendAudio) is keyed by for an inbound call (no second id is minted; see src/inbound/schema.ts). */
  callId: string;
  /** Twilio's `From` field for this call — the ONLY source of caller identity; find_my_booking/reschedule_booking resolve off of this, never off of anything the model or caller supplies. */
  callerPhoneNumber: string;
  telephony: TelephonyProvider;
  calendar: CalendarProvider;
  /** audioPlaybackTracker.estimatedDoneAt() (session/audioPlaybackTracker.ts) at the moment this context was built — see CallContext's identical field (session/types.ts) for the full rationale. */
  estimatedAudioDoneAt: number;
}
