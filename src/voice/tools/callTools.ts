import { z } from 'zod';
import { SlotUnavailableError } from '../../calendar/types.js';
import { config } from '../../config/index.js';
import { childLogger } from '../../lib/logger.js';
import { zonedTimeToUtcIso } from '../../lib/timezone.js';
import { TimeoutError, withTimeout } from '../../lib/withTimeout.js';
import type { CallContext } from '../../session/types.js';
import { getTask, NON_TERMINAL_STATUSES, transitionTask } from '../../tasks/service.js';
import type { TelephonyProvider } from '../../telephony/providers/types.js';
import type { ToolDefinition } from '../types.js';
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
const MAX_HANGUP_WAIT_MS = 6000; // stays comfortably under TOOL_TIMEOUT_MS (default 8000ms) so a long trailing utterance can never blow the enclosing tool call's timeout budget

export async function hangUpAfterSpeaking(ctx: { telephony: TelephonyProvider; callId: string; estimatedAudioDoneAt: number }): Promise<void> {
  const waitMs = Math.min(MAX_HANGUP_WAIT_MS, Math.max(0, ctx.estimatedAudioDoneAt - Date.now()) + HANGUP_SAFETY_MARGIN_MS);
  await sleep(waitMs);
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

export const confirmAppointmentTool: VoiceTool<{
  confirmedStart: string;
  durationMinutes: number;
  details?: string;
}> = defineVoiceTool({
  name: 'confirm_appointment',
  description:
    `Lock in the appointment once both sides have agreed on a specific time. This writes the event to ${config.ASSISTANT_PRINCIPAL_NAME}'s calendar and marks the task confirmed. Only call this once — after you have verbally confirmed the time with the other party. If it fails with error "slot_unavailable", the slot was taken by something else between your availability check and this call — do not treat it as booked; tell the caller and negotiate a different time.`,
  schema: z.object({
    confirmedStart: z
      .string()
      .describe(
        `The agreed appointment start time, as a local date-time WITHOUT a UTC offset (e.g. "2026-08-05T14:00:00") — express it in ${config.CALENDAR_TIMEZONE} local time, do not convert to UTC yourself.`,
      ),
    durationMinutes: z.number().int().positive().describe('The agreed appointment duration, in minutes.'),
    details: z.string().optional().describe('Any additional details worth recording (location, contact name, notes).'),
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

      // Idempotency key is derived server-side from the call attempt id and
      // is NEVER accepted as a model-supplied argument. LLMs are unreliable
      // at generating and consistently reusing idempotency keys across
      // retries (e.g. if this tool call is retried after a transient
      // failure, a model-generated key could differ between attempts,
      // defeating the whole point of idempotency and risking a duplicate
      // calendar event). Keying off ctx.callAttempt.id guarantees the same
      // key is used for every retry within this call attempt.
      const idempotencyKey = `confirm:${ctx.callAttempt.id}`;
      const result = await ctx.calendar.createEventIdempotent({
        idempotencyKey,
        start: startUtcIso,
        durationMinutes: input.durationMinutes,
        summary: ctx.task.goalDescription,
        description: input.details,
      });
      await transitionTask(ctx.task.id, 'confirmed', {
        outcome: {
          kind: 'confirmed',
          start: startUtcIso,
          durationMinutes: input.durationMinutes,
          details: input.details,
        },
        calendarEventId: result.eventId,
      });
      return { ok: true, confirmedStart: result.confirmedStart };
    });
  },
});

