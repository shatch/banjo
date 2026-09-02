import { z } from 'zod';
import { createTask } from '../../tasks/service.js';
import { triggerOrchestration } from '../../tasks/orchestrator.js';
import type { TaskConstraints } from '../../tasks/schema.js';

const timeWindowSchema = z.object({
  start: z.string().describe('ISO 8601 datetime marking the start of an acceptable window, e.g. "2026-08-03T15:00:00-07:00".'),
  end: z.string().describe('ISO 8601 datetime marking the end of an acceptable window.'),
});

export const placeCallInputSchema = z.object({
  contactId: z.string().uuid().describe('Id of the contact to call — resolve this first via find_contact.'),
  taskDescription: z
    .string()
    .min(1)
    .describe('What to accomplish on the call, e.g. "Book a haircut, any day next week after 3pm."'),
  mode: z
    .enum(['booking', 'conversation'])
    .optional()
    .describe(
      "'booking' (default) negotiates a specific outcome — a time, a voicemail, an escalation. " +
        "'conversation' is for calls with no booking/negotiation goal — deliver a message, discuss something, " +
        "react to what's said — ending naturally rather than at a specific negotiated outcome.",
    ),
  constraints: z
    .object({
      dateWindows: z
        .array(timeWindowSchema)
        .optional()
        .describe('Acceptable date/time windows to offer/accept during negotiation.'),
      durationMinutes: z.number().int().positive().optional().describe('Expected appointment duration, in minutes.'),
      notes: z.string().optional().describe('Any other free-text guidance for the call (preferences, context, etc).'),
    })
    .optional()
    .describe('Constraints guiding what times/details are acceptable. Omit if unconstrained.'),
});

export interface PlaceCallResult {
  taskId: string;
  ackMessage: string;
}

/**
 * Creates the Task row and hands off to async call orchestration WITHOUT
 * awaiting it — a phone call can run for minutes, far longer than an MCP
 * tool call should block. The caller (the schedule-appointment skill) is
 * expected to poll get_task_status for the eventual outcome.
 */
export async function placeCallHandler(input: z.infer<typeof placeCallInputSchema>): Promise<PlaceCallResult> {
  const constraints: TaskConstraints = input.constraints ?? {};

  const task = await createTask({
    contactId: input.contactId,
    channel: 'phone',
    goalDescription: input.taskDescription,
    constraints,
    mode: input.mode,
  });

  // Fire-and-forget. Deliberately not awaited — see module comment above.
  triggerOrchestration(task.id);

  return {
    taskId: task.id,
    ackMessage: `Started calling about "${input.taskDescription}". I'll let you know how it goes.`,
  };
}
