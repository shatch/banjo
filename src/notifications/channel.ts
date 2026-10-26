import { config } from '../config/index.js';
import { formatSpokenInZone } from '../lib/timezone.js';
import type { DisclosureResult } from '../session/disclosure.js';
import type { Contact } from '../contacts/schema.js';
import type { TaskAnswer, TaskOutcome } from '../tasks/schema.js';
import { clipText, PUSHOVER_MAX_MESSAGE_CHARS, SMS_MAX_CHARS } from './limits.js';

export interface NotificationChannel {
  notify(taskId: string, outcome: TaskOutcome, summary: string): Promise<void>;
}

const DISCLOSURE_NOTE = " Note: Banjo didn't say it was an AI at the start of this call.";

/**
 * The most an owner summary may hold so that it arrives whole on any
 * NOTIFICATION_CHANNEL with the disclosure note added. The summary is built
 * once, before the channel is known (src/tasks/callSessionAdapter.ts), so
 * it fits the smallest channel, Pushover.
 */
export const OWNER_SUMMARY_MAX_CHARS = Math.min(PUSHOVER_MAX_MESSAGE_CHARS, SMS_MAX_CHARS) - DISCLOSURE_NOTE.length;

/** How many of an ask call's questions got an answer, out of how many. */
export function answerCounts(outcome: Extract<TaskOutcome, { kind: 'answered' }>): { answered: number; total: number } {
  return { answered: outcome.answers.filter((a) => a.answered).length, total: outcome.answers.length };
}

/**
 * Whether an outcome needs the owner: a call that got stuck, or an ask call
 * that came back with no answers at all. Not 'failed': that's mostly a busy
 * line or no answer, which the owner can pick up in the morning.
 */
export function needsAttention(outcome: TaskOutcome): boolean {
  switch (outcome.kind) {
    case 'negotiation_failed':
    case 'escalated':
      return true;
    case 'answered':
      return answerCounts(outcome).answered === 0;
    default:
      return false;
  }
}

/**
 * For an ask call that ended some other way (escalated, transferred, a
 * voicemail, a hold limit): the answers record_answer saved before it did,
 * after that outcome's own summary (#148 review). Fitted to what's left of
 * `maxChars`; with too little room, only the count.
 */
export function withSavedAnswers(summary: string, contact: Contact, saved: TaskAnswer[], maxChars = OWNER_SUMMARY_MAX_CHARS): string {
  const answered = saved.filter((a) => a.answered).length;
  if (answered === 0) return summary;
  const room = maxChars - summary.length - '\n\n'.length;
  const header = `Answers saved before that (${answered} of ${saved.length}):`;
  const outcome = { kind: 'answered' as const, answers: saved };
  // buildAskSummary opens with its own count line, which the header replaces;
  // fitted so the section is `room` long at most once that swap is made.
  const ownHeader = askHeader(contact.displayName, answerCounts(outcome));
  const lines = buildAskSummary(contact.displayName, outcome, room - header.length + ownHeader.length).split('\n').slice(1);
  const section = [header, ...lines].join('\n');
  if (lines.length > 0 && section.length <= room) return `${summary}\n\n${section}`;
  const countOnly = `${answered} of ${saved.length} answers were saved first: get_task_status has them.`;
  return countOnly.length <= room ? `${summary}\n\n${countOnly}` : summary;
}

/**
 * `summary` plus what the other party asked to have passed on (#160), as
 * note_follow_up saved it: the owner's to act on. Fitted to `maxChars`,
 * falling back to a count when the list won't fit.
 */
export function withFollowUps(summary: string, followUps: string[] | null | undefined, maxChars = OWNER_SUMMARY_MAX_CHARS): string {
  if (!followUps?.length) return summary;
  const room = maxChars - summary.length - '\n\n'.length;
  const section = ['They asked you to follow up on:', ...followUps.map((r) => `- ${r}`)].join('\n');
  if (section.length <= room) return `${summary}\n\n${section}`;
  const n = followUps.length;
  const countOnly = `They asked you to follow up on ${n} thing${n === 1 ? '' : 's'}: get_task_status has them.`;
  return countOnly.length <= room ? `${summary}\n\n${countOnly}` : summary;
}

/**
 * Builds Steve's outcome summary for a terminal phone-path task. The
 * online-booking path (handled by the schedule-appointment skill) relays its
 * outcome directly in the conversation instead — this is only used for
 * calls, which run asynchronously with no one watching. Only an ask call's
 * summary is fitted to `maxChars`: it's the one that can run to several
 * hundred characters of questions and answers.
 */
