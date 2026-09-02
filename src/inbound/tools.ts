import { z } from 'zod';
import { SlotUnavailableError } from '../calendar/types.js';
import { config } from '../config/index.js';
import { childLogger } from '../lib/logger.js';
import { formatInZone } from '../lib/timezone.js';
import { sendOwnerSms } from '../notifications/twilioSms.js';
import { combineDateTimeToIso, hangUpAfterSpeaking, runToolSafely } from '../voice/tools/callTools.js';
import { defineVoiceTool, toToolDefinition, type VoiceTool } from '../voice/tools/defineVoiceTool.js';
import type { ToolDefinition } from '../voice/types.js';
import { businessHoursFromConfig, intersectWithBusinessHours, isWithinBusinessHours } from './businessHours.js';
import { ActiveBookingConflictError, createBooking, E164_PATTERN, findActiveBookingForCaller, supersedeBooking } from './service.js';
import type { InboundCallContext } from './types.js';

const log = childLogger({ module: 'inbound.tools' });

/**
 * Refuses to let book_appointment/reschedule_booking write anything for a
 * caller identity findActiveBookingForCaller (service.ts) could never
 * resolve on read in the first place — a non-E.164 placeholder like
 * Twilio's "anonymous" (sent for a withheld/blocked caller ID). Without
 * this, two different anonymous callers would each pass
 * findActiveBookingForCaller's pre-check (it finds nothing for either,
 * since it refuses to query a non-E.164 value), both create a real
 * calendar event, and only the second one's DB insert would fail against
 * the one-active-per-caller partial unique index — after its calendar
 * event was already created and left orphaned. An anonymous caller can
 * never look up or manage a booking anyway (find_my_booking/
 * reschedule_booking can never find anything for it), so the correct fix
 * is refusing to WRITE one for that identity at all, not just hiding it on
 * read.
 */
const CALLER_ID_UNAVAILABLE_FAILURE = {
  ok: false as const,
  error: 'caller_id_unavailable' as const,
  message: "Your caller ID isn't available, so a booking can't be made or managed on this line. Please call from a number that isn't blocked or withheld.",
};

/**
 * Renders a booking's confirmedStart (a Date, always stored/produced as a
 * UTC instant) as the offset-less CALENDAR_TIMEZONE local-time string the
 * model expects — see formatInZone's doc comment (src/lib/timezone.ts) for
 * why a raw `.toISOString()` UTC string must never be handed to the model
 * directly.
 */
function formatStartForModel(confirmedStart: Date): string {
  return formatInZone(confirmedStart.toISOString(), config.CALENDAR_TIMEZONE);
}

/**
 * Picks `count` items evenly spread across `items` (always including the
 * first and last) rather than the first `count` in order. suggest_times'
 * candidate windows come back in chronological order from
 * chunkIntoWindows (googleCalendarProvider.ts) — on a wide-open day, a
 * bare slice(0, count) returned nothing but consecutive early-morning
 * slots, and the model had no way to know later slots existed at all, so
 * it told callers only mornings were free.
 */
function spreadSample<T>(items: T[], count: number): T[] {
  if (items.length <= count || count <= 1) return items.slice(0, count);
  const step = (items.length - 1) / (count - 1);
  const indices = new Set(Array.from({ length: count }, (_, i) => Math.round(i * step)));
  return [...indices].map((i) => items[i]!);
}

function durationOrDefault(input?: number): number {
  return input ?? config.INBOUND_DEFAULT_DURATION_MINUTES;
}

type LookaheadFailure = { ok: false; error: 'in_the_past' | 'beyond_lookahead_window'; message: string };

/**
 * Guards book_appointment/reschedule_booking against a start time that has
 * already elapsed, or one too far in the future — isWithinBusinessHours
 * (businessHours.ts) only checks weekday/hour-of-day, with no now-relative
 * comparison at all, so without this a caller could book (or reschedule
 * into) a date years out, or even one already in the past, as long as it
 * happens to fall within business hours. Named as two distinct errors
 * ('in_the_past' vs 'beyond_lookahead_window') rather than collapsing them
 * into one, matching this file's existing convention of one specific,
 * distinctly-named error per distinct failure condition (see
 * 'already_has_active_booking', 'outside_business_hours', 'no_active_booking',
 * etc. below) so the model gets an unambiguous reason to relay to the caller.
 */
