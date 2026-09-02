import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProvider } from '../../src/calendar/types.js';
import { SlotUnavailableError } from '../../src/calendar/types.js';
import type { InboundCallContext } from '../../src/inbound/types.js';
import type { InboundBooking } from '../../src/inbound/schema.js';

const findActiveBookingForCaller = vi.fn<(callerPhoneNumber: string) => Promise<InboundBooking | undefined>>();
const createBooking = vi.fn();
const supersedeBooking = vi.fn();
// Real class (not a plain vi.fn mock) so `err instanceof ActiveBookingConflictError`
// in book_appointment's handler (src/inbound/tools.ts) behaves correctly.
class ActiveBookingConflictError extends Error {}
// Same literal as service.ts's real E164_PATTERN — tools.ts imports this
// from service.js (mocked here), so the mock must supply the real regex,
// not a stand-in, for the caller-ID-unavailable guard tests below to mean
// anything.
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
vi.mock('../../src/inbound/service.js', () => ({
  findActiveBookingForCaller,
  createBooking,
  supersedeBooking,
  ActiveBookingConflictError,
  E164_PATTERN,
}));

const sendOwnerSms = vi.fn(async () => {});
vi.mock('../../src/notifications/twilioSms.js', () => ({ sendOwnerSms }));

const {
  bookAppointmentTool,
  findMyBookingTool,
  rescheduleBookingTool,
  suggestTimesTool,
  inboundToolDefinitions,
} = await import('../../src/inbound/tools.js');

const CALLER = '+15555550100';

function makeContext(calendar: CalendarProvider, callerPhoneNumber: string = CALLER): InboundCallContext {
  return {
    inboundCallId: 'inbound-call-1',
    callId: 'CA-fake-sid',
    callerPhoneNumber,
    telephony: {
      name: 'fake-telephony',
      nativeAudioFormat: 'g711_ulaw_8k',
      originateCall: vi.fn(),
      sendAudio: vi.fn(),
      sendDigits: vi.fn(),
      interrupt: vi.fn(),
      hangUp: vi.fn(async () => {}),
      on: vi.fn(),
      off: vi.fn(),
    },
    calendar,
    estimatedAudioDoneAt: Date.now(),
  };
}

const fakeCalendar = (overrides: Partial<CalendarProvider> = {}): CalendarProvider => ({
  computeCandidateWindows: vi.fn(async () => []),
  isFree: vi.fn(async () => true),
  createEventIdempotent: vi.fn(async () => ({
    eventId: 'evt-new',
    confirmedStart: '2026-08-11T18:00:00.000Z',
    confirmedEnd: '2026-08-11T18:30:00.000Z',
  })),
  deleteEvent: vi.fn(async () => {}),
  ...overrides,
});

const EXISTING_BOOKING = {
  id: 'booking-1',
  inboundCallId: 'inbound-call-0',
  callerPhoneNumber: CALLER,
  calendarEventId: 'evt-old',
  confirmedStart: new Date('2026-08-10T18:00:00.000Z'),
  durationMinutes: 30,
  purpose: 'Consultation',
  callerName: 'Jamie Rivera',
  status: 'active' as const,
  previousBookingId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Freezes "now" for every test in this file, not just the lookahead-window
// describe block below. book_appointment/reschedule_booking's
// checkLookaheadWindow (src/inbound/tools.ts) rejects any date that's
// already in the past relative to the real wall clock — without this, every
// test elsewhere in this file that hardcodes a fixed future-at-the-time date
// (e.g. '2026-08-11') would start failing with an unrelated 'in_the_past'
// error the moment real time actually passes that date, well before its
// intended assertions (isFree/slot_unavailable/success paths) are ever
// reached. FROZEN_NOW is chosen earlier than every hardcoded date used
// anywhere in this file, so those dates stay valid regardless of when the
// suite actually runs.
const FROZEN_NOW = new Date('2026-08-08T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reschedule_booking (security boundary)', () => {
  it("has no booking-ID-like parameter in its JSON Schema — it can only act on the current caller's own booking", () => {
    const def = inboundToolDefinitions.find((d) => d.name === 'reschedule_booking');
    expect(def).toBeDefined();
    const properties = (def!.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties).not.toHaveProperty('id');
    expect(properties).not.toHaveProperty('bookingId');
    expect(properties).not.toHaveProperty('inboundCallId');
  });

  it('find_my_booking takes no arguments', () => {
    const def = inboundToolDefinitions.find((d) => d.name === 'find_my_booking');
    expect(def).toBeDefined();
    const properties = (def!.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties)).toHaveLength(0);
  });
});

