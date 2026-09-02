import type { CalendarProvider } from '../calendar/types.js';
import type { TelephonyProvider } from '../telephony/providers/types.js';
import type { CallAttempt, Task } from '../tasks/schema.js';

/**
 * Passed to every live-call tool handler (src/voice/tools/callTools.ts,
 * src/telephony/dtmf.ts's press_digits). Gives a tool everything it needs to
 * act — the task/call-attempt it's running under, and direct access to the
 * telephony leg (for press_digits/hangUp) and calendar (for availability
 * checks/booking) — without reaching back into global state.
 */
export interface CallContext {
  task: Task;
  callAttempt: CallAttempt;
  /**
   * OUR internal call id (== callAttempt.id) — the identifier every
   * TelephonyProvider method (hangUp/sendDigits/interrupt/sendAudio) keys
   * its per-call state by. This field used to be named/populated as
   * `providerCallId` and held the *vendor's* own call identifier (Twilio's
   * CallSid) instead — every tool that called `ctx.telephony.hangUp(...)`/
   * `sendDigits(...)` was silently failing (TwilioProvider's internal Map
   * is keyed by our id, not Twilio's, so lookups came back empty) until a
   * live call caught it: escalate_and_end_call ran, logged "hangUp called
   * with no known providerCallId", and never actually told Twilio to end
   * the call. The vendor's own id, if a handler ever needs it for logging,
   * is on `callAttempt.providerCallId` (persisted separately, once known).
   */
  callId: string;
  telephony: TelephonyProvider;
  calendar: CalendarProvider;
  /** audioPlaybackTracker.estimatedDoneAt() (session/audioPlaybackTracker.ts) at the moment this context was built — the estimated wall-clock time by which every audio chunk sent so far will have finished playing on the phone leg. Used by hangUpAfterSpeaking (voice/tools/callTools.ts) to wait for trailing speech to finish before hanging up. */
  estimatedAudioDoneAt: number;
}
