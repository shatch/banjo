import { z } from 'zod';
import { recordTaskOutcome } from '../../tasks/service.js';
import type { Task } from '../../tasks/schema.js';

const confirmedOutcomeSchema = z.object({
  kind: z.literal('confirmed'),
  start: z.string().describe('ISO 8601 datetime of the confirmed appointment start.'),
  durationMinutes: z.number().int().positive().describe('Duration of the confirmed appointment, in minutes.'),
  details: z.string().optional().describe('Any additional confirmation details, e.g. address, confirmation number.'),
});

const voicemailOutcomeSchema = z.object({
  kind: z.literal('voicemail_left'),
  message: z.string().describe('The message that was left on voicemail.'),
});

const negotiationFailedOutcomeSchema = z.object({
  kind: z.literal('negotiation_failed'),
  reason: z.string().describe('Why none of the offered times fit the constraints.'),
});

const escalatedOutcomeSchema = z.object({
  kind: z.literal('escalated'),
  reason: z.string().describe("Why this needs the assistant's owner to step in directly."),
});

const failedOutcomeSchema = z.object({
  kind: z.literal('failed'),
  reason: z.string().describe('Why the booking attempt failed technically (no answer, site error, bad number, etc).'),
});

/** Mirrors the TaskOutcome discriminated union in src/tasks/schema.ts exactly. */
export const taskOutcomeSchema = z.discriminatedUnion('kind', [
  confirmedOutcomeSchema,
  voicemailOutcomeSchema,
  negotiationFailedOutcomeSchema,
  escalatedOutcomeSchema,
  failedOutcomeSchema,
]);

export const recordTaskOutcomeInputSchema = z.object({
  contactId: z.string().uuid().describe('Id of the contact this outcome pertains to.'),
  goalDescription: z.string().min(1).describe('What the task was trying to accomplish, e.g. "Book a haircut."'),
  outcome: taskOutcomeSchema.describe('The result of the booking attempt.'),
  calendarEventId: z
    .string()
    .optional()
    .describe('Id of the calendar event created for a confirmed booking, if a calendar event was written.'),
});

/**
 * Used by the schedule-appointment skill to log a task it completed itself
 * (typically an ONLINE booking done via browser automation) into the same
 * task history as phone-call tasks, so get_task_status / list_recent_tasks
 * stay a complete record regardless of channel.
 */
export async function recordTaskOutcomeHandler(input: z.infer<typeof recordTaskOutcomeInputSchema>): Promise<Task> {
  return recordTaskOutcome({
    contactId: input.contactId,
    goalDescription: input.goalDescription,
    outcome: input.outcome,
    calendarEventId: input.calendarEventId,
  });
}
