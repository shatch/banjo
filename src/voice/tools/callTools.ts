import { z } from 'zod';
import { SlotUnavailableError } from '../../calendar/types.js';
import { config, disclosureLine, disclosureLineWithoutNotice } from '../../config/index.js';
import { childLogger } from '../../lib/logger.js';
import { formatInZone, formatSpokenInZone, zonedTimeToUtcIso } from '../../lib/timezone.js';
import { TimeoutError, withTimeout } from '../../lib/withTimeout.js';
import { sendOwnerMessage } from '../../notifications/owner.js';
import type { CallContext } from '../../session/types.js';
import { collectedAnswer, finalAnswers, reportedAnswerSchema, type ReportedAnswer } from '../../tasks/answers.js';
import { modeRules } from '../../tasks/modes.js';
import { isTerminalStatus, MAX_FOLLOW_UPS, saveCollectedAnswer, saveFollowUp, transitionTask } from '../../tasks/service.js';
import type { TelephonyProvider } from '../../telephony/providers/types.js';
import type { ToolDefinition } from '../types.js';
import { withoutRepeatedLead } from '../verbatimMatch.js';
import { defineVoiceTool, toToolDefinition, type VoiceTool } from './defineVoiceTool.js';

const log = childLogger({ module: 'voice.callTools' });

/**
 * Structured failure shape returned to the model (via sendToolResult) when a
 * handler's core logic times out or throws. Kept generic/opaque on purpose —
 * we don't want to leak upstream error internals into the live call.
 */
type ToolFailure = { ok: false; error: 'timeout' | 'upstream_error' | 'slot_unavailable'; message: string };

/**
 * Runs a tool handler's core logic bounded by TOOL_TIMEOUT_MS, catching and
 * logging any failure rather than letting it throw uncaught into the
 * websocket event loop. session/callSession.ts is responsible for shipping
 * whatever this returns back to the model via sendToolResult — including a
 * ToolFailure shape, which the model can react to conversationally (e.g. "hang
 * on, let me try that again" or falling back to another tool).
 */
