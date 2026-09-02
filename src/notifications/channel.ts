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
    case 'confirmed':
      return `Booked with ${contact.displayName}: ${new Date(outcome.start).toLocaleString()} (${outcome.durationMinutes} min).${outcome.details ? ` ${outcome.details}` : ''}`;
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
  }
}