function checkLookaheadWindow(startUtcIso: string): LookaheadFailure | null {
  const startMs = Date.parse(startUtcIso);
  const now = Date.now();
  if (startMs < now) {
    return { ok: false, error: 'in_the_past', message: 'That time has already passed.' };
  }
  const lookaheadMs = config.INBOUND_MAX_LOOKAHEAD_DAYS * 24 * 60 * 60_000;
  if (startMs - now > lookaheadMs) {
    return { ok: false, error: 'beyond_lookahead_window', message: `Only bookable up to ${config.INBOUND_MAX_LOOKAHEAD_DAYS} days out.` };
  }
  return null;
}

export const checkAvailabilityTool: VoiceTool<
  { date: string; time: string; durationMinutes?: number },
  InboundCallContext
> = defineVoiceTool({
  name: 'check_availability',
  description:
    'Check whether a specific date and time the caller is proposing is free on the calendar and within business hours. Use this before agreeing to any specific time.',
  schema: z.object({
    date: z.string().describe('The calendar date being proposed, e.g. "2026-08-11".'),
    time: z.string().describe(`The time of day being proposed, e.g. "14:30" (24h) or "2:30pm", in ${config.CALENDAR_TIMEZONE} local time.`),
    durationMinutes: z.number().int().positive().optional().describe(`How long the appointment would last, in minutes. Defaults to ${config.INBOUND_DEFAULT_DURATION_MINUTES} if not given.`),
  }),
  handler: async (input, ctx) => {
    return runToolSafely('check_availability', async () => {
      const durationMinutes = durationOrDefault(input.durationMinutes);
      const start = combineDateTimeToIso(input.date, input.time);
      if (!isWithinBusinessHours(start, durationMinutes, businessHoursFromConfig())) {
        return { free: false, reason: 'outside_business_hours' };
      }
      const free = await ctx.calendar.isFree({ start, durationMinutes });
      return { free };
    });
  },
});

export const suggestTimesTool: VoiceTool<{ date: string; durationMinutes?: number }, InboundCallContext> = defineVoiceTool({
  name: 'suggest_times',
  description:
    'Suggest a few open times on a specific day, within business hours, when the caller does not have a specific time in mind yet.',
  schema: z.object({
    date: z.string().describe('The calendar date the caller is asking about, e.g. "2026-08-11".'),
    durationMinutes: z.number().int().positive().optional().describe(`How long the appointment would need to be, in minutes. Defaults to ${config.INBOUND_DEFAULT_DURATION_MINUTES} if not given.`),
  }),
  handler: async (input, ctx) => {
    return runToolSafely('suggest_times', async () => {
      const durationMinutes = durationOrDefault(input.durationMinutes);
      const hours = businessHoursFromConfig();
      const dayStartUtc = combineDateTimeToIso(input.date, '00:00');
      const dayEndUtc = combineDateTimeToIso(input.date, '23:59');

      // Checked against dayEndUtc, not dayStartUtc: a request for "today"
      // must not be rejected wholesale merely because midnight has already
      // passed — only a day that has ENTIRELY elapsed (its end already in
      // the past) should trip checkLookaheadWindow's 'in_the_past' branch
      // here. Slots that have merely already elapsed so far today are
      // filtered out below on a per-window basis instead, so "today, later"
      // requests still return whatever's left of the day.
      const lookaheadFailure = checkLookaheadWindow(dayEndUtc);
      if (lookaheadFailure) return lookaheadFailure;

      const candidates = await ctx.calendar.computeCandidateWindows({
        dateWindows: [{ start: dayStartUtc, end: dayEndUtc }],
        durationMinutes,
      });
      const withinHours = intersectWithBusinessHours(candidates, hours);
      // intersectWithBusinessHours only checks weekday/hour-of-day, with no
      // now-relative comparison — without this, a "today" request made
      // late in the day could return slots earlier today that have already
      // passed.
      const notYetElapsed = withinHours.filter((window) => Date.parse(window.start) > Date.now());
      const times = spreadSample(notYetElapsed, 5).map((window) => ({
        start: formatInZone(window.start, config.CALENDAR_TIMEZONE),
        end: formatInZone(window.end, config.CALENDAR_TIMEZONE),
      }));
      return { times };
    });
  },
});