describe('rescheduleBookingTool.handler', () => {
  it('returns no_active_booking when the caller has nothing to reschedule', async () => {
    findActiveBookingForCaller.mockResolvedValue(undefined);
    const calendar = fakeCalendar();

    const result = await rescheduleBookingTool.handler({ date: '2026-08-11', time: '14:00' }, makeContext(calendar));

    expect(result).toMatchObject({ ok: false, error: 'no_active_booking' });
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    expect(supersedeBooking).not.toHaveBeenCalled();
  });

  it('leaves the old booking untouched when the new slot is unavailable', async () => {
    findActiveBookingForCaller.mockResolvedValue(EXISTING_BOOKING);
    const calendar = fakeCalendar({ isFree: vi.fn(async () => false) });

    const result = await rescheduleBookingTool.handler({ date: '2026-08-11', time: '14:00' }, makeContext(calendar));

    expect(result).toMatchObject({ ok: false, error: 'slot_unavailable' });
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    expect(supersedeBooking).not.toHaveBeenCalled();
  });

  it('deletes the old event and supersedes the booking on success', async () => {
    findActiveBookingForCaller.mockResolvedValue(EXISTING_BOOKING);
    supersedeBooking.mockResolvedValue({ ...EXISTING_BOOKING, id: 'booking-2', confirmedStart: new Date('2026-08-11T18:00:00.000Z') });
    const calendar = fakeCalendar();

    const result = await rescheduleBookingTool.handler({ date: '2026-08-11', time: '14:00' }, makeContext(calendar));

    expect(calendar.deleteEvent).toHaveBeenCalledWith('evt-old');
    expect(supersedeBooking).toHaveBeenCalledWith(
      'booking-1',
      expect.objectContaining({ callerPhoneNumber: CALLER, calendarEventId: 'evt-new' }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(sendOwnerSms).toHaveBeenCalledTimes(1);
  });

  it('does not make the caller wait on the Steve-notification SMS before hearing the reschedule confirmation', async () => {
    findActiveBookingForCaller.mockResolvedValue(EXISTING_BOOKING);
    supersedeBooking.mockResolvedValue({ ...EXISTING_BOOKING, id: 'booking-2', confirmedStart: new Date('2026-08-11T18:00:00.000Z') });
    const calendar = fakeCalendar();
    sendOwnerSms.mockImplementation(() => new Promise(() => {})); // never resolves

    const result = await rescheduleBookingTool.handler({ date: '2026-08-11', time: '14:00' }, makeContext(calendar));

    expect(result).toMatchObject({ ok: true });
    expect(sendOwnerSms).toHaveBeenCalledTimes(1);
  });

  it("includes the caller's name in the calendar event description", async () => {
    // Same pattern Task 5 already established for book_appointment — a
    // reschedule must not lose the caller's name off the calendar event
    // just because the phone number, not the name, is the security key.
    findActiveBookingForCaller.mockResolvedValue(EXISTING_BOOKING);
    supersedeBooking.mockResolvedValue({ ...EXISTING_BOOKING, id: 'booking-2', confirmedStart: new Date('2026-08-11T18:00:00.000Z') });
    const calendar = fakeCalendar();

    await rescheduleBookingTool.handler({ date: '2026-08-11', time: '14:00' }, makeContext(calendar));

    expect(calendar.createEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Booked by Jamie Rivera via phone.' }),
    );
  });

  it('does not require a callerName argument — the name carries over from the existing booking, not a fresh ask', () => {
    const parsed = rescheduleBookingTool.schema.safeParse({ date: '2026-08-11', time: '14:00' });
    expect(parsed.success).toBe(true);
  });

  it("carries the existing booking's callerName forward into the superseding row and the calendar event, without taking it as input", async () => {
    findActiveBookingForCaller.mockResolvedValue(EXISTING_BOOKING);
    supersedeBooking.mockResolvedValue({ ...EXISTING_BOOKING, id: 'booking-2', confirmedStart: new Date('2026-08-11T18:00:00.000Z') });
    const calendar = fakeCalendar();

    await rescheduleBookingTool.handler({ date: '2026-08-11', time: '14:00' }, makeContext(calendar));

    expect(calendar.createEventIdempotent).toHaveBeenCalledWith(expect.objectContaining({ description: 'Booked by Jamie Rivera via phone.' }));
    expect(supersedeBooking).toHaveBeenCalledWith('booking-1', expect.objectContaining({ callerName: 'Jamie Rivera' }));
  });

  it('refuses a non-E.164 caller (e.g. Twilio\'s "anonymous" placeholder for a withheld caller ID) without touching the calendar or the database', async () => {
    // findActiveBookingForCaller would refuse to match "anonymous" against
    // anything anyway, so an anonymous caller can never look up or manage
    // a booking through this line — but without this guard, the handler
    // would still fall through to findActiveBookingForCaller, get
    // `undefined`, and report a slightly-misleading "no_active_booking"
    // instead of the real reason. More importantly, book_appointment's
    // equivalent guard (tested below) is the one that actually prevents
    // data corruption; this test exists to confirm reschedule_booking
    // fails the same clean way, symmetrically, before any I/O.
    const calendar = fakeCalendar();

    const result = await rescheduleBookingTool.handler({ date: '2026-08-11', time: '14:00' }, makeContext(calendar, 'anonymous'));

    expect(result).toMatchObject({ ok: false, error: 'caller_id_unavailable' });
    expect(findActiveBookingForCaller).not.toHaveBeenCalled();
    expect(calendar.isFree).not.toHaveBeenCalled();
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    expect(calendar.createEventIdempotent).not.toHaveBeenCalled();
    expect(supersedeBooking).not.toHaveBeenCalled();
  });
});

describe('bookAppointmentTool.handler', () => {
  it('refuses without touching the calendar when the caller already has an active booking', async () => {
    findActiveBookingForCaller.mockResolvedValue(EXISTING_BOOKING);
    const calendar = fakeCalendar();

    const result = await bookAppointmentTool.handler(
      { date: '2026-08-11', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendar),
    );

    expect(result).toMatchObject({ ok: false, error: 'already_has_active_booking' });
    expect(calendar.createEventIdempotent).not.toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('books and notifies Steve when the caller has no active booking', async () => {
    findActiveBookingForCaller.mockResolvedValue(undefined);
    createBooking.mockResolvedValue({ ...EXISTING_BOOKING, id: 'booking-3', calendarEventId: 'evt-new' });
    const calendar = fakeCalendar();

    const result = await bookAppointmentTool.handler(
      { date: '2026-08-11', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendar),
    );

    expect(result).toMatchObject({ ok: true });
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(sendOwnerSms).toHaveBeenCalledTimes(1);
  });

  it('does not make the caller wait on the Steve-notification SMS before hearing the booking confirmation', async () => {
    // Regression test for a real call: sendOwnerSms was awaited before the
    // tool returned, so the confirmation the caller actually needs to hear
    // was gated behind an SMS API round-trip on top of the calendar/DB
    // work — extra silent dead air beyond what the one stalling phrase
    // ("let me finish booking...") was meant to cover, on a live call where
    // every extra second of silence risks the caller hanging up early
    // (matches this codebase's own established fire-and-forget pattern for
    // exactly this "notify without blocking the live thing" concern — see
    // server.ts's session.start().catch(...)).
    findActiveBookingForCaller.mockResolvedValue(undefined);
    createBooking.mockResolvedValue({ ...EXISTING_BOOKING, id: 'booking-3', calendarEventId: 'evt-new' });
    const calendar = fakeCalendar();
    sendOwnerSms.mockImplementation(() => new Promise(() => {})); // never resolves

    const result = await bookAppointmentTool.handler(
      { date: '2026-08-11', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendar),
    );

    expect(result).toMatchObject({ ok: true });
    expect(sendOwnerSms).toHaveBeenCalledTimes(1);
  });

  it("includes the caller's name in the calendar event description", async () => {
    findActiveBookingForCaller.mockResolvedValue(undefined);
    createBooking.mockResolvedValue({ ...EXISTING_BOOKING, id: 'booking-4', calendarEventId: 'evt-new' });
    const calendar = fakeCalendar();

    await bookAppointmentTool.handler(
      { date: '2026-08-11', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendar),
    );

    expect(calendar.createEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Booked by Jamie Rivera via phone.' }),
    );
  });

  it('requires callerName at the schema level', () => {
    const withoutName = bookAppointmentTool.schema.safeParse({ date: '2026-08-11', time: '14:00', purpose: 'Consultation' });
    expect(withoutName.success).toBe(false);
    const withName = bookAppointmentTool.schema.safeParse({ date: '2026-08-11', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' });
    expect(withName.success).toBe(true);
  });

  it('returns confirmedStart as a CALENDAR_TIMEZONE local-time string, never a raw UTC "Z" timestamp', async () => {
    // Regression check for the same failure class as the 4-hour-off booking
    // incident: buildBaseSystemPromptGuidance tells the model every
    // date/time it discusses is CALENDAR_TIMEZONE local time and NOT to
    // convert to UTC itself — handing back a `Z`-suffixed string would force
    // exactly that conversion.
    findActiveBookingForCaller.mockResolvedValue(undefined);
    createBooking.mockResolvedValue({
      ...EXISTING_BOOKING,
      id: 'booking-3',
      calendarEventId: 'evt-new',
      confirmedStart: new Date('2026-08-11T18:00:00.000Z'),
    });
    const calendar = fakeCalendar();

    const result = await bookAppointmentTool.handler(
      { date: '2026-08-11', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendar),
    );

    // 18:00 UTC on 2026-08-11 is 14:00 EDT (America/New_York, the default
    // CALENDAR_TIMEZONE) — offset-less, no trailing "Z".
    expect(result).toMatchObject({ ok: true, confirmedStart: '2026-08-11T14:00:00' });
    expect((result as { confirmedStart: string }).confirmedStart).not.toMatch(/Z$/);
  });

  it('translates a database-level active-booking conflict into the same already_has_active_booking shape as the pre-check', async () => {
    // Simulates the pre-check (findActiveBookingForCaller) racing a
    // concurrent insert for the same caller: it finds nothing the first
    // time, but the DB's partial unique index (schema.ts) rejects the
    // insert anyway. The handler should report the same shape as the
    // pre-check branch, using whichever booking actually won, rather than
    // an opaque upstream_error.
    findActiveBookingForCaller.mockResolvedValueOnce(undefined).mockResolvedValueOnce(EXISTING_BOOKING);
    createBooking.mockRejectedValue(new ActiveBookingConflictError());
    const calendar = fakeCalendar();

    const result = await bookAppointmentTool.handler(
      { date: '2026-08-11', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendar),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'already_has_active_booking',
      existingBooking: { durationMinutes: EXISTING_BOOKING.durationMinutes },
    });
    expect(findActiveBookingForCaller).toHaveBeenCalledTimes(2);
    expect(sendOwnerSms).not.toHaveBeenCalled();
  });

  it('returns slot_unavailable rather than throwing if the calendar refuses a double-booked slot', async () => {
    findActiveBookingForCaller.mockResolvedValue(undefined);
    const calendar = fakeCalendar({
      createEventIdempotent: vi.fn(async () => {
        throw new SlotUnavailableError();
      }),
    });

    const result = await bookAppointmentTool.handler(
      { date: '2026-08-11', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendar),
    );

    expect(result).toMatchObject({ ok: false, error: 'slot_unavailable' });
  });

  it('refuses a non-E.164 caller (e.g. Twilio\'s "anonymous" placeholder for a withheld caller ID) without touching the calendar or the database', async () => {
    const calendar = fakeCalendar();

    const result = await bookAppointmentTool.handler(
      { date: '2026-08-11', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendar, 'anonymous'),
    );

    expect(result).toMatchObject({ ok: false, error: 'caller_id_unavailable' });
    expect(findActiveBookingForCaller).not.toHaveBeenCalled();
    expect(calendar.createEventIdempotent).not.toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
    expect(sendOwnerSms).not.toHaveBeenCalled();
  });

  it('gives two DIFFERENT anonymous callers the same clean rejection, instead of the pre-fix bug where the second one got a nonsensical already_has_active_booking with no existingBooking data', async () => {
    // This is the regression scenario itself, not just the guard in
    // isolation: before this fix, findActiveBookingForCaller("anonymous")
    // returned undefined for BOTH callers (it refuses to query a non-E.164
    // value at all), so both passed the pre-check, both would have hit
    // the calendar, and only the second caller's createBooking would have
    // failed against the DB's one-active-per-caller partial unique index
    // — surfacing as `{ ok: false, error: 'already_has_active_booking',
    // existingBooking: undefined }` once the post-conflict re-fetch also
    // came back empty. With the guard, neither caller ever reaches
    // findActiveBookingForCaller, createEventIdempotent, or createBooking
    // at all — both get the same clear, honest failure instead.
    const calendarForCallerOne = fakeCalendar();
    const resultOne = await bookAppointmentTool.handler(
      { date: '2026-08-11', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendarForCallerOne, 'anonymous'),
    );

    const calendarForCallerTwo = fakeCalendar();
    const resultTwo = await bookAppointmentTool.handler(
      { date: '2026-08-12', time: '15:00', purpose: 'A different consultation', callerName: 'Alex Chen' },
      makeContext(calendarForCallerTwo, 'anonymous'),
    );

    for (const result of [resultOne, resultTwo]) {
      expect(result).toMatchObject({ ok: false, error: 'caller_id_unavailable' });
      // The pre-fix bug shape had `existingBooking: undefined` sitting
      // alongside `already_has_active_booking` — assert that key is
      // simply absent now, not present-but-undefined.
      expect(result).not.toHaveProperty('existingBooking');
    }
    expect(calendarForCallerOne.createEventIdempotent).not.toHaveBeenCalled();
    expect(calendarForCallerTwo.createEventIdempotent).not.toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
    expect(findActiveBookingForCaller).not.toHaveBeenCalled();
  });
});

describe('book_appointment & reschedule_booking (lookahead window)', () => {
  // "now" is frozen file-wide (see FROZEN_NOW / the top-level beforeEach
  // above) at 2026-08-08T12:00:00Z — isWithinBusinessHours (businessHours.ts)
  // only checks weekday/hour-of-day with no now-relative comparison at all,
  // so these tests rely on that freeze to make a past date and a
  // too-far-future date deterministic regardless of when this suite runs.
  it('book_appointment rejects a date already in the past, without touching the calendar', async () => {
    findActiveBookingForCaller.mockResolvedValue(undefined);
    const calendar = fakeCalendar();

    const result = await bookAppointmentTool.handler(
      { date: '2026-08-01', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendar),
    );

    expect(result).toMatchObject({ ok: false, error: 'in_the_past' });
    expect(calendar.createEventIdempotent).not.toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('book_appointment rejects a date beyond the configured lookahead window, without touching the calendar', async () => {
    findActiveBookingForCaller.mockResolvedValue(undefined);
    const calendar = fakeCalendar();

    const result = await bookAppointmentTool.handler(
      { date: '2027-08-08', time: '14:00', purpose: 'Consultation', callerName: 'Jamie Rivera' },
      makeContext(calendar),
    );

    expect(result).toMatchObject({ ok: false, error: 'beyond_lookahead_window' });
    expect(calendar.createEventIdempotent).not.toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('reschedule_booking rejects a date already in the past, leaving the old booking untouched', async () => {
    findActiveBookingForCaller.mockResolvedValue(EXISTING_BOOKING);
    const calendar = fakeCalendar();

    const result = await rescheduleBookingTool.handler({ date: '2026-08-01', time: '14:00' }, makeContext(calendar));

    expect(result).toMatchObject({ ok: false, error: 'in_the_past' });
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    expect(supersedeBooking).not.toHaveBeenCalled();
  });

  it('reschedule_booking rejects a date beyond the configured lookahead window, leaving the old booking untouched', async () => {
    findActiveBookingForCaller.mockResolvedValue(EXISTING_BOOKING);
    const calendar = fakeCalendar();

    const result = await rescheduleBookingTool.handler({ date: '2027-08-08', time: '14:00' }, makeContext(calendar));

    expect(result).toMatchObject({ ok: false, error: 'beyond_lookahead_window' });
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    expect(supersedeBooking).not.toHaveBeenCalled();
  });
});

describe('findMyBookingTool.handler', () => {
  it('reports not found for a caller with no active booking', async () => {
    findActiveBookingForCaller.mockResolvedValue(undefined);
    const result = await findMyBookingTool.handler({}, makeContext(fakeCalendar()));
    expect(result).toMatchObject({ found: false });
  });

  it("finds the caller's own active booking", async () => {
    findActiveBookingForCaller.mockResolvedValue(EXISTING_BOOKING);
    const result = await findMyBookingTool.handler({}, makeContext(fakeCalendar()));
    expect(result).toMatchObject({ found: true, purpose: 'Consultation', callerName: 'Jamie Rivera' });
  });

  it('returns start as a CALENDAR_TIMEZONE local-time string, never a raw UTC "Z" timestamp', async () => {
    findActiveBookingForCaller.mockResolvedValue(EXISTING_BOOKING); // confirmedStart 2026-08-10T18:00:00.000Z
    const result = await findMyBookingTool.handler({}, makeContext(fakeCalendar()));
    // 18:00 UTC is 14:00 EDT (America/New_York, the default CALENDAR_TIMEZONE).
    expect(result).toMatchObject({ found: true, start: '2026-08-10T14:00:00' });
    expect((result as { start: string }).start).not.toMatch(/Z$/);
  });
});

describe('suggestTimesTool.handler', () => {
  it('spreads its 5 suggestions across the whole open day instead of only ever returning the earliest morning slots', async () => {
    // Regression test for live-call feedback: on a day with no busy events
    // at all, chunkIntoWindows (googleCalendarProvider.ts) produces 16
    // consecutive 30-minute windows for a 9am-5pm business day, in
    // chronological order. A bare .slice(0, 5) always took the first 5 —
    // 9:00, 9:30, 10:00, 10:30, 11:00 — every one of them morning. The
    // model, seeing only morning windows, told the caller "mornings are
    // available" even though the afternoon was equally free; it never saw
    // anything past 11:00 to know otherwise.
    const dayStartUtc = Date.parse('2026-08-11T13:00:00.000Z'); // 9:00am EDT
    const allDayWindows = Array.from({ length: 16 }, (_, i) => {
      const start = new Date(dayStartUtc + i * 30 * 60_000);
      const end = new Date(dayStartUtc + (i + 1) * 30 * 60_000);
      return { start: start.toISOString(), end: end.toISOString() };
    });
    const calendar = fakeCalendar({ computeCandidateWindows: vi.fn(async () => allDayWindows) });

    const result = await suggestTimesTool.handler({ date: '2026-08-11' }, makeContext(calendar));

    const times = (result as { times: { start: string }[] }).times;
    expect(times.length).toBeGreaterThan(1);
    const hours = times.map((t) => Number(t.start.slice(11, 13)));
    expect(Math.max(...hours)).toBeGreaterThanOrEqual(13); // at least one slot at or after 1:00pm local
  });

  // Reuses the same frozen-clock harness and dates as the "lookahead
  // window" describe block above — "now" is 2026-08-08T12:00:00Z file-wide
  // unless a test overrides it locally.
  it('rejects a day that has entirely already elapsed, without calling the calendar', async () => {
    const calendar = fakeCalendar();

    const result = await suggestTimesTool.handler({ date: '2026-08-01' }, makeContext(calendar));

    expect(result).toMatchObject({ ok: false, error: 'in_the_past' });
    expect(calendar.computeCandidateWindows).not.toHaveBeenCalled();
  });

  it('rejects a day beyond the configured lookahead window, without calling the calendar', async () => {
    const calendar = fakeCalendar();

    const result = await suggestTimesTool.handler({ date: '2027-08-08' }, makeContext(calendar));

    expect(result).toMatchObject({ ok: false, error: 'beyond_lookahead_window' });
    expect(calendar.computeCandidateWindows).not.toHaveBeenCalled();
  });

  it('does not reject "today" outright even though midnight has already passed, and filters out only the candidate windows that have already elapsed', async () => {
    // Monday 2026-08-10, 2:00pm EDT ("now") — a business day, mid-afternoon.
    // Without the per-window elapsed filter, a caller asking for "today"
    // this late could be offered an 11am slot that's already gone.
    vi.setSystemTime(new Date('2026-08-10T18:00:00.000Z'));

    const calendar = fakeCalendar({
      computeCandidateWindows: vi.fn(async () => [
        { start: '2026-08-10T15:00:00.000Z', end: '2026-08-10T15:30:00.000Z' }, // 11:00am EDT — already elapsed
        { start: '2026-08-10T19:00:00.000Z', end: '2026-08-10T19:30:00.000Z' }, // 3:00pm EDT — still upcoming
      ]),
    });

    const result = await suggestTimesTool.handler({ date: '2026-08-10' }, makeContext(calendar));

    expect(result).toMatchObject({
      times: [{ start: '2026-08-10T15:00:00', end: '2026-08-10T15:30:00' }],
    });
  });
});

describe('inbound tool registration', () => {
  it('registers all 7 inbound tools with unique names', async () => {
    const { inboundTools } = await import('../../src/inbound/tools.js');
    const names = inboundTools.map((t) => t.name);
    expect(names).toEqual([
      'check_availability',
      'suggest_times',
      'book_appointment',
      'find_my_booking',
      'reschedule_booking',
      'end_call',
      'flag_for_owner_and_end_call',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
