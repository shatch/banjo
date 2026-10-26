import { z } from 'zod';
import { config } from '../../config/index.js';
import { zonedTimeToUtcIso } from '../../lib/timezone.js';
import { APPROVAL_WINDOW_MS, buildApprovalMessage, formatLocal, MAX_WAITING_APPROVALS } from '../../approvals/request.js';
import { getContact } from '../../contacts/service.js';
import { addressBookNameFor } from '../../googleContacts/lookup.js';
import { logger } from '../../lib/logger.js';
import { sendOwnerMessage } from '../../notifications/owner.js';
import { callCapLimit, canOverrideCallCap, checkCallCap, describeCallCapRefusal, OVERRIDE_CAP_MULTIPLIER } from '../../tasks/callCap.js';
import { cancelPendingTask, countOpenApprovalRequests, createTask, withApprovalRequestLock } from '../../tasks/service.js';
import type { McpRole } from '../role.js';
import { heldForAgent, screenCall } from '../../screening/request.js';
import { triggerOrchestration } from '../../tasks/orchestrator.js';
import type { TaskConstraints, TimeWindow } from '../../tasks/schema.js';
import { modeRules } from '../../tasks/modes.js';

/** Enough for an errand; a longer list is a survey, not a phone call. */
const MAX_QUESTIONS = 5;
const MAX_QUESTION_CHARS = 300;

const timeWindowSchema = z.object({
  start: z
    .string()
    .describe(
      `ISO 8601 date-time marking the start of an acceptable window, e.g. "2026-08-03T15:00:00". Without a UTC offset it's read in ${config.CALENDAR_TIMEZONE}.`,
    ),
  end: z.string().describe('ISO 8601 date-time marking the end of an acceptable window, read the same way as start.'),
});

export const placeCallInputSchema = z.object({
  contactId: z.guid().describe('Id of the contact to call — resolve this first via find_contact.'),
  taskDescription: z
    .string()
    .min(1)
    .describe('What to accomplish on the call, e.g. "Book a haircut, any day next week after 3pm."'),
  mode: z
    .enum(['booking', 'conversation', 'ask'])
    .optional()
    .describe(
      "'booking' (default) negotiates a specific outcome — a time, a voicemail, an escalation. " +
        "'conversation' is for calls with no booking/negotiation goal — deliver a message, discuss something, " +
        "react to what's said — ending naturally rather than at a specific negotiated outcome. " +
        "A 'booking' call that simply ends, with no booking, voicemail or failed negotiation recorded, is marked " +
        "'escalated' for follow-up. So use 'conversation' for a call with no booking goal, such as a check-in, a " +
        'message or a test call. ' +
        "'ask' finds something out — opening hours, whether an item is in stock, a quote — and reports back: pass " +
        "the questions in `questions`. The task ends 'answered', with each question's answer (or that it went " +
        "unanswered) in outcome.answers. An 'ask' call books nothing and agrees to nothing on the principal's behalf.",
    ),
  questions: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(MAX_QUESTION_CHARS)
        // Answers are matched to questions by their number in the prompt's list,
        // and a line break inside one ("Hours?\n2. Walk-ins?") would add a number.
        .regex(/^[^\r\n]*$/, 'Each question must be on one line: put each question in its own item, with no line breaks.'),
    )
    .min(1)
    .max(MAX_QUESTIONS)
    .optional()
    .describe(
      `Required with mode 'ask', and only allowed with it: what to find out, one question per item, in the order to ` +
        `ask them (at most ${MAX_QUESTIONS}), e.g. ["What time do you close on Saturday?", "Do you take walk-ins?"].`,
    ),
  scheduledFor: z
    .string()
    .optional()
    .describe(
      `Place the call no earlier than this time instead of right away, as a local date-time WITHOUT a UTC offset ` +
        `(e.g. "2026-09-14T09:00:00"), interpreted in ${config.CALENDAR_TIMEZONE}. Omit to call immediately. ` +
        `The task stays "pending" until then. A time up to 5 minutes in the past calls immediately; anything older is ` +
        `rejected as a likely mistake (wrong date or year) rather than dialing now.`,
    ),
  constraints: z
    .object({
      dateWindows: z
        .array(timeWindowSchema)
        .optional()
        .describe('Acceptable date/time windows to offer/accept during negotiation.'),
      durationMinutes: z.number().int().positive().optional().describe('Expected appointment duration, in minutes.'),
      notes: z.string().optional().describe('Any other free-text guidance for the call (preferences, context, etc).'),
      maxHoldMinutes: z
        .number()
        .int()
        .min(1)
        .max(45)
        .optional()
        .describe(
          "The longest to wait on hold on this call, if it reaches a hold queue (e.g. a pharmacy or an airline). Omit for the server's default " +
            `(${config.HOLD_MAX_MINUTES} minutes). Banjo waits silently and the owner is told when the hold starts and when someone picks up.`,
        ),
    })
    .optional()
    .describe('Constraints guiding what times/details are acceptable. Omit if unconstrained.'),
  overrideCallCap: z
    .boolean()
    .optional()
    .describe(
      `Owner only, for testing: let this call go past the limit of ${config.MAX_CALLS_PER_NUMBER_PER_DAY} calls per number ` +
        `per 24 hours, up to ${OVERRIDE_CAP_MULTIPLIER} times it. Only for a family contact or the owner's own number. Set it ` +
        "only after the owner has said yes in this conversation to going past the limit for this contact, told how many " +
        'calls it has had today. Never on your own initiative.',
    ),
});