export const bookAppointmentTool: VoiceTool<
  { date: string; time: string; durationMinutes?: number; purpose: string; callerName: string },
  InboundCallContext
> = defineVoiceTool({
  name: 'book_appointment',
  description:
    'Lock in a new appointment once a specific time has been agreed with the caller. Fails with "already_has_active_booking" if this caller already has one — offer reschedule_booking instead of retrying. Fails with "outside_business_hours" or "slot_unavailable" if the time does not work; offer a different time rather than retrying the same one. Fails with "in_the_past" or "beyond_lookahead_window" if the requested date is out of the bookable range; offer a different date. Fails with "caller_id_unavailable" if the caller\'s number is blocked/withheld — this line cannot take a booking without a real caller ID.',
  schema: z.object({
    date: z.string().describe('The agreed appointment date, e.g. "2026-08-11".'),
    time: z.string().describe(`The agreed time of day, e.g. "14:30" (24h) or "2:30pm", in ${config.CALENDAR_TIMEZONE} local time.`),
    durationMinutes: z.number().int().positive().optional().describe(`The agreed appointment duration, in minutes. Defaults to ${config.INBOUND_DEFAULT_DURATION_MINUTES} if not given.`),
    purpose: z.string().describe('A short description of what the appointment is for, as stated by the caller.'),
    callerName: z.string().describe("The caller's name, as they gave it."),
  }),
  handler: async (input, ctx) => {
    return runToolSafely('book_appointment', async () => {
      // Checked first, before any calendar or DB call — an anonymous/
      // blocked caller ID can never look up or manage a booking anyway
      // (findActiveBookingForCaller refuses to match one), so refuse to
      // create one for that identity too, rather than letting it slip
      // past this pre-check and fail messily against the DB's
      // one-active-per-caller constraint after already creating a real
      // calendar event. See CALLER_ID_UNAVAILABLE_FAILURE's doc comment.
      if (!E164_PATTERN.test(ctx.callerPhoneNumber)) return CALLER_ID_UNAVAILABLE_FAILURE;

      const existing = await findActiveBookingForCaller(ctx.callerPhoneNumber);
      if (existing) {
        return {
          ok: false,
          error: 'already_has_active_booking' as const,
          existingBooking: { start: formatStartForModel(existing.confirmedStart), durationMinutes: existing.durationMinutes },
        };
      }

      const durationMinutes = durationOrDefault(input.durationMinutes);
      const startUtcIso = combineDateTimeToIso(input.date, input.time);

      const lookaheadFailure = checkLookaheadWindow(startUtcIso);
      if (lookaheadFailure) return lookaheadFailure;

      if (!isWithinBusinessHours(startUtcIso, durationMinutes, businessHoursFromConfig())) {
        return { ok: false, error: 'outside_business_hours' as const, message: 'That time is outside business hours.' };
      }

      // Idempotency key is derived server-side from the inbound call id,
      // never accepted as a model-supplied argument — same reasoning as
      // confirm_appointment's idempotencyKey (see voice/tools/callTools.ts).
      const idempotencyKey = `inbound-book:${ctx.inboundCallId}`;
      const result = await ctx.calendar.createEventIdempotent({
        idempotencyKey,
        start: startUtcIso,
        durationMinutes,
        summary: input.purpose,
        description: `Booked by ${input.callerName} via phone.`,
      });

      let booking;
      try {
        booking = await createBooking({
          inboundCallId: ctx.inboundCallId,
          callerPhoneNumber: ctx.callerPhoneNumber,
          calendarEventId: result.eventId,
          confirmedStart: result.confirmedStart,
          durationMinutes,
          purpose: input.purpose,
          callerName: input.callerName,
        });
      } catch (err) {
        if (err instanceof ActiveBookingConflictError) {
          // The application-level pre-check above passed (no active
          // booking existed yet), but the database's partial unique index
          // rejected the insert anyway — a retried book_appointment call
          // (after a client-perceived timeout) raced another insert for
          // the same caller and lost. Re-fetch whichever booking actually
          // won so the caller still gets its real details, and report the
          // same shape the pre-check branch above already returns.
          const winner = await findActiveBookingForCaller(ctx.callerPhoneNumber);
          return {
            ok: false,
            error: 'already_has_active_booking' as const,
            existingBooking: winner ? { start: formatStartForModel(winner.confirmedStart), durationMinutes: winner.durationMinutes } : undefined,
          };
        }
        throw err;
      }

      // Fire-and-forget, matching src/server.ts's session.start().catch(...)
      // pattern — this is a courtesy notification to the assistant's owner, not something
      // the caller needs to hear about. Awaiting it here would make the
      // caller wait on an SMS API round-trip on top of the calendar/DB work
      // already done, beyond what the one stalling phrase before this tool
      // call was meant to cover — extra dead air on a live call risks the
      // caller hanging up before ever hearing the confirmation they're
      // actually waiting for.
      sendOwnerSms(
        `New inbound booking: ${booking.confirmedStart.toLocaleString('en-US', { timeZone: config.CALENDAR_TIMEZONE })} (${booking.durationMinutes} min) — ${booking.purpose}. Caller: ${ctx.callerPhoneNumber}.`,
      ).catch((err) => log.error({ err }, 'book_appointment: sendOwnerSms failed'));

      return { ok: true, confirmedStart: formatStartForModel(booking.confirmedStart) };
    });
  },
});

