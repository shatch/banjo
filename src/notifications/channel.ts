import { config } from '../config/index.js';
import { formatSpokenInZone } from '../lib/timezone.js';
import type { DisclosureResult } from '../session/disclosure.js';
import type { Contact } from '../contacts/schema.js';
import type { TaskOutcome } from '../tasks/schema.js';

export interface NotificationChannel {
  notify(taskId: string, outcome: TaskOutcome, summary: string): Promise<void>;
}

/**
 * Builds Steve's outcome summary for a terminal phone-path task. The
 * online-booking path (handled by the schedule-appointment skill) relays its
 * outcome directly in the conversation instead — this is only used for
 * calls, which run asynchronously with no one watching.
 */
export function buildOutcomeSummary(contact: Contact, outcome: TaskOutcome): string {
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
  }
}

/**
 * Appends a note when the call didn't open by saying it's an AI (#8). The
 * owner is who answers for that call, so they hear about it with the outcome,
 * not only in a log line.
 */
export function withDisclosureNote(summary: string, disclosure: DisclosureResult | undefined): string {
  return disclosure === 'missed'
    ? `${summary} Note: Banjo didn't say it was an AI at the start of this call.`
    : summary;
}
