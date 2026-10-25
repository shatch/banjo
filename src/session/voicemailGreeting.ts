/**
 * Does their line sound like a voicemail greeting or a carrier prompt? (#207)
 *
 * Used only to hold off the opening silence nudge: a carrier greeting can come
 * in two parts with a gap longer than the silence watchdog ("Your call has been
 * forwarded to voicemail." … "At the tone, please record your message."), and
 * a nudge in that gap made Banjo start its opener over the second part. A miss
 * only means the nudge comes as before, so this errs toward a person.
 */
const VOICEMAIL_PROMPT =
  /\b(voice ?mail|voice message system|mailbox|at the tone|after the (tone|beep)|record your message|leave (me |us )?(a |your )?(message|name and number)|(can'?t|cannot|unable to) (come to|get to|take) the phone|you'?ve reached)\b/i;
const NOT_AVAILABLE = /\b(is not|isn'?t) available\b/i;
const TRYING_TO_REACH = /\b(you('re| are) trying to reach|you have (dialed|called)|the number you)\b/i;

export function soundsLikeVoicemailGreeting(line: string): boolean {
  if (VOICEMAIL_PROMPT.test(line)) return true;
  return NOT_AVAILABLE.test(line) && TRYING_TO_REACH.test(line);
}

const FORWARDED = /\b(forwarded to|transferred to|you have reached) (voice ?mail|an automat(ed|ic) voice message system|the voice ?mail)\b/i;
const ASKS_FOR_MESSAGE = /\b(tone|beep|record|leave (me |us )?(a |your )?(message|name))\b/i;

/**
 * A carrier's "Your call has been forwarded to voicemail." before it has asked
 * for a message (#207): more always follows ("…At the tone, please record your
 * message."), so a pause after it isn't the end of the greeting.
 */
export function isCarrierPreamble(line: string): boolean {
  return FORWARDED.test(line) && !ASKS_FOR_MESSAGE.test(line);
}
