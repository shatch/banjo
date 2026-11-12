/**
 * What the sim shows for a tool call, its result and the task's outcome, in
 * plain words. The raw JSON (--verbose) is for debugging; a first-time visitor
 * reading it took it for debug output and missed what it showed: that Banjo
 * checks the calendar before agreeing, and records the booking itself.
 *
 * Display only. Nothing here reaches the model or the database.
 */
import { formatSpokenInZone } from '../lib/timezone.js';
import type { TaskOutcome } from '../tasks/schema.js';

type Args = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');
const withNote = (line: string, note: unknown): string => (text(note) ? `${line}: ${text(note)}` : line);

/** "2026-11-13" → "Friday, November 13". A date the model garbled is shown as it came. */
function dayLabel(date: unknown): string {
  const parsed = new Date(`${text(date)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return text(date);
  return parsed.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** A local date-time with no offset ("2026-11-13T16:15:00") → "Friday, November 13 at 4:15 PM". */
function localLabel(local: unknown): string {
  const parsed = new Date(`${text(local).replace(/(Z|[+-]\d\d:?\d\d)$/, '')}Z`);
  if (Number.isNaN(parsed.getTime())) return text(local);
  const day = parsed.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const time = parsed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  return `${day} at ${time}`;
}

const minutes = (value: unknown): string => (typeof value === 'number' ? ` (${value} min)` : '');

/** One line for a tool call, e.g. "Banjo checks Alex's calendar: Friday, November 13 at 4:15pm (60 min)". */
export function describeToolCall(name: string, args: Args, principal: string): string {
  switch (name) {
    case 'check_my_availability':
      return `Banjo checks ${principal}'s calendar: ${dayLabel(args.date)} at ${text(args.time)}${minutes(args.durationMinutes)}`;
    case 'confirm_appointment':
      return `Banjo records the booking: ${localLabel(args.confirmedStart)}${minutes(args.durationMinutes)}`;
    case 'undo_confirmed_appointment':
      return withNote('Banjo undoes the booking it recorded', args.reason);
    case 'leave_voicemail_and_end_call':
      return 'Banjo leaves a voicemail, word for word, and ends the call';
    case 'report_negotiation_failed':
      return withNote('Banjo ends the call with no time agreed', args.reason);
    case 'escalate_and_end_call':
      return withNote(`Banjo ends the call and hands it to ${principal}`, args.reason);
    case 'end_call':
    case 'end_conversation_call':
      return withNote('Banjo ends the call', args.summary);
    case 'record_answer':
      return args.answered === false
        ? `Banjo saves question ${String(args.question)} as not answered`
        : withNote(`Banjo saves the answer to question ${String(args.question)}`, args.answer);
    case 'report_answers_and_end_call':
      return withNote('Banjo reports the answers and ends the call', args.summary);
    case 'record_do_not_call':
      return 'Banjo records that they asked not to be called again';
    case 'note_follow_up':
      return withNote(`Banjo notes something to pass on to ${principal}`, args.request);
    case 'wait_on_hold':
      return 'Banjo waits on hold, saying nothing until someone speaks';
    case 'press_digits':
      return `Banjo presses ${text(args.digits)}`;
    case 'transfer_to_owner':
      return withNote(`Banjo hands the call to ${principal}`, args.reason);
    case 'ask_owner':
      return withNote(`Banjo asks ${principal}`, args.question);
    default:
      return `Banjo uses ${name.replace(/_/g, ' ')}`;
  }
}

/** One line for a tool's result when it says something the call line didn't, else null. */
export function describeToolResult(name: string, result: unknown, isError?: boolean): string | null {
  const fields = (result && typeof result === 'object' ? result : {}) as Args;
  if (isError || fields.ok === false) {
    // The message is written for the model; its first sentence says what was wrong.
    const why = text(fields.message).split(/(?<=[.!?])\s/)[0] || text(fields.error).replace(/_/g, ' ') || 'no reason given';
    return `Didn't go through. Banjo is told: "${why}"`;
  }
  if (name === 'check_my_availability' && typeof fields.free === 'boolean') return fields.free ? 'Free' : 'Busy';
  return null;
}

/** The task's outcome in a line or a few, in place of the stored JSON. */
export function describeOutcome(outcome: TaskOutcome | null | undefined, timeZone: string): string {
  if (!outcome) return 'No outcome was recorded.';
  switch (outcome.kind) {
    case 'confirmed': {
      const { day, time } = formatSpokenInZone(outcome.start, timeZone);
      return `Booked: ${day} at ${time} (${outcome.durationMinutes} min)`;
    }
    case 'voicemail_left':
      return `Voicemail left: "${text(outcome.message)}"`;
    case 'negotiation_failed':
      return withNote('No time agreed', outcome.reason);
    case 'escalated':
      return withNote("Needs the owner's attention", outcome.reason);
    case 'failed':
      return withNote('The call did not finish', outcome.reason);
    case 'conversation_completed':
      return withNote('Conversation finished', outcome.summary);
    case 'transferred':
      return withNote('Transferred to the owner', outcome.reason);
    case 'answered':
      return [
        'Answers:',
        ...outcome.answers.map((a, i) => `  ${i + 1}. ${a.question} ${a.answered ? text(a.answer) : '(not answered)'}`),
        ...(text(outcome.summary) ? [`Also: ${text(outcome.summary)}`] : []),
      ].join('\n');
    default:
      return JSON.stringify(outcome);
  }
}
