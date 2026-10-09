/**
 * Did Banjo actually say goodbye? (#102)
 *
 * The prompt and the call-ending tools' descriptions both require a spoken
 * goodbye before hanging up, and both have been ignored on live calls: the
 * demo call ended "Let me wrap this up." (#47) and a conversation call ended
 * "Okay, sounds like we're about ready to close this out together." CallSession
 * uses this to refuse a goodbye-requiring tool once, so the model says one.
 *
 * A sign-off phrase counts. "Thanks" alone counts only when the line doesn't
 * also describe ending the call, the pattern every bad ending so far has had.
 */
const SIGN_OFF =
  /\b(good-?bye|bye|take care|talk (to you )?soon|see you|good ?night|have a (great|good|nice|lovely|wonderful|fantastic) (one|day|evening|night|weekend|afternoon|morning|time)|cheers)\b/i;
const THANKS = /\b(thanks|thank you)\b/i;
const DESCRIBES_ENDING = /\b(wrap(ping)? (this |it |things )?up|close (this|it|things) out|end(ing)? (the|this) call|hang(ing)? up|finish(ing)? up|say a quick goodbye)\b/i;

export function saidGoodbye(line: string): boolean {
  if (SIGN_OFF.test(line) && !/\bsay a quick goodbye\b/i.test(line)) return true;
  return THANKS.test(line) && !DESCRIBES_ENDING.test(line);
}

/**
 * Is the other party starting to say something, rather than signing off? (#133)
 *
 * Judges what they said while Banjo was ending the call: a goodbye or a short
 * acknowledgement ("Okay, sounds good.") lets the call end; a redirect ("hold
 * on", "one more thing") or a real sentence doesn't.
 */
const REDIRECT =
  /\b(wait|hold on|hang on|actually|one more|also|before you go|let me|tell you|question|instead|but)\b/i;
const SENTENCE_WORDS = 6;

export function isCuttingIn(line: string): boolean {
  if (saidGoodbye(line)) return false;
  return REDIRECT.test(line) || line.trim().split(/\s+/).length >= SENTENCE_WORDS;
}
