/**
 * Why a call that ended on its own, before any outcome tool ran, is recorded
 * as failed (#251). The reason used to be the raw event that ended it, most
 * often Twilio's Media Stream 'stop'. That reached the owner and the agent as
 * is, and an agent could only report "the reason given was stop". It now says
 * in plain words that the line ended early, and how far the call had got.
 *
 * Reasons that are already sentences (a call that never connected, from
 * Twilio's status callback) are kept as they are.
 */
import type { DisclosureResult } from '../session/disclosure.js';

/** The telephony side ended: Twilio's Media Stream 'stop', or its socket closing first. */
const LINE_ENDED = new Set(['stop', 'socket_closed']);

/** A raw event name or close code rather than a sentence: no spaces, or the voice AI's "ws closed (code N)". */
function isRawCode(reason: string): boolean {
  return !/\s/.test(reason.trim()) || /^ws closed\b/i.test(reason);
}

export function endedEarlyReason(reason: string, disclosure: DisclosureResult, theirReplies?: number): string {
  if (!isRawCode(reason)) return reason;
  const what = LINE_ENDED.has(reason)
    ? 'The line ended before Banjo finished the call: the other party hung up, or the connection dropped.'
    : 'The connection to the voice AI closed before Banjo finished the call.';
  const howFar =
    disclosure === 'no_speech'
      ? ' Banjo never spoke, so nothing was said to them.'
      : theirReplies === undefined
        ? ''
        : theirReplies === 0
          ? ' Banjo spoke, but they said nothing after its first line.'
          : ` They had replied ${theirReplies} time${theirReplies === 1 ? '' : 's'}, but nothing was confirmed before the line ended.`;
  return `${what}${howFar} (Line event: ${reason}.)`;
}
