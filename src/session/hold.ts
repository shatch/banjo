/**
 * Waiting on hold (#151): what CallSession needs that isn't CallSession state.
 *
 * A hold queue repeats itself: the same "your call is important to us" every
 * thirty seconds, the same menu reminder. Each repeat would otherwise cost a
 * judgment (VoiceAIProvider.judgeHoldLine), so a line that closely matches one
 * already heard on this hold is skipped. A person picking up says something
 * new, so they are never skipped by this.
 */

/** How much of a line's wording must match an earlier one (shared words over all words) to count as a repeat. */
const REPEAT_OVERLAP = 0.8;

function words(line: string): string[] {
  return line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Whether `line` repeats something already heard on this hold, by wording rather than exact text, since transcription varies run to run. */
export function isRepeatOnHold(line: string, heard: readonly string[]): boolean {
  const these = new Set(words(line));
  if (these.size === 0) return true;
  return heard.some((earlier) => {
    const those = new Set(words(earlier));
    const shared = [...these].filter((w) => those.has(w)).length;
    const all = new Set([...these, ...those]).size;
    return all > 0 && shared / all >= REPEAT_OVERLAP;
  });
}

/**
 * The system note added to the conversation when a person picks up after a
 * hold (#151), just before their own words go in as a user line. Fixed text:
 * what they said is never part of it, so it can't carry instructions. They
 * never heard the call's opening, so Banjo opens again, disclosure first.
 */
export function personPickedUpNote(openingLine: string | undefined): string {
  const opener = openingLine
    ? `Your first sentence must be: ${JSON.stringify(openingLine)} Then say briefly why you're calling.`
    : "Greet them, say you're an AI assistant, and say briefly why you're calling.";
  return (
    'You were waiting on hold, and a live person has just picked up; their words follow. They have not heard anything ' +
    `you said before the hold. ${opener} Then carry on with the call as usual. If it turns out to be another recording ` +
    'after all, call wait_on_hold again without saying anything more.'
  );
}

/**
 * The system note added when an automated phone menu asks for input while
 * Banjo is on hold, just before the menu's own words go in as a user line.
 * Banjo once went on hold at a menu's "remain on the line" and stayed silent
 * through every question that followed until the menu hung up. No reopening:
 * a menu isn't a person, and the disclosure is for whoever picks up later.
 * Fixed text that quotes nothing, so there's no phrase for the model to echo (#154).
 */
export function menuPromptNote(): string {
  return (
    'You were waiting silently, and an automated phone menu is now asking for input; its words follow. Answer it now: ' +
    "use press_digits for the option you need, or say only the option's words. Don't add anything else: a menu that " +
    'listens for speech takes any other words as your answer. If the menu lets you simply remain on the line and that ' +
    'is the way forward, call wait_on_hold again without saying anything.'
  );
}

/**
 * The system note added when a voicemail greeting plays while Banjo is on hold
 * (#238), just before the greeting's own words go in as a user line. A phone's
 * call screen said to stay on the line, then to leave a message, and Banjo sat
 * silent through it. Fixed text that quotes nothing, like menuPromptNote.
 */
export function voicemailOnHoldNote(): string {
  return (
    'You were waiting silently, and the line has reached a voicemail greeting; its words follow. Let it finish, then ' +
    'leave your message with leave_voicemail_and_end_call, so it is delivered exactly. If a person speaks after all, ' +
    'talk with them as normal.'
  );
}

/**
 * The longest this hold may last: the call's own limit, cut short so the
 * voice session still has `reserveMs` left to talk in once a person picks up.
 * Zero or less means there isn't time to wait at all.
 */
export function holdBudgetMs(opts: {
  maxHoldMs: number;
  now: number;
  sessionStartedAt: number | undefined;
  maxSessionMs: number | undefined;
  reserveMs: number;
}): number {
  if (opts.maxSessionMs === undefined || opts.sessionStartedAt === undefined) return opts.maxHoldMs;
  const sessionLeft = opts.sessionStartedAt + opts.maxSessionMs - opts.reserveMs - opts.now;
  return Math.min(opts.maxHoldMs, sessionLeft);
}
