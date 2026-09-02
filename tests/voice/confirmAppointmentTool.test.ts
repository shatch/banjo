import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlotUnavailableError } from '../../src/calendar/types.js';
import type { CalendarProvider } from '../../src/calendar/types.js';
import type { CallContext } from '../../src/session/types.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';

// confirm_appointment's handler calls transitionTask on success — stub the
// whole persistence layer rather than hitting a real DB, matching the
// pattern already used in tests/session/callSession.test.ts.
const transitionTask = vi.fn(async () => {});
vi.mock('../../src/tasks/service.js', () => ({
  getTask: vi.fn(async () => undefined),
  transitionTask,
  NON_TERMINAL_STATUSES: ['negotiating'],
}));

const { confirmAppointmentTool } = await import('../../src/voice/tools/callTools.js');

const task = { id: 'task-1', goalDescription: 'Book a haircut' } as Task;
const callAttempt = { id: 'call-attempt-1' } as CallAttempt;

function makeContext(calendar: CalendarProvider): CallContext {
  return {
    task,
    callAttempt,
    callId: callAttempt.id,
    telephony: {} as CallContext['telephony'],
    calendar,
    estimatedAudioDoneAt: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('confirmAppointmentTool.handler', () => {
  it('returns a slot_unavailable failure — not a generic upstream_error — when the calendar refuses a double-booked slot', async () => {
    // Regression coverage: createEventIdempotent now guards against
    // double-booking by throwing SlotUnavailableError (see
    // tests/calendar/googleCalendarProvider.test.ts). This test locks in
    // that runToolSafely (callTools.ts) classifies that specific error as
    // "slot_unavailable" rather than lumping it in with any other thrown
    // error as "upstream_error" — the model needs to be able to tell "the
    // time you asked for got taken, negotiate a new one" apart from "the
    // calendar API is broken, maybe retry."
    const calendar: CalendarProvider = {
      computeCandidateWindows: vi.fn(async () => []),
      isFree: vi.fn(async () => false),
      createEventIdempotent: vi.fn(async () => {
        throw new SlotUnavailableError();
      }),
      deleteEvent: vi.fn(async () => {}),
    };

    const result = await confirmAppointmentTool.handler(
      { confirmedStart: '2026-08-05T14:00:00', durationMinutes: 30 },
      makeContext(calendar),
    );

    expect(result).toMatchObject({ ok: false, error: 'slot_unavailable' });
    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('confirms and transitions the task when the calendar accepts the booking', async () => {
    const calendar: CalendarProvider = {
      computeCandidateWindows: vi.fn(async () => []),
      isFree: vi.fn(async () => true),
      createEventIdempotent: vi.fn(async () => ({
        eventId: 'evt-1',
        confirmedStart: '2026-08-05T18:00:00.000Z',
        confirmedEnd: '2026-08-05T18:30:00.000Z',
      })),
      deleteEvent: vi.fn(async () => {}),
    };

    const result = await confirmAppointmentTool.handler(
      { confirmedStart: '2026-08-05T14:00:00', durationMinutes: 30 },
      makeContext(calendar),
    );

    expect(result).toMatchObject({ ok: true, confirmedStart: '2026-08-05T18:00:00.000Z' });
    expect(transitionTask).toHaveBeenCalledTimes(1);
    expect(transitionTask).toHaveBeenCalledWith('task-1', 'confirmed', expect.objectContaining({ calendarEventId: 'evt-1' }));
  });
});