export interface PlaceCallResult {
  taskId: string;
  ackMessage: string;
}

/**
 * Interpreted in CALENDAR_TIMEZONE, never the server's own zone — the same
 * rule as every other call-facing time (see src/lib/timezone.ts's
 * zonedTimeToUtcIso for the booking that once landed 4 hours off).
 */
export function parseScheduledFor(value: string): Date {
  // A date alone would parse as midnight and place a real call at 12am.
  if (!/T\d{2}:\d{2}/.test(value)) {
    throw new Error(`scheduledFor "${value}" must include a time of day, e.g. "2026-09-14T09:00:00"`);
  }
  let parsed: Date;
  try {
    parsed = new Date(zonedTimeToUtcIso(value, config.CALENDAR_TIMEZONE));
  } catch (err) {
    throw new Error(`Could not parse scheduledFor "${value}" as a date-time (${err instanceof Error ? err.message : String(err)})`);
  }
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not parse scheduledFor "${value}" as a date-time`);
  }
  return parsed;
}

/**
 * Pins each window to UTC instants before it's stored. An offset-less time
 * means CALENDAR_TIMEZONE; left as-is, the calendar provider's Date.parse
 * would read it in the server's own zone (UTC in Docker) and offer times
 * hours off — see zonedTimeToUtcIso.
 */
function normalizeDateWindows(windows: TimeWindow[]): TimeWindow[] {
  const toUtc = (value: string) => {
    try {
      return zonedTimeToUtcIso(value, config.CALENDAR_TIMEZONE);
    } catch {
      throw new Error(`constraints.dateWindows: could not parse "${value}" as a date-time, e.g. "2026-08-03T15:00:00"`);
    }
  };
  return windows.map((w) => ({ start: toUtc(w.start), end: toUtc(w.end) }));
}

/** How far in the past a scheduledFor may be and still call immediately — see placeCallHandler. */
const SCHEDULED_FOR_PAST_GRACE_MS = 5 * 60 * 1000;

const formatInCalendarTimezone = formatLocal;

/**
 * Creates the Task row and hands off to async call orchestration WITHOUT
 * awaiting it — a phone call can run for minutes, far longer than an MCP
 * tool call should block. The caller (the schedule-appointment skill) is
 * expected to poll get_task_status for the eventual outcome. With a future
 * scheduledFor, nothing is triggered now: the orchestration poller starts the
 * call once it's due.
 *
 * With the agent key (`role: 'agent'`), the task waits for the owner to
 * approve it from a signed link sent with sendOwnerMessage (src/approvals/),
 * and nothing is triggered: approving it does. The link never appears in the
 * result. `overrideCallCap` is the owner's alone.
 */
export async function placeCallHandler(
  input: z.infer<typeof placeCallInputSchema>,
  ctx: { role: McpRole },
): Promise<PlaceCallResult> {
  // Checked here, not in the schema, so the MCP tool's JSON Schema stays a plain object.
  const asks = modeRules({ mode: input.mode ?? 'booking' }).asks;
  if (asks && !input.questions?.length) {
    throw new Error("mode 'ask' needs at least one question in `questions`: what should Banjo find out?");
  }
  if (!modeRules({ mode: input.mode ?? 'booking' }).books && input.constraints?.dateWindows?.length) {
    throw new Error("constraints.dateWindows don't apply to mode 'ask': it books nothing. To ask about a time, put it in a question.");
  }
  if (!asks && input.questions) {
    throw new Error("`questions` is only for mode 'ask'. Put a booking or conversation goal in taskDescription.");
  }
  const constraints: TaskConstraints = { ...input.constraints };
  if (constraints.dateWindows) constraints.dateWindows = normalizeDateWindows(constraints.dateWindows);
  const scheduledFor = input.scheduledFor ? parseScheduledFor(input.scheduledFor) : undefined;
  // A time well in the past is almost always a mistake (the wrong year, or
  // yesterday's date) — dialing it now could place a real call at the wrong
  // hour. A few minutes late is just the request arriving slowly.
  if (scheduledFor && scheduledFor.getTime() < Date.now() - SCHEDULED_FOR_PAST_GRACE_MS) {
    throw new Error(
      `scheduledFor "${input.scheduledFor}" is already in the past (${formatInCalendarTimezone(scheduledFor)} ${config.CALENDAR_TIMEZONE}) — check the date and year, or omit scheduledFor to call now`,
    );
  }

  const agent = ctx.role === 'agent';
  if (agent && input.overrideCallCap) {
    throw new Error("overrideCallCap needs the owner's own key: an agent can't lift the call limit.");
  }
  const contact = await getContact(input.contactId);
  if (!contact) throw new Error(`Contact not found: ${input.contactId}`);
  if (input.overrideCallCap && !canOverrideCallCap(contact)) {
    throw new Error('The call cap can only be overridden for the owner or family.');
  }
  const limit = callCapLimit({ callCapOverride: input.overrideCallCap ?? false }, contact);

  // At most MAX_CALLS_PER_NUMBER_PER_DAY calls to one number in any 24 hours,
  // counting calls already queued to dial (tasks/callCap.ts). The owner's
  // check leaves out agent requests they haven't approved, so an agent can't
  // use up the owner's calls by asking; each is counted again before it dials.
  // Refused before anything is created. A call scheduled for later isn't checked here: today's
  // calls may have left the window by then, so the orchestrator checks it when
  // it comes due instead.
  const callsNow = !scheduledFor || scheduledFor.getTime() <= Date.now();
  if (callsNow) {
    const cap = await checkCallCap(input.contactId, new Date(), { includeQueued: true, includeAwaitingApproval: agent, limit });
    if (!cap.allowed) throw new Error(describeCallCapRefusal(cap));
  }

  // Call screening (#150): before anything is created. A held request waits
  // for the owner like an agent's, whoever asked, and is never refused.
  const screen = config.SCREEN_CALLS
    ? await screenCall(contact, { mode: input.mode ?? 'booking', goal: input.taskDescription, questions: input.questions, notes: input.constraints?.notes })
    : ({ held: false } as const);
  const needsApproval = agent || screen.held;

  const create = () =>
    createTask({
      contactId: input.contactId,
      channel: 'phone',
      goalDescription: input.taskDescription,
      constraints,
      mode: input.mode,
      questions: input.questions,
      scheduledFor,
      ...(needsApproval ? { approvalExpiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS) } : {}),
      ...(agent ? { requestedByAgent: true } : {}),
      ...(screen.held ? { screenFlag: screen.reason } : {}),
      ...(input.overrideCallCap ? { callCapOverride: true } : {}),
    });
  // An agent's request is checked against the waiting limit and created under
  // one lock, so simultaneous requests can't all pass the check.
  const task = !agent
    ? await create()
    : await withApprovalRequestLock(async () => {
        if ((await countOpenApprovalRequests()) >= MAX_WAITING_APPROVALS) {
          throw new Error(
            `${MAX_WAITING_APPROVALS} call requests are already waiting for the owner's approval, or were cancelled less than ` +
              `${APPROVAL_WINDOW_MS / 60_000} minutes after they were asked for. Wait for one to be approved or for its window to end.`,
          );
        }
        return create();
      });

  if (needsApproval) {
    const addressBookName = await addressBookNameFor(contact);
    const delivered = await sendOwnerMessage(buildApprovalMessage({ contact: { ...contact, addressBookName }, task }));
    if (!delivered) {
      await cancelPendingTask(task.id);
      throw new Error("Couldn't reach the owner for approval, so no call will be placed.");
    }
    const held = screen.held ? (agent ? `${heldForAgent(screen)} ` : `Call screening held it for the owner's approval: ${screen.reason} `) : '';
    return {
      taskId: task.id,
      ackMessage:
        `${held}Asked the owner to approve a call about "${input.taskDescription}". It will be placed once they approve, or ` +
        `cancelled if they haven't by ${formatLocal(task.approvalExpiresAt!)} (${config.CALENDAR_TIMEZONE}). Check get_task_status.`,
    };
  }

  const overridden = input.overrideCallCap ? `Call cap overridden (up to ${limit} calls in 24 hours). ` : '';
  if (input.overrideCallCap) logger.warn({ taskId: task.id, contactId: input.contactId, limit }, 'owner overrode the call cap for this call');

  if (scheduledFor && scheduledFor.getTime() > Date.now()) {
    return {
      taskId: task.id,
      ackMessage: `${overridden}Scheduled a call about "${input.taskDescription}" for ${formatInCalendarTimezone(scheduledFor)} (${config.CALENDAR_TIMEZONE}). I'll let you know how it goes.`,
    };
  }

  // Fire-and-forget. Deliberately not awaited — see module comment above.
  triggerOrchestration(task.id);

  return {
    taskId: task.id,
    ackMessage: `${overridden}Started calling about "${input.taskDescription}". I'll let you know how it goes.`,
  };
}
