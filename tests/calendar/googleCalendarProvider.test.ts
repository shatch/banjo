import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlotUnavailableError } from '../../src/calendar/types.js';

// GoogleCalendarProvider talks to Google exclusively through the `googleapis`
// client — mock it at the module boundary so these tests exercise the
// provider's own logic (the idempotency + double-booking guards) without a
// real network call or real credentials.
const eventsList = vi.fn();
const eventsInsert = vi.fn();
const eventsDelete = vi.fn();
const freebusyQuery = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
      },
    },
    calendar: () => ({
      events: { list: eventsList, insert: eventsInsert, delete: eventsDelete },
      freebusy: { query: freebusyQuery },
    }),
  },
}));

const { GoogleCalendarProvider } = await import('../../src/calendar/googleCalendarProvider.js');

const START = '2026-08-05T18:00:00.000Z';
const DURATION_MINUTES = 30;
const IDEMPOTENCY_KEY = 'confirm:call-attempt-1';

function freeBusyResponse(busy: Array<{ start: string; end: string }>) {
  return { data: { calendars: { primary: { busy } } } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GoogleCalendarProvider.createEventIdempotent', () => {
  // Regression coverage for a real incident: this guard didn't exist, and
  // three overlapping test bookings landed on the same real calendar slot.
  it('refuses to book a slot that is no longer free, without touching events.insert', async () => {
    eventsList.mockResolvedValue({ data: { items: [] } }); // no existing event for this idempotency key
    freebusyQuery.mockResolvedValue(freeBusyResponse([{ start: START, end: '2026-08-05T18:30:00.000Z' }]));

    const provider = new GoogleCalendarProvider();

    await expect(
      provider.createEventIdempotent({
        idempotencyKey: IDEMPOTENCY_KEY,
        start: START,
        durationMinutes: DURATION_MINUTES,
        summary: 'Haircut',
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);

    expect(eventsInsert).not.toHaveBeenCalled();
  });

  it('books the event when the slot is free and no existing event matches the idempotency key', async () => {
    eventsList.mockResolvedValue({ data: { items: [] } });
    freebusyQuery.mockResolvedValue(freeBusyResponse([]));
    eventsInsert.mockResolvedValue({
      data: {
        id: 'evt-1',
        start: { dateTime: START },
        end: { dateTime: '2026-08-05T18:30:00.000Z' },
      },
    });

    const provider = new GoogleCalendarProvider();
    const result = await provider.createEventIdempotent({
      idempotencyKey: IDEMPOTENCY_KEY,
      start: START,
      durationMinutes: DURATION_MINUTES,
      summary: 'Haircut',
    });

    expect(result.eventId).toBe('evt-1');
    expect(eventsInsert).toHaveBeenCalledTimes(1);
  });

  // A retry of an already-confirmed booking must short-circuit on the
  // idempotency match BEFORE the free-slot guard — otherwise a retry of a
  // successful booking (which now legitimately occupies the slot it
  // checked) would be wrongly rejected as unavailable.
  it('returns the existing event on an idempotency-key match even though the slot it occupies is no longer "free"', async () => {
    eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: 'evt-existing',
            start: { dateTime: START },
            end: { dateTime: '2026-08-05T18:30:00.000Z' },
          },
        ],
      },
    });
    // The slot shows busy — because this exact event already occupies it.
    freebusyQuery.mockResolvedValue(freeBusyResponse([{ start: START, end: '2026-08-05T18:30:00.000Z' }]));

    const provider = new GoogleCalendarProvider();
    const result = await provider.createEventIdempotent({
      idempotencyKey: IDEMPOTENCY_KEY,
      start: START,
      durationMinutes: DURATION_MINUTES,
      summary: 'Haircut',
    });

    expect(result.eventId).toBe('evt-existing');
    expect(eventsInsert).not.toHaveBeenCalled();
  });
});

describe('GoogleCalendarProvider.deleteEvent', () => {
  it('calls events.delete with the configured calendar and the given event id', async () => {
    eventsDelete.mockResolvedValue({});
    const provider = new GoogleCalendarProvider();

    await provider.deleteEvent('evt-123');

    expect(eventsDelete).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'evt-123' });
  });
});
