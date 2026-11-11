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
// #167: "I just have what I need for today." and "I'll close with…" wrap up
// without signing off, the same as "let me wrap this up".
const DESCRIBES_ENDING =
  /\b(wrap(ping)? (this |it |things )?up|close (this|it|things) out|close (with|on)|end(ing)? (the|this) call|hang(ing)? up|finish(ing)? (this |it |things )?up|say a quick goodbye|(have|got|had) (what|all|everything) (i|we) need(ed)?|that'?s all (i|we) need(ed)?)\b/i;
// "Goodbye" talked about rather than said (#139: "I'll just finish this up
// with a proper goodbye." ended a call with no goodbye). Removed before the
// sign-off check, so "I'll say goodbye now. Bye!" still counts.
const MENTIONS_GOODBYE = /\b(say(ing)?|with|a|the|my|our|proper|quick|real|final) good-?bye\b/gi;
// Non-global copy for .test(): a /g regex keeps lastIndex between calls.
const TALKS_ABOUT_GOODBYE = new RegExp(MENTIONS_GOODBYE.source, 'i');

export function saidGoodbye(line: string): boolean {
  if (SIGN_OFF.test(line.replace(MENTIONS_GOODBYE, ''))) return true;
  // A line that talks about a goodbye without saying one describes the ending
  // (#167: "Okay, thanks for that—I'll close with a quick goodbye now."), so
  // its "thanks" doesn't count as a sign-off either.
  return THANKS.test(line) && !DESCRIBES_ENDING.test(line) && !TALKS_ABOUT_GOODBYE.test(line);
}

/**
 * Does the line describe ending the call, rather than just ending it? (#154)
 *
 * "Got it, I'll wrap this up warmly." and "let me just wrap this up with a
 * polite sign-off" were heard on live calls before the #139 fixed goodbye.
 * Narrower than DESCRIBES_ENDING: "That's all I need, thanks — bye!" is a
 * real goodbye, not a narration. A line that also says goodbye still counts:
 * the narration was heard either way.
 */
const NARRATES_ENDING =
  /\b(wrap(ping)? (this |it |things |us )?up|close (this|it|things) out|(i'?ll|let me|let'?s) close (with|on)|end(ing)? (the|this) call|hang(ing)? up|finish(ing)? (this |it |things )?up|sign-?off)\b/i;

export function narratesEnding(line: string): boolean {
  return narrationStart(line) >= 0;
}

/** Where the narration in a line starts, or -1 if there is none. What comes before it is what was meant to be heard. */
export function narrationStart(line: string): number {
  const at = [NARRATES_ENDING.exec(line)?.index, TALKS_ABOUT_GOODBYE.exec(line)?.index].filter((i): i is number => i !== undefined);
  return at.length ? Math.min(...at) : -1;
}

/**
 * Does the other party say they have to go? (#154, #179) A live callee said
 * she had to go because she was watching a show, and Banjo answered "let's
 * wrap this up quickly so you can get back to your show." Not a done signal
 * (isSigningOff), since the call may have been mid-topic, but the call is
 * ending all the same.
 */
const LEAVING =
  /\b((have|got|need) to|gotta|should) (go|run|get going|head out|hop off)\b|\bget(ting)? back to\b|\b(i'?m|we'?re) (busy|in the middle of)\b/i;

export function isLeaving(line: string): boolean {
  return LEAVING.test(line);
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

/**
 * Has the other party signed off? (#144)
 *
 * Judges their latest line when Banjo ends the call with no goodbye. After a
 * done signal ("That's all.", "I think we're good.") the refusal above only
 * gets a second narrated line ("Okay, quick goodbye and then we'll be done.")
 * on live calls, so CallSession says its own goodbye straight away instead. A
 * question or a redirect isn't a sign-off: there the refusal still lets the
 * call carry on (#133). A bare "Okay" or "Mhm" isn't either, since it may only
 * answer something Banjo said.
 */
const DONE =
  /\b(that'?s (all|it|everything)|(we'?re|i'?m) (good|all set|done|finished)|all set|nothing else)\b/i;

export function isSigningOff(line: string): boolean {
  if (line.includes('?') || REDIRECT.test(line)) return false;
  return DONE.test(line) || saidGoodbye(line);
}