export async function runToolSafely<T>(toolName: string, work: () => Promise<T>): Promise<T | ToolFailure> {
  try {
    return await withTimeout(work(), config.TOOL_TIMEOUT_MS);
  } catch (err) {
    const isTimeout = err instanceof TimeoutError;
    const isSlotConflict = err instanceof SlotUnavailableError;
    log.error({ err, toolName }, `voice tool "${toolName}" failed`);
    return {
      ok: false,
      error: isTimeout ? 'timeout' : isSlotConflict ? 'slot_unavailable' : 'upstream_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A tool's own trailing speech (e.g. "thanks, I'll wrap up now") is still
 * streaming to the phone line as audio chunks over the media-stream
 * WebSocket at the moment the model decides to call a hang-up tool — the
 * tool call and the audio that's still playing aren't sequenced against
 * each other. Calling TelephonyProvider.hangUp() immediately (a REST call
 * that ends the Twilio leg right away) cuts off whatever's still
 * buffered/playing, mid-word. Caught on a live call: "I'm just wrapping up
 * this test and then I'll..." — cut off exactly there.
 *
 * ctx.estimatedAudioDoneAt (session/audioPlaybackTracker.ts, threaded
 * through CallSessionOptions.buildToolContext) is the estimated wall-clock
 * time by which every audio chunk sent so far will have finished playing on
 * the phone leg — waiting until then (plus a small safety margin for
 * Twilio's own network/buffering lag) hangs up right after the trailing
 * speech actually finishes, instead of a blind fixed sleep. For a short
 * sentence that's already done playing by the time the tool call resolves,
 * estimatedAudioDoneAt is already in the past, so the wait collapses to
 * just the safety margin — faster than the old fixed 2.5s in the common
 * case. For a longer confirmation sentence still mid-flight, the wait
 * extends to cover it exactly, not by a guessed amount.
 */
const HANGUP_SAFETY_MARGIN_MS = 400; // covers Twilio's own network/buffering lag beyond our send time
// Stays comfortably under TOOL_TIMEOUT_MS (default 8000ms) so a long trailing
// utterance can never blow the enclosing tool call's timeout budget.
// transfer_to_owner (telephony/transfer.ts) also uses it via waitForPlayback
// but has no such enclosing timeout: its limit is its handlerBudgetMs.
export const MAX_HANGUP_WAIT_MS = 6000;

/** Waits until the model's own trailing speech has played out (capped at MAX_HANGUP_WAIT_MS). Shared with telephony/transfer.ts. */
export async function waitForPlayback(ctx: { estimatedAudioDoneAt: number }): Promise<void> {
  const waitMs = Math.min(MAX_HANGUP_WAIT_MS, Math.max(0, ctx.estimatedAudioDoneAt - Date.now()) + HANGUP_SAFETY_MARGIN_MS);
  await sleep(waitMs);
}

export async function hangUpAfterSpeaking(ctx: { telephony: TelephonyProvider; callId: string; estimatedAudioDoneAt: number }): Promise<void> {
  await waitForPlayback(ctx);
  await ctx.telephony.hangUp(ctx.callId);
}

/**
 * Recognizes `h`, `h:mm`, `hh`, `hh:mm` followed by `am`/`pm`/`AM`/`PM`
 * (with or without a space before it) — covers every example already in
 * this codebase's own tool schema descriptions ("14:30", "2:30pm") plus the
 * bare-hour form a caller is just as likely to say ("11am"). Returns the
 * input unchanged if it doesn't match this shape (e.g. it's already
 * 24-hour, or unparseable) — combineDateTimeToIso's existing error path
 * handles anything that still doesn't parse.
 */
const AM_PM_TIME_PATTERN = /^(\d{1,2})(?::(\d{2}))?\s*([aApP][mM])$/;

function normalizeAmPmTime(time: string): string {
  const match = AM_PM_TIME_PATTERN.exec(time);
  if (!match) return time;
  const hourStr = match[1]!;
  const minuteStr = match[2];
  const meridiem = match[3]!;
  let hour = Number(hourStr);
  const minute = minuteStr ?? '00';
  const isPm = meridiem.toLowerCase() === 'pm';
  if (isPm && hour !== 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

/**
 * Combines a `date` + `time` pair (as spoken/typed by the model) into a
 * correct UTC ISO instant, interpreting the naive local date-time in
 * `config.CALENDAR_TIMEZONE` — NOT the server's own local timezone. Getting
 * this wrong is exactly what caused a real booking to land 4 hours off (see
 * zonedTimeToUtcIso's doc comment).
 */
export function combineDateTimeToIso(date: string, time: string): string {
  // Both date and time are expected to already be reasonably normalized by
  // the model (e.g. date: "2026-08-05", time: "14:30") per the tool's
  // description/schema below. If either already looks like a full ISO
  // instant, prefer it directly.
  const trimmedDate = date.trim();
  const trimmedTime = normalizeAmPmTime(time.trim());
  const candidate = /T\d{2}:\d{2}/.test(trimmedDate) ? trimmedDate : `${trimmedDate}T${trimmedTime}`;
  try {
    return zonedTimeToUtcIso(candidate, config.CALENDAR_TIMEZONE);
  } catch (err) {
    throw new Error(`Could not parse date/time into an ISO instant: date="${date}" time="${time}" (${err instanceof Error ? err.message : String(err)})`);
  }
}

export const checkMyAvailabilityTool: VoiceTool<{
  date: string;
  time: string;
  durationMinutes: number;
}> = defineVoiceTool({
  name: 'check_my_availability',
  description:
    `Check whether ${config.ASSISTANT_PRINCIPAL_NAME} is free at a specific date and time for a given duration, against their personal calendar. Use this before agreeing to any specific time with the other party.`,
  schema: z.object({
    date: z.string().describe('The calendar date being proposed, e.g. "2026-08-05".'),
    time: z
      .string()
      .describe(`The time of day being proposed, e.g. "14:30" (24h) or "2:30pm", in ${config.CALENDAR_TIMEZONE} local time.`),
    durationMinutes: z.number().int().positive().describe('How long the appointment would last, in minutes.'),
  }),
  handler: async (input, ctx) => {
    return runToolSafely('check_my_availability', async () => {
      const start = combineDateTimeToIso(input.date, input.time);
      const free = await ctx.calendar.isFree({ start, durationMinutes: input.durationMinutes });
      return { free };
    });
  },
});

const MS_PER_MINUTE = 60_000;
const CALENDAR_TITLE_MAX_CHARS = 80;

/**
 * Fallback calendar title when the model doesn't supply one: the first
 * sentence of the task's goal description, which is written as an instruction
 * to the model rather than as something a human wants to read in their week.
 */
function calendarTitleFrom(goalDescription: string): string {
  const firstSentence = goalDescription.trim().split(/(?<=\.)\s+/)[0] ?? goalDescription;
  const trimmed = firstSentence.replace(/\.$/, '').trim();
  if (trimmed.length <= CALENDAR_TITLE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, CALENDAR_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * What to do right after a booking goes through, in the tool result itself.
 * The system prompt already asks for a read-back and a spoken goodbye (#44),
 * and the next live call still ended "Great, thanks for confirming—let me wrap
 * this up." (#47): at this moment the model follows the result it just got,
 * not a rule forty lines up. A conversation-mode call carries on afterwards —
 * a booking made in passing isn't the end of it.
 */
/**
 * For every free-text argument that records what happened on the call (#131,
 * #155). These reach the owner's notification, get_task_status and the task
 * webhook as the record of the call: a live summary said the callee laughed
 * and the call "wrapped up naturally", when she hadn't and it didn't.
 */
const ONLY_WHAT_HAPPENED = 'Only what was actually said or done on this call, and nothing you guess.';
const NO_ADDED_COLOR =
  ' No feelings, tone or reactions they did not put into words. If the call ended before they answered something, say so.';

function afterBookingStep(mode: string | undefined, spokenStart: string): string {
  const readBack = `Booked. Now tell them in one short sentence what is booked, using this day and time: "You're all set for ${spokenStart}", plus what it is for.`;
  if (mode === 'conversation') {
    return `${readBack} Then carry on the conversation — this booking is not the end of the call.`;
  }
  return (
    // #154: "…and call end_call" read as the next action, and 2 of 3 sim
    // runs called it before saying a word. Speaking comes first, and the
    // narration this used to quote as what not to say is no longer quoted.
    `${readBack} If they have a question, answer it first. In the same breath, say an actual goodbye to them ` +
    `(e.g. "Thanks so much — have a great day!"). Your goodbye is the last thing you say. Only once you have said it, call end_call.`
  );
}

export const confirmAppointmentTool: VoiceTool<{
  confirmedStart: string;
  durationMinutes: number;
  details?: string;
  summary?: string;
}> = defineVoiceTool({
  name: 'confirm_appointment',
  description:
    `Lock in the appointment once the other party has explicitly agreed to a specific time. This writes the event to ${config.ASSISTANT_PRINCIPAL_NAME}'s calendar and marks the task confirmed. Your own summary of a time is not agreement — wait for their clear yes to that specific time, not to a time you are still proposing. If you called this too early, undo_confirmed_appointment removes the event and reopens the negotiation. If it fails with error "slot_unavailable", the slot was taken by something else between your availability check and this call — do not treat it as booked; tell the caller and negotiate a different time.`,
  schema: z.object({
    confirmedStart: z
      .string()
      .describe(
        `The agreed appointment start time, as a local date-time WITHOUT a UTC offset (e.g. "2026-08-05T14:00:00") — express it in ${config.CALENDAR_TIMEZONE} local time, do not convert to UTC yourself.`,
      ),
    durationMinutes: z.number().int().positive().describe('The agreed appointment duration, in minutes.'),
    summary: z
      .string()
      .optional()
      .describe(
        `A short calendar title for the appointment, as ${config.ASSISTANT_PRINCIPAL_NAME} should see it in their calendar — e.g. "Dinner at Luigi's" or "Haircut with Clauda". A few words, not a sentence.`,
      ),
    details: z
      .string()
      .optional()
      .describe(
        // #155: a sim run recorded the owner profile's "nervous with clippers"
        // here, though nobody mentioned it on the call.
        `Anything said on this call that the calendar entry should hold, e.g. who to ask for, what to bring, or a price they quoted. ${ONLY_WHAT_HAPPENED} Not facts from your instructions or ${config.ASSISTANT_PRINCIPAL_NAME}'s notes that nobody mentioned on this call: those are on file already. Leave out if there is nothing.`,
      ),
  }),
  handler: async (input, ctx) => {
    return runToolSafely('confirm_appointment', async () => {
      // Interpreted in config.CALENDAR_TIMEZONE, not the server's own local
      // time — this is exactly the bug that landed a real booking 4 hours
      // off (a bare "2026-08-04T14:00:00" was silently parsed as UTC). See
      // zonedTimeToUtcIso's doc comment. If the model includes an explicit
      // offset/Z despite the schema asking it not to, that's trusted as-is
      // rather than double-converted.
      const startUtcIso = zonedTimeToUtcIso(input.confirmedStart, config.CALENDAR_TIMEZONE);

      // Checked BEFORE the calendar write (ctx.task is re-fetched per tool
      // call). A task already recorded as over used to get the event written
      // first and the refusal discovered only at the status write — an
      // orphaned event, recorded nowhere but a log line (#3). The narrower
      // race, where the call ends while the write is in flight, is handled
      // below.
      if (isTerminalStatus(ctx.task.status)) {
        return {
          ok: false as const,
          error: 'call_already_ended' as const,
          message: 'This call has already been recorded as over, so nothing was booked.',
        };
      }

      // Idempotency key is derived server-side from the call attempt id and
      // is NEVER accepted as a model-supplied argument. LLMs are unreliable
      // at generating and consistently reusing idempotency keys across
      // retries (e.g. if this tool call is retried after a transient
      // failure, a model-generated key could differ between attempts,
      // defeating the whole point of idempotency and risking a duplicate
      // calendar event). Keying off ctx.callAttempt.id guarantees the same
      // key is used for every retry within this call attempt.
      const idempotencyKey = `confirm:${ctx.callAttempt.id}`;
      const title = input.summary?.trim() || calendarTitleFrom(ctx.task.goalDescription);
      const result = await ctx.calendar.createEventIdempotent({
        idempotencyKey,
        start: startUtcIso,
        durationMinutes: input.durationMinutes,
        // goalDescription is a prompt written for the model ("Book a dinner
        // table for two at Luigi's. Any evening in the next five days works;
        // ask what they have available...") and used to go straight into the
        // event summary — i.e. into Steve's actual calendar.
        summary: title,
        description: input.details,
      });

      // What the CALENDAR holds, not what we asked for. The idempotency key is
      // derived from the call attempt, so a confirm that fails *after* Google
      // created the event (timeout, dropped response) and is then retried at a
      // renegotiated time gets the ORIGINAL event back from the guard. Recording
      // the requested time here would leave Postgres claiming a time the
      // calendar doesn't hold — and Postgres is the source of truth for whether
      // an appointment was booked, and when.
      const confirmedStartIso = new Date(result.confirmedStart).toISOString();
      const confirmedDurationMinutes = Math.round(
        (Date.parse(result.confirmedEnd) - Date.parse(result.confirmedStart)) / MS_PER_MINUTE,
      );
      const recorded = await transitionTask(ctx.task.id, 'confirmed', {
        outcome: {
          kind: 'confirmed',
          start: confirmedStartIso,
          durationMinutes: confirmedDurationMinutes,
          details: input.details,
        },
        calendarEventId: result.eventId,
      });
      if (recorded.status !== 'confirmed') {
        // The call was already recorded as over (and notified) before this
        // booking finished writing — only possible if it outlasted its
        // budget, which CallSession waits for (#3). The event exists and the
        // other party may think it's booked, so the owner is told directly
        // rather than the task's record being rewritten after the fact.
        log.error(
          { taskId: ctx.task.id, status: recorded.status, calendarEventId: result.eventId },
          'calendar event written, but the task could not be marked confirmed',
        );
        const when = formatSpokenInZone(new Date(result.confirmedStart).toISOString(), config.CALENDAR_TIMEZONE);
        void sendOwnerMessage(
          `Correction: Banjo put "${title}" on your calendar for ${when.day} at ${when.time}, after that call had already been reported as ${recorded.status}. The booking may be real; check with them.`,
          { urgent: true },
        );
      }
      // Local and spoken, never the calendar's own string (UTC, or an offset
      // the model would have to apply): the prompt says every time is
      // CALENDAR_TIMEZONE local, and the model reads this back to the other
      // party (#44). Same failure class as the 4-hours-off booking.
      const spoken = formatSpokenInZone(confirmedStartIso, config.CALENDAR_TIMEZONE);
      const spokenStart = `${spoken.day} at ${spoken.time}`;
      return {
        ok: true,
        confirmedStart: formatInZone(confirmedStartIso, config.CALENDAR_TIMEZONE),
        spokenStart,
        nextStep: afterBookingStep(ctx.task.mode, spokenStart),
      };
    });
  },
});

/**
 * The way back from a confirmation that shouldn't have happened yet.
 *
 * A real call (2026-09-22) had the model fire confirm_appointment while the
 * other party was still negotiating; when they asked for a different time it
 * had nothing to undo with, and told them to ring the business themselves.
 * Rescheduling is this tool followed by confirm_appointment again; cancelling
 * outright is this tool followed by a terminal tool. One primitive, composed,
 * rather than two tools each carrying their own copy of the calendar dance.
 *
 * Deliberately claims the task BEFORE touching the calendar. The other
 * ordering — delete, then transition — leaves Postgres claiming a confirmed
 * booking whose calendar event is gone if the transition loses a race, and a
 * silent false "you're booked" is the worst outcome available here. This way a
 * failed delete leaves a stray event that confirm_appointment's idempotency
 * guard will find and report honestly (it returns the event's real start, so
 * Postgres and the calendar still agree).
 */
export const undoConfirmedAppointmentTool: VoiceTool<{ reason: string }> = defineVoiceTool({
  name: 'undo_confirmed_appointment',
  description:
    `Undo an appointment you already confirmed on this call — removes it from ${config.ASSISTANT_PRINCIPAL_NAME}'s calendar and reopens the negotiation. Use this when the other party changes the time, withdraws it, or makes clear they had not actually agreed, AFTER you called confirm_appointment. To move the appointment, call this and then confirm_appointment with the new time. Fails with "nothing_to_undo" if there is no confirmed booking on this call to remove.`,
  schema: z.object({
    reason: z
      .string()
      .min(1)
      .describe(`Why the confirmed appointment is being undone, e.g. "callee asked for 5pm instead". ${ONLY_WHAT_HAPPENED} Recorded for the user; not spoken to the callee.`),
  }),
  handler: async (input, ctx) => {
    return runToolSafely('undo_confirmed_appointment', async () => {
      const calendarEventId = ctx.task.calendarEventId;
      if (ctx.task.status !== 'confirmed' || !calendarEventId) {
        return {
          ok: false as const,
          error: 'nothing_to_undo' as const,
          message: 'There is no confirmed appointment on this call to undo.',
        };
      }

      // Compare-and-set on 'confirmed' specifically. This is the only path out
      // of a terminal status, and `from` keeps it that narrow — every other
      // caller of transitionTask still gets allowedFromStatuses' refusal.
      const reopened = await transitionTask(
        ctx.task.id,
        'negotiating',
        { outcome: null, calendarEventId: null },
        { from: ['confirmed'] },
      );
      if (!reopened) {
        return {
          ok: false as const,
          error: 'nothing_to_undo' as const,
          message: 'There is no confirmed appointment on this call to undo.',
        };
      }

      try {
        await ctx.calendar.deleteEvent(calendarEventId);
      } catch (err) {
        // The task is already reopened, so the call can carry on — but the
        // event is still out there and someone has to know.
        log.error(
          { err, taskId: ctx.task.id, calendarEventId },
          'task reopened, but its calendar event could not be deleted',
        );
        throw err;
      }

      log.info({ taskId: ctx.task.id, calendarEventId, reason: input.reason }, 'confirmed appointment undone mid-call');
      return { ok: true as const };
    });
  },
});

/**
 * Longest voicemail message leave_voicemail_and_end_call accepts. The message
 * is spoken verbatim within SPEAK_VERBATIM_TIMEOUT_MS, and on openai-live it
 * rides in a session.instructions.append capped at 500 tokens — so an
 * unbounded one could be cut off mid-way or fail outright. ~500 characters is
 * well over a typical 20–30 second voicemail.
 */
export const VOICEMAIL_MESSAGE_MAX_CHARS = 500;

export const leaveVoicemailAndEndCallTool: VoiceTool<{ message: string }> = defineVoiceTool({
  name: 'leave_voicemail_and_end_call',
  description:
    'Leave a voicemail message and end the call. Use this when you have reached an answering machine or voicemail system instead of a human. Call it without saying anything first: the voicemail records everything, and it must open with the AI disclosure, which the system says for you. Provide the message as the `message` argument — the system says the disclosure, then your message, verbatim, then hangs up. Leave the disclosure out of the message, and do NOT say the message yourself: the callee would hear it twice. Never tell the callee how the message is delivered or that the call is ending.',
  schema: z.object({
    message: z
      .string()
      .min(1)
      .max(VOICEMAIL_MESSAGE_MAX_CHARS)
      .describe(
        'The exact voicemail message to deliver — concise and natural, including a callback number if one was given to you, without the AI disclosure (the system says that first). This is spoken to the callee verbatim by the system; do not say it yourself.',
      ),
  }),
  endsCall: true,
  // CallSession forces these to be spoken (VoiceAIProvider.sayVerbatim), one
  // turn each, and waits for them to finish playing before this handler ever
  // runs — see VoiceTool.verbatimMessage's doc comment for why. The opener is
  // its own turn so a voicemail opens with the AI disclosure, and so recording
  // can start once its notice has played rather than after the whole message,
  // when the call is already hanging up (#71). ctx.verbatimDelivery says what
  // was actually spoken: anything short of a verified delivery is recorded as
  // an escalation, never as a voicemail left, because Postgres records what
  // the callee heard rather than what the model was asked to say.
  verbatimMessage: (input) => {
    const opener = disclosureLine();
    const message = withoutRepeatedLead(input.message, [opener, disclosureLineWithoutNotice()]);
    return message ? [opener, message] : [opener];
  },
  handler: async (input, ctx) => {
    return runToolSafely('leave_voicemail_and_end_call', async () => {
      const delivery = ctx.verbatimDelivery;
      if (!delivery?.matched) {
        await transitionTask(ctx.task.id, 'escalated', {
          outcome: {
            kind: 'escalated',
            reason: delivery
              ? `Voicemail delivery could not be verified — what was spoken did not match the intended message, or it was cut off. Intended: "${delivery.intended}". Spoken: "${delivery.spoken || '(nothing)'}".`
              : `Voicemail delivery could not be verified — nothing checked what was spoken. Intended: "${input.message}".`,
          },
        });
        await hangUpAfterSpeaking(ctx);
        return { ok: false, error: 'voicemail_delivery_unverified' };
      }
      await transitionTask(ctx.task.id, 'voicemail_left', {
        outcome: { kind: 'voicemail_left', message: input.message },
      });
      await hangUpAfterSpeaking(ctx);
      return { ok: true };
    });
  },
});

export const reportNegotiationFailedTool: VoiceTool<{ reason: string }> = defineVoiceTool({
  name: 'report_negotiation_failed',
  description:
    'Use this when you reached and properly engaged with a human, but none of the times offered by either side fit the constraints of the task, and no further negotiation is possible. This is distinct from escalate_and_end_call — use this only when the call went smoothly but simply failed to reach an agreement.',
  schema: z.object({
    reason: z.string().describe(`A short explanation of why no offered time worked. ${ONLY_WHAT_HAPPENED}`),
  }),
  endsCall: true,
  yieldsToCallee: true,
  requiresGoodbye: true,
  handler: async (input, ctx) => {
    return runToolSafely('report_negotiation_failed', async () => {
      await transitionTask(ctx.task.id, 'negotiation_failed', {
        outcome: { kind: 'negotiation_failed', reason: input.reason },
      });
      await hangUpAfterSpeaking(ctx);
      return { ok: true };
    });
  },
});

export const escalateAndEndCallTool: VoiceTool<{ reason: string; stuckAt?: 'phone_menu' }> = defineVoiceTool({
  name: 'escalate_and_end_call',
  description:
    `Use this when you are genuinely stuck and cannot proceed — e.g. a confusing automated phone menu you cannot navigate, a hostile or uncooperative response, or any situation you cannot resolve on your own. This ends the call and flags the task for human (${config.ASSISTANT_PRINCIPAL_NAME}) follow-up.`,
  schema: z.object({
    reason: z.string().describe(`A short explanation of why the call needed to be escalated. ${ONLY_WHAT_HAPPENED}`),
    stuckAt: z
      .enum(['phone_menu'])
      .optional()
      .describe("'phone_menu' if you couldn't get through an automated phone menu to the right place. Leave out otherwise."),
  }),
  endsCall: true,
  handler: async (input, ctx) => {
    return runToolSafely('escalate_and_end_call', async () => {
      await transitionTask(ctx.task.id, 'escalated', {
        outcome: { kind: 'escalated', reason: input.reason, ...(input.stuckAt ? { stuckAt: input.stuckAt } : {}) },
      });
      await hangUpAfterSpeaking(ctx);
      return { ok: true };
    });
  },
});

/**
 * How to end, not just when — shared by the two plain call-ending tools (#55).
 * A conversation call ended "Thanks for that—let me respond and then we can
 * wrap up." with the other party's question unanswered: the tool description
 * is the last thing the model reads before ending, and it only said when.
 * #47 fixed the same failure after a booking via confirm_appointment's result.
 */
const BEFORE_ENDING =
  ' Before calling this, in the same turn: answer any question the other party just asked, then say an actual ' +
  'goodbye to them (e.g. "Thanks so much — have a great day!"). Your goodbye is the last thing you say. Never call ' +
  'this in the same turn as a question to them: wait for their answer first.';

export const endCallTool: VoiceTool<{ summary?: string }> = defineVoiceTool({
  name: 'end_call',
  description:
    'Call this once you have said everything you need to say and are ready to end the call normally — e.g. right after confirm_appointment has succeeded and you have told the caller the confirmed time. This does NOT itself record any outcome; use it only after an outcome-setting tool (confirm_appointment) has already run, or when there is genuinely nothing more to say and no better-fitting tool applies. leave_voicemail_and_end_call, report_negotiation_failed, and escalate_and_end_call already end the call themselves — do not call end_call after those.' +
    BEFORE_ENDING,
  schema: z.object({
    summary: z.string().optional().describe(`Optional short note about how the call concluded. ${ONLY_WHAT_HAPPENED}${NO_ADDED_COLOR}`),
  }),
  endsCall: true,
  yieldsToCallee: true,
  requiresGoodbye: true,
  handler: async (input, ctx) => {
    return runToolSafely('end_call', async () => {
      // Safety net: this tool intentionally does NOT set an outcome — it
      // exists for the case where an outcome was already recorded (e.g. by
      // confirm_appointment). But if the model calls end_call without ever
      // having called an outcome-setting tool first, don't leave the task
      // stuck in a non-terminal status (still 'negotiating') forever —
      // flag it for Steve rather than silently losing track of what
      // happened on the call. Runs BEFORE hangUpAfterSpeaking so this
      // outcome-recording can never be lost to hangUpAfterSpeaking's wait
      // exceeding the enclosing tool call's timeout budget.
      //
      // What it records depends on the mode (tasks/modes.ts): conversation
      // and ask calls get their own ending tool ADDITIVELY alongside this
      // one, and the model can and does reach for end_call to close them
      // out instead, so it records what their own ending would have.
      //
      // ctx.task is re-fetched for each tool call, so no second read here;
      // the status check only skips the usual case (end_call right after
      // confirm_appointment) — transitionTask's own guard covers any race.
      if (!isTerminalStatus(ctx.task.status)) {
        const { status, outcome } = modeRules(ctx.task).endCallOutcome(ctx.task, input.summary);
        await transitionTask(ctx.task.id, status, { outcome });
      }
      await hangUpAfterSpeaking(ctx);
      return { ok: true };
    });
  },
});

export const endConversationCallTool: VoiceTool<{ summary: string }> = defineVoiceTool({
  name: 'end_conversation_call',
  description:
    "Use this once this open-ended conversation has reached a natural close — you've said what you called to " +
    "say, and/or the other person has too, and there's nothing more to discuss right now. This is a normal, " +
    'successful way to end a conversational call — it is not an escalation or a failure. Only available on ' +
    'calls with no booking/negotiation goal.' +
    BEFORE_ENDING,
  schema: z.object({
    summary: z.string().describe(`A short summary of what was discussed/accomplished on this call. ${ONLY_WHAT_HAPPENED}${NO_ADDED_COLOR}`),
  }),
  endsCall: true,
  yieldsToCallee: true,
  requiresGoodbye: true,
  handler: async (input, ctx) => {
    return runToolSafely('end_conversation_call', async () => {
      await transitionTask(ctx.task.id, 'conversation_completed', {
        outcome: { kind: 'conversation_completed', summary: input.summary },
      });
      await hangUpAfterSpeaking(ctx);
      return { ok: true };
    });
  },
});

/**
 * Saves one answer of an ask call as soon as it's settled (#148 review), so a
 * call that ends before report_answers_and_end_call (the far end says "yep,
 * bye" and hangs up, a refused goodbye, a hold limit, a transfer) still has
 * it. Writes tasks.collected_answers through saveCollectedAnswer, never the
 * task's status or outcome; report_answers_and_end_call and end_call fold
 * these in, and a call that ends early is recorded from them
 * (tasks/modes.ts). Returns an ordinary result, so the call carries on
 * through the normal tool-result flow.
 */
const RECORD_ANSWER_NEXT =
  "Saved. Don't mention it, and don't repeat what you just said. If you already asked your next question, wait " +
  'for their answer. Otherwise ask your next question, or, if none are left, say goodbye and end the call.';

export const recordAnswerTool: VoiceTool<ReportedAnswer> = defineVoiceTool({
  name: 'record_answer',
  description:
    'Save one answer as soon as it is settled: call this right after the other party confirms your read-back of an ' +
    'answer, without saying anything about it, then carry on with the call. Use the question\'s number in your ' +
    "list. If they can't or won't answer one, save it with answered: false. Saving the same number again replaces " +
    'what you saved before. This does not end the call; report_answers_and_end_call still does, at the end.',
  schema: reportedAnswerSchema,
  replyOnlyIfSilent: true,
  handler: async (input, ctx) => {
    return runToolSafely('record_answer', async () => {
      const count = ctx.task.questions?.length ?? 0;
      if (input.question > count) {
        return {
          ok: false as const,
          error: 'no_such_question' as const,
          message: `There is no question ${input.question}: your list has ${count}.`,
        };
      }
      if (!(await saveCollectedAnswer(ctx.task.id, collectedAnswer(input)))) {
        return { ok: false as const, error: 'not_saved' as const, message: 'The answers for this call are already reported.' };
      }
      // replyOnlyIfSilent: the model replies to this only if it said nothing
      // alongside the call; then it's told what to do next (#148 review r2).
      return { ok: true as const, next: RECORD_ANSWER_NEXT };
    });
  },
});

/**
 * Saves something the other party asked to have passed on to the principal
 * (#160): a question Banjo can't answer on the call (it has no way to look
 * anything up), information only the principal has, something they'd like
 * sent. Banjo is the phone half; the agent that placed the call reads these
 * from get_task_status or the webhook and follows up. Saved straight away,
 * like record_answer, so a call that ends some other way still has them.
 * Model-written, so data in every output, never instructions.
 */
const NOTE_FOLLOW_UP_NEXT =
  `Saved for ${config.ASSISTANT_PRINCIPAL_NAME}. Tell them in a few words that you'll pass it on to ` +
  `${config.ASSISTANT_PRINCIPAL_NAME}, then carry on with the call. Never say when or how they will hear back, or ` +
  'that anyone will call them.';

export const noteFollowUpTool: VoiceTool<{ request: string }> = defineVoiceTool({
  name: 'note_follow_up',
  description:
    `Use this when the other party asks for something you can't do or answer on this call: a question you'd have to ` +
    `look up, something only ${config.ASSISTANT_PRINCIPAL_NAME} would know, or something they'd like sent to them. ` +
    `It passes the request on to ${config.ASSISTANT_PRINCIPAL_NAME} after the call. Call it once per request, then ` +
    `tell them you'll pass it on. This does not end the call. Don't use it for things you can answer or settle now.`,
  schema: z.object({
    request: z
      .string()
      .max(300)
      .describe(
        `What they asked for, in one short plain sentence, with any details they gave (dates, names). ${ONLY_WHAT_HAPPENED}`,
      ),
  }),
  replyOnlyIfSilent: true,
  handler: async (input, ctx) => {
    return runToolSafely('note_follow_up', async () => {
      const request = input.request.trim();
      if (!request) {
        return { ok: false as const, error: 'empty_request' as const, message: 'Say what they asked for.' };
      }
      if (!(await saveFollowUp(ctx.task.id, request))) {
        return {
          ok: false as const,
          error: 'not_saved' as const,
          message: `This call already has ${MAX_FOLLOW_UPS} requests to pass on, the most it can carry. Don't promise to pass this one on.`,
        };
      }
      return { ok: true as const, next: NOTE_FOLLOW_UP_NEXT };
    });
  },
});

export const reportAnswersAndEndCallTool: VoiceTool<{
  answers: ReportedAnswer[];
  summary?: string;
}> = defineVoiceTool({
  name: 'report_answers_and_end_call',
  description:
    'Use this to end the call once you have asked every question on your list and they have answered what they ' +
    "can. Record one entry per question, by its number: what they said, in a short plain sentence, or answered: " +
    "false if they didn't know, wouldn't say, or you never got to it. Record only what they actually told you on " +
    'this call. Never fill a gap with a guess. Answers you saved with record_answer are kept: an answer here for ' +
    'the same question replaces it, and answered: false here never erases one. This is the normal, successful end of this call, even if some ' +
    'questions went unanswered.' +
    BEFORE_ENDING,
  schema: z.object({
    answers: z
      .array(reportedAnswerSchema)
      .describe('One entry per question on your list.'),
    summary: z
      .string()
      .optional()
      .describe(`Anything else worth passing on that they told you, briefly. ${ONLY_WHAT_HAPPENED} Leave out if nothing.`),
  }),
  endsCall: true,
  yieldsToCallee: true,
  requiresGoodbye: true,
  // Saved before CallSession can refuse this (no goodbye, or they're still
  // talking): if the line then drops, the answers are kept (#148 review r2).
  // Only answers: a closing "not answered" never erases a saved one.
  beforeChecks: async (input, ctx) => {
    const count = ctx.task.questions?.length ?? 0;
    for (const report of input.answers) {
      const checked = collectedAnswer(report);
      if (checked.answered && checked.question <= count) await saveCollectedAnswer(ctx.task.id, checked);
    }
  },
  handler: async (input, ctx) => {
    return runToolSafely('report_answers_and_end_call', async () => {
      const summary = input.summary?.trim();
      // What record_answer saved during the call, with this report's answers
      // on top (finalAnswers): an answer here replaces a saved one, and
      // neither an omission nor answered: false erases it. ctx.task is
      // re-fetched for each tool call, so it has every answer saved before this one.
      await transitionTask(ctx.task.id, 'answered', {
        outcome: {
          kind: 'answered',
          answers: finalAnswers(ctx.task, input.answers),
          ...(summary ? { summary } : {}),
        },
      });
      await hangUpAfterSpeaking(ctx);
      return { ok: true };
    });
  },
});

/**
 * wait_on_hold (#151). The handler has nothing to do: CallSession, seeing
 * startsHold, puts the call on hold once it returns, and takes it off when a
 * person picks up or the limit runs out. Not in callTools: it's offered only
 * where the voice provider can hold (tasks/callSessionAdapter.ts).
 */
export const waitOnHoldTool: VoiceTool<Record<string, never>> = defineVoiceTool({
  name: 'wait_on_hold',
  description:
    'Use this, without saying anything first, as soon as you are in a hold queue: hold music, "please hold", "your call ' +
    'will be answered by the next available…", or an estimated wait time. Also use it when a phone menu says you can ' +
    'remain on the line and you have nothing to enter. Not after each key press, though: a menu goes on to its next ' +
    'prompt by itself, and you answer it faster off hold. You stay on the line silently, and you are told the moment a ' +
    'live person picks up, or handed back as soon as a menu asks you for something. Never use it with a person on the line.',
  schema: z.object({}),
  startsHold: true,
  handler: async () => ({ ok: true }),
});

// Cast is required here: each tool above is a VoiceTool<SpecificInput>, and
// TS's strict function-type contravariance rightly refuses to treat
// VoiceTool<Specific> as a subtype of VoiceTool<unknown> (the input param
// position is contravariant). Bundling heterogeneous, differently-typed
// tools into one array/dispatch table is inherently type-erasing — the
// caller (session/callSession.ts) looks tools up by name and invokes
// `handler(parsedArgs, ctx)` without static knowledge of each tool's exact
// input type, validated instead at runtime via each tool's own Zod schema.
/** The tools only a call that can book gets (tasks/modes.ts's `books`); an ask call never sees them (#148). */
export const bookingCallTools: VoiceTool[] = [
  checkMyAvailabilityTool,
  confirmAppointmentTool,
  undoConfirmedAppointmentTool,
  reportNegotiationFailedTool,
] as VoiceTool[];

/** The tools every outbound call gets. */
export const commonCallTools: VoiceTool[] = [leaveVoicemailAndEndCallTool, escalateAndEndCallTool, endCallTool, noteFollowUpTool] as VoiceTool[];

/** Every tool a call that can book gets: the shared list for tests and tool-definition checks. */
export const callTools: VoiceTool[] = [...bookingCallTools, ...commonCallTools];

export const callToolDefinitions: ToolDefinition[] = callTools.map(toToolDefinition);
