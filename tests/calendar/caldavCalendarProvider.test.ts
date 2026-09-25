import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaldavCalendarProvider, resourceNameForKey } from '../../src/calendar/caldavCalendarProvider.js';
import { SlotUnavailableError } from '../../src/calendar/types.js';

// Mocked at fetch, the provider's only way out, so these tests exercise its
// own logic (the XML it sends, how it reads replies, the idempotency and
// double-booking guards) without a real server.

const CALENDAR_URL = 'https://caldav.example.com/dav/calendars/user/me@example.com/work/';
const START = '2026-08-05T18:00:00.000Z';
const KEY = 'confirm:call-attempt-1';
const EVENT_ID = resourceNameForKey(KEY);
const EVENT_URL = `${CALENDAR_URL}${EVENT_ID}`;

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

let requests: Recorded[];
let handler: (req: Recorded) => Response;

function multistatus(events: string[][]): Response {
  const responses = events
    .map(
      (lines, i) => `<d:response>
  <d:href>/dav/calendars/user/me@example.com/work/e${i}.ics</d:href>
  <d:propstat>
    <d:prop><c:calendar-data>${['BEGIN:VCALENDAR', 'BEGIN:VEVENT', `UID:e${i}`, ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')}</c:calendar-data></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`,
    )
    .join('\n');
  return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`, {
    status: 207,
  });
}

function eventBody(lines: string[]): Response {
  return new Response(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', `UID:${EVENT_ID}`, ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'), { status: 200 });
}

function provider() {
  return new CaldavCalendarProvider({ calendarUrl: CALENDAR_URL, username: 'me@example.com', password: 'app-password', timeZone: 'America/New_York' });
}

function byMethod(method: string) {
  return requests.filter((r) => r.method === method);
}

beforeEach(() => {
  requests = [];
  handler = () => new Response('unexpected request', { status: 500 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const req = { method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body: init.body as string | undefined };
      requests.push(req);
      return handler(req);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CaldavCalendarProvider availability', () => {
  it('asks the server for expanded events in the window, authenticated with the app password', async () => {
    handler = () => multistatus([]);
    await provider().isFree({ start: START, durationMinutes: 30 });

    const [report] = requests;
    expect(report!.method).toBe('REPORT');
    expect(report!.url).toBe(CALENDAR_URL);
    expect(report!.headers.Depth).toBe('1');
    expect(report!.headers.Authorization).toBe(`Basic ${Buffer.from('me@example.com:app-password').toString('base64')}`);
    expect(report!.body).toContain('<c:expand start="20260805T180000Z" end="20260805T183000Z"/>');
    expect(report!.body).toContain('<c:time-range start="20260805T180000Z" end="20260805T183000Z"/>');
  });

  it('reports busy when an event overlaps, and free when the only overlap is marked free', async () => {
    handler = () => multistatus([['DTSTART:20260805T181500Z', 'DTEND:20260805T190000Z']]);
    expect(await provider().isFree({ start: START, durationMinutes: 30 })).toBe(false);

    handler = () => multistatus([['DTSTART:20260805T181500Z', 'DTEND:20260805T190000Z', 'TRANSP:TRANSPARENT']]);
    expect(await provider().isFree({ start: START, durationMinutes: 30 })).toBe(true);
  });

  it('splits the free time around busy events into candidate windows', async () => {
    // 18:00-20:00 window, busy 18:30-19:00 (an event starting before the window is clipped, not an error).
    handler = () => multistatus([['DTSTART:20260805T173000Z', 'DTEND:20260805T180000Z'], ['DTSTART:20260805T183000Z', 'DTEND:20260805T190000Z']]);
    const windows = await provider().computeCandidateWindows({
      dateWindows: [{ start: START, end: '2026-08-05T20:00:00.000Z' }],
      durationMinutes: 30,
    });
    expect(windows).toEqual([
      { start: '2026-08-05T18:00:00.000Z', end: '2026-08-05T18:30:00.000Z' },
      { start: '2026-08-05T19:00:00.000Z', end: '2026-08-05T19:30:00.000Z' },
      { start: '2026-08-05T19:30:00.000Z', end: '2026-08-05T20:00:00.000Z' },
    ]);
  });

  it('reads calendar data whose line endings arrive as &#13; character references', async () => {
    handler = () =>
      new Response(
        `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/e.ics</d:href><d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR&#13;
BEGIN:VEVENT&#13;
UID:e&#13;
DTSTART:20260805T181500Z&#13;
DTEND:20260805T190000Z&#13;
END:VEVENT&#13;
END:VCALENDAR&#13;
</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
        { status: 207 },
      );
    expect(await provider().isFree({ start: START, durationMinutes: 30 })).toBe(false);
  });

  it('fails rather than report free when the server did not expand a recurring event', async () => {
    handler = () => multistatus([['DTSTART:20260701T180000Z', 'DTEND:20260701T183000Z', 'RRULE:FREQ=WEEKLY']]);
    await expect(provider().isFree({ start: START, durationMinutes: 30 })).rejects.toThrow(/unexpanded recurring/);
  });

  it('fails rather than report free when the server truncated its results', async () => {
    handler = () =>
      new Response(
        `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/calendars/user/me@example.com/work/</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response></d:multistatus>`,
        { status: 207 },
      );
    await expect(provider().isFree({ start: START, durationMinutes: 30 })).rejects.toThrow(/507/);
  });

  it('throws on an HTTP error, e.g. a revoked app password', async () => {
    handler = () => new Response('', { status: 401 });
    await expect(provider().isFree({ start: START, durationMinutes: 30 })).rejects.toThrow(/HTTP 401/);
  });
});