export function buildOutcomeSummary(contact: Contact, outcome: TaskOutcome, maxChars = OWNER_SUMMARY_MAX_CHARS): string {
  switch (outcome.kind) {
    case 'confirmed': {
      // CALENDAR_TIMEZONE, not the server's: a real 4pm booking was texted as
      // "8:00:00 PM" because the container runs in UTC and this used
      // toLocaleString().
      const when = formatSpokenInZone(outcome.start, config.CALENDAR_TIMEZONE);
      return `Booked with ${contact.displayName}: ${when.day} at ${when.time} (${outcome.durationMinutes} min).${outcome.details ? ` ${outcome.details}` : ''}`;
    }
    case 'voicemail_left':
      return `Left a voicemail at ${contact.displayName}: "${outcome.message}". Will need a follow-up if they don't call back.`;
    case 'negotiation_failed':
      return `Couldn't book with ${contact.displayName} — ${outcome.reason}. Needs your attention.`;
    case 'escalated':
      return `Got stuck calling ${contact.displayName} — ${outcome.reason}. Needs your attention.`;
    case 'failed':
      return `Couldn't complete the call to ${contact.displayName} — ${outcome.reason}.`;
    case 'conversation_completed':
      return `Called ${contact.displayName}: ${outcome.summary}`;
    case 'transferred':
      return `Transferred ${contact.displayName} to you — ${outcome.reason}.`;
    case 'answered':
      return buildAskSummary(contact.displayName, outcome, maxChars);
  }
}

const SHORTENED_NOTE = '(Shortened. Full answers: get_task_status.)';
/** A clipped free-text summary is kept to this, so the answers get the room. */
const SUMMARY_KEEP_CHARS = 200;
/** Below this many characters per question, the summary gives up its room. */
const MIN_ITEM_CHARS_WITH_SUMMARY = 80;

/**
 * An ask call's summary: a first line saying how many questions were
 * answered, then every question under its own number with its answer or
 * "(no answer)", then the model's free-text summary.
 *
 * Up to five 300-character questions, plus answers and a summary of any
 * length, can pass Pushover's 1024 characters (which would drop the last
 * answers) or Twilio's 1600 (which rejects the text, so nothing arrives).
 * When the whole thing doesn't fit `maxChars`, each question-and-answer is
 * clipped to the same budget, as large as fits, and the summary is clipped;
 * if that leaves too little room for the answers, the summary goes. Every
 * question keeps its number and its answered-or-not, so an answer can't end
 * up under the wrong question, and a last line says it was shortened.
 */
function buildAskSummary(name: string, outcome: Extract<TaskOutcome, { kind: 'answered' }>, maxChars: number): string {
  const counts = answerCounts(outcome);
  if (counts.total === 0) return `No answers from ${name}: none were recorded. Needs your attention.`;
  const header = askHeader(name, counts);

  const render = (itemChars: number, summary: string | undefined, shortened: boolean) =>
    [
      header,
      ...outcome.answers.map((a, i) => renderAnswer(i + 1, a, itemChars)),
      ...(summary ? [summary] : []),
      ...(shortened ? [SHORTENED_NOTE] : []),
    ].join('\n');

  const whole = render(Infinity, outcome.summary, false);
  if (whole.length <= maxChars) return whole;

  // The largest per-question budget that fits with this summary, or -1.
  const longest = Math.max(...outcome.answers.map((a) => a.question.length + (a.answered ? a.answer.length : 0)));
  const fit = (summary: string | undefined): number => {
    let lo = -1;
    let hi = longest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (render(mid, summary, true).length <= maxChars) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const clippedSummary = outcome.summary ? clipText(outcome.summary, SUMMARY_KEEP_CHARS) : undefined;
  if (clippedSummary) {
    const withSummary = fit(clippedSummary);
    if (withSummary >= Math.min(MIN_ITEM_CHARS_WITH_SUMMARY, longest)) return render(withSummary, clippedSummary, true);
  }
  const without = fit(undefined);
  if (without >= 0) return render(without, undefined, true);
  // A budget too small for even the bare numbering: whole lines only, so no
  // line is cut part-way.
  const lines = render(0, undefined, true).split('\n');
  let out = '';
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
}

/**
 * An ask summary's first line, with at least one question: how many were
 * answered. It doesn't depend on the budget, so withSavedAnswers can swap it
 * out without rendering the summary twice.
 */
function askHeader(name: string, { answered, total }: { answered: number; total: number }): string {
  return answered === 0
    ? `No answers from ${name} (0 of ${total}). Needs your attention.`
    : `Asked ${name}: ${answered === total ? `all ${total}` : `${answered} of ${total}`} answered.`;
}

/**
 * One numbered line. `itemChars` is shared between the question and its
 * answer; when both are long the answer gets the larger share, since the
 * owner wrote the question.
 */
function renderAnswer(n: number, a: TaskAnswer, itemChars: number): string {
  if (!a.answered) return `${n}. ${clipText(a.question, itemChars)} (no answer)`;
  let q = a.question;
  let ans = a.answer;
  if (q.length + ans.length > itemChars) {
    const questionShare = Math.floor(itemChars * 0.4);
    if (q.length <= questionShare) ans = clipText(ans, itemChars - q.length);
    else if (ans.length <= itemChars - questionShare) q = clipText(q, itemChars - ans.length);
    else {
      q = clipText(q, questionShare);
      ans = clipText(ans, itemChars - questionShare);
    }
  }
  return `${n}. ${q} ${ans}`;
}

/**
 * Appends a note when the call didn't open by saying it's an AI (#8). The
 * owner is who answers for that call, so they hear about it with the outcome,
 * not only in a log line.
 */
export function withDisclosureNote(summary: string, disclosure: DisclosureResult | undefined): string {
  return disclosure === 'missed' ? `${summary}${DISCLOSURE_NOTE}` : summary;
}