export const leaveVoicemailAndEndCallTool: VoiceTool<{ message: string }> = defineVoiceTool({
  name: 'leave_voicemail_and_end_call',
  description:
    'Leave a voicemail message and end the call. Use this when you have reached an answering machine or voicemail system instead of a human. Provide the message as the `message` argument — the system speaks it for you, verbatim, before hanging up. Do NOT say the message yourself first: the callee would hear it twice. A short natural preamble before calling this tool (e.g. reacting to the greeting you just heard) is fine; the message itself is not.',
  schema: z.object({
    message: z
      .string()
      .describe(
        'The exact voicemail message to deliver — concise and natural, including a callback number if one was given to you. This is spoken to the callee verbatim by the system; do not say it yourself beforehand.',
      ),
  }),
  endsCall: true,
  // CallSession forces this to be spoken (VoiceAIProvider.sayVerbatim) and
  // waits for it to finish before this handler ever runs — see
  // VoiceTool.verbatimMessage's doc comment for why. The handler below is
  // unchanged from before that existed: it only records the outcome and
  // hangs up, exactly as its own tests (tests/voice/callTools.test.ts) verify.
  verbatimMessage: (input) => input.message,
  handler: async (input, ctx) => {
    return runToolSafely('leave_voicemail_and_end_call', async () => {
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
    reason: z.string().describe('A short explanation of why no offered time worked.'),
  }),
  endsCall: true,
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

export const escalateAndEndCallTool: VoiceTool<{ reason: string }> = defineVoiceTool({
  name: 'escalate_and_end_call',
  description:
    `Use this when you are genuinely stuck and cannot proceed — e.g. a confusing automated phone menu you cannot navigate, a hostile or uncooperative response, or any situation you cannot resolve on your own. This ends the call and flags the task for human (${config.ASSISTANT_PRINCIPAL_NAME}) follow-up.`,
  schema: z.object({
    reason: z.string().describe('A short explanation of why the call needed to be escalated.'),
  }),
  endsCall: true,
  handler: async (input, ctx) => {
    return runToolSafely('escalate_and_end_call', async () => {
      await transitionTask(ctx.task.id, 'escalated', {
        outcome: { kind: 'escalated', reason: input.reason },
      });
      await hangUpAfterSpeaking(ctx);
      return { ok: true };
    });
  },
});

export const endCallTool: VoiceTool<{ summary?: string }> = defineVoiceTool({
  name: 'end_call',
  description:
    'Call this once you have said everything you need to say and are ready to end the call normally — e.g. right after confirm_appointment has succeeded and you have told the caller the confirmed time. This does NOT itself record any outcome; use it only after an outcome-setting tool (confirm_appointment) has already run, or when there is genuinely nothing more to say and no better-fitting tool applies. leave_voicemail_and_end_call, report_negotiation_failed, and escalate_and_end_call already end the call themselves — do not call end_call after those.',
  schema: z.object({
    summary: z.string().optional().describe('Optional short note about how the call concluded.'),
  }),
  endsCall: true,
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
      // Conversation-mode tasks get end_conversation_call ADDITIVELY
      // alongside this generic tool (see outboundToolsFor in
      // tasks/callSessionAdapter.ts), so the model can and does sometimes
      // reach for end_call to close out a conversation instead. Landing
      // that in 'escalated' mislabels a normal, successful close as
      // something needing Steve's follow-up — caught on a live call where
      // the model's end_call summary was a plain conversation recap, not
      // an escalation reason. Route conversation-mode tasks through the
      // same outcome end_conversation_call would have recorded instead.
      const current = await getTask(ctx.task.id);
      if (current && NON_TERMINAL_STATUSES.includes(current.status)) {
        if (current.mode === 'conversation') {
          await transitionTask(ctx.task.id, 'conversation_completed', {
            outcome: {
              kind: 'conversation_completed',
              summary: input.summary ?? 'Call ended without an explicit summary being recorded.',
            },
          });
        } else {
          await transitionTask(ctx.task.id, 'escalated', {
            outcome: {
              kind: 'escalated',
              reason: input.summary ?? 'Call ended without an explicit outcome being recorded.',
            },
          });
        }
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
    'calls with no booking/negotiation goal.',
  schema: z.object({
    summary: z.string().describe('A short summary of what was discussed/accomplished on this call.'),
  }),
  endsCall: true,
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

// Cast is required here: each tool above is a VoiceTool<SpecificInput>, and
// TS's strict function-type contravariance rightly refuses to treat
// VoiceTool<Specific> as a subtype of VoiceTool<unknown> (the input param
// position is contravariant). Bundling heterogeneous, differently-typed
// tools into one array/dispatch table is inherently type-erasing — the
// caller (session/callSession.ts) looks tools up by name and invokes
// `handler(parsedArgs, ctx)` without static knowledge of each tool's exact
// input type, validated instead at runtime via each tool's own Zod schema.
export const callTools: VoiceTool[] = [
  checkMyAvailabilityTool,
  confirmAppointmentTool,
  leaveVoicemailAndEndCallTool,
  reportNegotiationFailedTool,
  escalateAndEndCallTool,
  endCallTool,
] as VoiceTool[];

export const callToolDefinitions: ToolDefinition[] = callTools.map(toToolDefinition);