// No booking-ID parameter — this can only ever resolve to whoever is
// calling right now's own booking (ctx.callerPhoneNumber, derived from
// Twilio's From field). This is the structural half of the security
// boundary described in docs/superpowers/specs/2026-08-07-inbound-voice-booking-design.md.
export const findMyBookingTool: VoiceTool<Record<string, never>, InboundCallContext> = defineVoiceTool({
  name: 'find_my_booking',
  description:
    "Look up the current caller's own active booking, if any. Takes no arguments — it always looks up whoever is calling right now. The result includes callerName, the name already on file from when the booking was made — read it back to the caller to confirm identity rather than asking them to restate their name.",
  schema: z.object({}),
  handler: async (_input, ctx) => {
    return runToolSafely('find_my_booking', async () => {
      const booking = await findActiveBookingForCaller(ctx.callerPhoneNumber);
      if (!booking) return { found: false };
      return {
        found: true,
        start: formatStartForModel(booking.confirmedStart),
        durationMinutes: booking.durationMinutes,
        purpose: booking.purpose,
        callerName: booking.callerName,
      };
    });
  },
});

// No booking-ID parameter for the same structural reason as
// find_my_booking above — the model can only trigger "reschedule whoever is
// calling right now's own active booking," never name an arbitrary one.
export const rescheduleBookingTool: VoiceTool<{ date: string; time: string }, InboundCallContext> = defineVoiceTool({
  name: 'reschedule_booking',
  description:
    "Move the current caller's own active booking to a new date/time. The name on the booking carries over automatically — do not ask the caller for their name again. Fails with \"no_active_booking\" if they don't have one — direct them to book_appointment instead. Fails with \"outside_business_hours\" or \"slot_unavailable\" if the new time does not work; their original booking is left untouched in that case. Fails with \"in_the_past\" or \"beyond_lookahead_window\" if the requested date is out of the bookable range; their original booking is left untouched in that case too. Fails with \"caller_id_unavailable\" if the caller's number is blocked/withheld — this line cannot look up or manage a booking without a real caller ID.",
  schema: z.object({
    date: z.string().describe('The new date for the appointment, e.g. "2026-08-12".'),
    time: z.string().describe(`The new time of day, e.g. "15:00" (24h) or "3pm", in ${config.CALENDAR_TIMEZONE} local time.`),
  }),
  handler: async (input, ctx) => {
    return runToolSafely('reschedule_booking', async () => {
      // Same reasoning as book_appointment's guard above — checked first,
      // before any calendar or DB call.
      if (!E164_PATTERN.test(ctx.callerPhoneNumber)) return CALLER_ID_UNAVAILABLE_FAILURE;

      const existing = await findActiveBookingForCaller(ctx.callerPhoneNumber);
      if (!existing) {
        return { ok: false, error: 'no_active_booking' as const, message: 'No active booking was found for this number.' };
      }

      const newStartUtcIso = combineDateTimeToIso(input.date, input.time);

      const lookaheadFailure = checkLookaheadWindow(newStartUtcIso);
      if (lookaheadFailure) return lookaheadFailure;

      if (!isWithinBusinessHours(newStartUtcIso, existing.durationMinutes, businessHoursFromConfig())) {
        return { ok: false, error: 'outside_business_hours' as const, message: 'That time is outside business hours.' };
      }

      // isFree check BEFORE touching the old event — if the new slot isn't
      // free, the existing booking must be left completely untouched. See
      // the design spec's "security boundary" / order-of-operations note.
      const free = await ctx.calendar.isFree({ start: newStartUtcIso, durationMinutes: existing.durationMinutes });
      if (!free) {
        return { ok: false, error: 'slot_unavailable' as const, message: 'That time is no longer available.' };
      }

      try {
        await ctx.calendar.deleteEvent(existing.calendarEventId);

        const idempotencyKey = `inbound-reschedule:${existing.id}:${newStartUtcIso}`;
        const result = await ctx.calendar.createEventIdempotent({
          idempotencyKey,
          start: newStartUtcIso,
          durationMinutes: existing.durationMinutes,
          summary: existing.purpose,
          description: `Booked by ${existing.callerName} via phone.`,
        });

        const superseded = await supersedeBooking(existing.id, {
          inboundCallId: ctx.inboundCallId,
          callerPhoneNumber: ctx.callerPhoneNumber,
          calendarEventId: result.eventId,
          confirmedStart: result.confirmedStart,
          durationMinutes: existing.durationMinutes,
          purpose: existing.purpose,
          callerName: existing.callerName,
        });

        // Fire-and-forget — see book_appointment's identical comment above.
        sendOwnerSms(
          `Inbound reschedule: ${superseded.confirmedStart.toLocaleString('en-US', { timeZone: config.CALENDAR_TIMEZONE })} (${superseded.durationMinutes} min) — ${superseded.purpose}. Caller: ${ctx.callerPhoneNumber}.`,
        ).catch((err) => log.error({ err }, 'reschedule_booking: sendOwnerSms failed'));

        return { ok: true, confirmedStart: formatStartForModel(superseded.confirmedStart) };
      } catch (err) {
        if (err instanceof SlotUnavailableError) {
          return { ok: false, error: 'slot_unavailable' as const, message: err.message };
        }
        throw err;
      }
    });
  },
});