describe('CaldavCalendarProvider.createEventIdempotent', () => {
  const input = { idempotencyKey: KEY, start: START, durationMinutes: 30, summary: 'Haircut', description: 'Booked by Banjo' };

  it('creates the event under a key-derived name, refusing to overwrite anything already there', async () => {
    handler = (req) => {
      if (req.method === 'GET') return new Response('', { status: 404 });
      if (req.method === 'REPORT') return multistatus([]);
      return new Response(null, { status: 201 });
    };

    const result = await provider().createEventIdempotent(input);

    expect(result).toEqual({ eventId: EVENT_ID, confirmedStart: START, confirmedEnd: '2026-08-05T18:30:00.000Z' });
    const [put] = byMethod('PUT');
    expect(put!.url).toBe(EVENT_URL);
    expect(put!.headers['If-None-Match']).toBe('*');
    expect(put!.body).toContain('DTSTART:20260805T180000Z');
    expect(put!.body).toContain('SUMMARY:Haircut');
  });

  it('returns the existing event for a repeated key without writing again', async () => {
    handler = (req) => {
      if (req.method === 'GET') return eventBody(['DTSTART:20260805T180000Z', 'DTEND:20260805T183000Z']);
      // The existing booking itself makes the slot look busy — it must still be returned, not refused.
      return multistatus([['DTSTART:20260805T180000Z', 'DTEND:20260805T183000Z']]);
    };

    const result = await provider().createEventIdempotent(input);

    expect(result.eventId).toBe(EVENT_ID);
    expect(byMethod('PUT')).toHaveLength(0);
  });

  it('refuses to double-book a slot that is no longer free, without writing', async () => {
    handler = (req) => {
      if (req.method === 'GET') return new Response('', { status: 404 });
      return multistatus([['DTSTART:20260805T180000Z', 'DTEND:20260805T190000Z']]);
    };

    await expect(provider().createEventIdempotent(input)).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(byMethod('PUT')).toHaveLength(0);
  });

  it('returns the winning event when a concurrent create with the same key got there first', async () => {
    let gets = 0;
    handler = (req) => {
      if (req.method === 'GET') {
        gets++;
        return gets === 1 ? new Response('', { status: 404 }) : eventBody(['DTSTART:20260805T180000Z', 'DTEND:20260805T183000Z']);
      }
      if (req.method === 'REPORT') return multistatus([]);
      return new Response('', { status: 412 });
    };

    const result = await provider().createEventIdempotent(input);

    expect(result).toEqual({ eventId: EVENT_ID, confirmedStart: START, confirmedEnd: '2026-08-05T18:30:00.000Z' });
  });
});

describe('CaldavCalendarProvider.findEventByIdempotencyKey', () => {
  it('returns undefined when nothing was booked under the key', async () => {
    handler = () => new Response('', { status: 404 });
    expect(await provider().findEventByIdempotencyKey(KEY)).toBeUndefined();
    expect(requests[0]!.url).toBe(EVENT_URL);
  });

  it("reads the event's current times, including after the owner moved it to a zoned time", async () => {
    handler = () => eventBody(['DTSTART;TZID=America/New_York:20260805T150000', 'DTEND;TZID=America/New_York:20260805T153000']);
    expect(await provider().findEventByIdempotencyKey(KEY)).toEqual({
      eventId: EVENT_ID,
      confirmedStart: '2026-08-05T19:00:00.000Z',
      confirmedEnd: '2026-08-05T19:30:00.000Z',
    });
  });
});

describe('CaldavCalendarProvider.deleteEvent', () => {
  it('deletes the resource, and treats an already-deleted event as done', async () => {
    handler = () => new Response(null, { status: 204 });
    await provider().deleteEvent(EVENT_ID);
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: EVENT_URL });

    handler = () => new Response('', { status: 404 });
    await expect(provider().deleteEvent(EVENT_ID)).resolves.toBeUndefined();
  });

  it('throws on any other failure', async () => {
    handler = () => new Response('', { status: 500 });
    await expect(provider().deleteEvent(EVENT_ID)).rejects.toThrow(/HTTP 500/);
  });
});

describe('resourceNameForKey', () => {
  it('gives distinct, URL-safe names to keys that differ only in punctuation', () => {
    const a = resourceNameForKey('inbound-reschedule:1:2026-08-05T18:00:00.000Z');
    const b = resourceNameForKey('inbound-reschedule-1-2026-08-05T18-00-00-000Z');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^banjo-[0-9a-f]{40}\.ics$/);
  });
});
