import type { AnswerVerdict } from '../voice/types.js';

/**
 * Who answered (#187). Twilio's answering-machine detection was turned off
 * (#32: it read business greetings as machines), so the model decides
 * voicemail or person just by listening, and has gone wrong both ways
 * (Open Risks #22). CallSession now judges the other party's first line out
 * of band (VoiceAIProvider.judgeFirstLine) and, on a voicemail or a phone
 * system, records it. Only a voicemail gets a note in the conversation: an
 * ivr note was tried and made Banjo press the Spanish option on a menu that
 * offered it (2026-10-25 evals, menu-on-hold 0/3), so a phone system is only
 * recorded. A note only steers: nothing is refused, and nothing hangs up on
 * a verdict. A person speaking still wins, which the note says.
 */

/** At most this many lines are judged per call: a second only when the first was unclear. */
export const ANSWER_CHECK_MAX_LINES = 2;

const NOTES: Partial<Record<AnswerVerdict, string>> = {
  voicemail:
    '(Note: what you just heard sounds like a voicemail greeting, not a person. Let it finish, then leave your ' +
    'message with leave_voicemail_and_end_call, so it is delivered exactly. If a person speaks after all, talk with ' +
    'them as normal.)',
};

/** The note for a verdict, or undefined when it needs none (a person, or unclear). */
export function answerNote(verdict: AnswerVerdict): string | undefined {
  return NOTES[verdict];
}