export const endCallTool: VoiceTool<{ summary?: string }, InboundCallContext> = defineVoiceTool({
  name: 'end_call',
  description:
    'Call this once you have said everything you need to say and are ready to end the call normally — e.g. right after book_appointment or reschedule_booking has succeeded and you have told the caller the confirmed details.',
  schema: z.object({
    summary: z.string().optional().describe('Optional short note about how the call concluded.'),
  }),
  endsCall: true,
  handler: async (_input, ctx) => {
    return runToolSafely('end_call', async () => {
      await hangUpAfterSpeaking(ctx);
      return { ok: true };
    });
  },
});

export const flagForOwnerAndEndCallTool: VoiceTool<{ reason: string }, InboundCallContext> = defineVoiceTool({
  name: 'flag_for_owner_and_end_call',
  description:
    "Use this when you are genuinely stuck and cannot proceed — a request outside what your tools support, a hostile or nonsensical caller, or anything you cannot resolve on your own. Texts the assistant's owner and ends the call.",
  schema: z.object({
    reason: z.string().describe('A short explanation of why the call needed to be flagged.'),
  }),
  endsCall: true,
  handler: async (input, ctx) => {
    return runToolSafely('flag_for_owner_and_end_call', async () => {
      await sendOwnerSms(`Inbound call from ${ctx.callerPhoneNumber} needs your attention: ${input.reason}`);
      await hangUpAfterSpeaking(ctx);
      return { ok: true };
    });
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inboundTools: VoiceTool<any, InboundCallContext>[] = [
  checkAvailabilityTool,
  suggestTimesTool,
  bookAppointmentTool,
  findMyBookingTool,
  rescheduleBookingTool,
  endCallTool,
  flagForOwnerAndEndCallTool,
] as VoiceTool<any, InboundCallContext>[];

export const inboundToolDefinitions: ToolDefinition[] = inboundTools.map(toToolDefinition);
