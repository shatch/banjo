import { describe, expect, it } from 'vitest';
import {
  buildBookingCalendar,
  busyIntervalsFromEvents,
  findEvents,
  parseDurationMs,
  parseICalendar,
  parseInstant,
} from '../../src/calendar/ical.js';

const TZ = 'America/New_York';

function vevent(lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:e1', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

function busyOf(ics: string, ownerEmail?: string) {
  return busyIntervalsFromEvents(findEvents(parseICalendar(ics)), { timeZone: TZ, ownerEmail }).map((b) => ({
    start: new Date(b.startMs).toISOString(),
    end: new Date(b.endMs).toISOString(),
  }));
}

describe('parseICalendar', () => {
  it('unfolds continuation lines and reads quoted params containing ; and :', () => {
    const [cal] = parseICalendar(
      ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Hair', ' cut', 'ATTENDEE;CN="Doe; J: Jr";PARTSTAT=ACCEPTED:mailto:j@example.com', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
    );
    const event = cal!.components[0]!;
    expect(event.properties.find((p) => p.name === 'SUMMARY')?.value).toBe('Haircut');
    const attendee = event.properties.find((p) => p.name === 'ATTENDEE');
    expect(attendee?.params).toEqual({ CN: 'Doe; J: Jr', PARTSTAT: 'ACCEPTED' });
    expect(attendee?.value).toBe('mailto:j@example.com');
  });
});

describe('parseInstant', () => {
  it('reads UTC, TZID, floating, and all-day values — the last two in the default zone', () => {
    expect(new Date(parseInstant({ name: 'DTSTART', params: {}, value: '20260805T180000Z' }, TZ).ms).toISOString()).toBe('2026-08-05T18:00:00.000Z');
    expect(
      new Date(parseInstant({ name: 'DTSTART', params: { TZID: 'America/Los_Angeles' }, value: '20260805T110000' }, TZ).ms).toISOString(),
    ).toBe('2026-08-05T18:00:00.000Z');
    // Floating: no Z, no TZID — CALENDAR_TIMEZONE, the same rule as a spoken time.
    expect(new Date(parseInstant({ name: 'DTSTART', params: {}, value: '20260805T140000' }, TZ).ms).toISOString()).toBe('2026-08-05T18:00:00.000Z');
    const allDay = parseInstant({ name: 'DTSTART', params: { VALUE: 'DATE' }, value: '20260805' }, TZ);
    expect(allDay.allDay).toBe(true);
    expect(new Date(allDay.ms).toISOString()).toBe('2026-08-05T04:00:00.000Z');
  });

  it('throws on a TZID Intl does not know, rather than guessing a zone', () => {
    expect(() => parseInstant({ name: 'DTSTART', params: { TZID: 'Eastern Standard Time' }, value: '20260805T140000' }, TZ)).toThrow();
  });
});

describe('parseDurationMs', () => {
  it('handles weeks, days, and times', () => {
    expect(parseDurationMs('PT30M')).toBe(30 * 60_000);
    expect(parseDurationMs('P1DT2H')).toBe(26 * 3_600_000);
    expect(parseDurationMs('P1W')).toBe(7 * 86_400_000);
    expect(parseDurationMs('-PT15M')).toBe(-15 * 60_000);
  });
});

describe('busyIntervalsFromEvents', () => {
  it('counts an ordinary timed event, using DTEND or DURATION', () => {
    expect(busyOf(vevent(['DTSTART:20260805T180000Z', 'DTEND:20260805T183000Z']))).toEqual([
      { start: '2026-08-05T18:00:00.000Z', end: '2026-08-05T18:30:00.000Z' },
    ]);
    expect(busyOf(vevent(['DTSTART:20260805T180000Z', 'DURATION:PT1H']))).toEqual([
      { start: '2026-08-05T18:00:00.000Z', end: '2026-08-05T19:00:00.000Z' },
    ]);
  });

  it('skips cancelled events and events marked free', () => {
    expect(busyOf(vevent(['DTSTART:20260805T180000Z', 'DTEND:20260805T183000Z', 'STATUS:CANCELLED']))).toEqual([]);
    expect(busyOf(vevent(['DTSTART:20260805T180000Z', 'DTEND:20260805T183000Z', 'TRANSP:TRANSPARENT']))).toEqual([]);
  });

  it("skips an invitation the owner declined, but not someone else's decline", () => {
    const declinedByOwner = vevent([
      'DTSTART:20260805T180000Z',
      'DTEND:20260805T183000Z',
      'ATTENDEE;PARTSTAT=DECLINED:mailto:Me@Example.com',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:other@example.com',
    ]);
    expect(busyOf(declinedByOwner, 'me@example.com')).toEqual([]);

    const declinedByOther = vevent(['DTSTART:20260805T180000Z', 'DTEND:20260805T183000Z', 'ATTENDEE;PARTSTAT=DECLINED:mailto:other@example.com']);
    expect(busyOf(declinedByOther, 'me@example.com')).toHaveLength(1);
  });

  it('treats all-day events as free unless explicitly marked busy, matching Google', () => {
    expect(busyOf(vevent(['DTSTART;VALUE=DATE:20260805', 'DTEND;VALUE=DATE:20260806']))).toEqual([]);
    expect(busyOf(vevent(['DTSTART;VALUE=DATE:20260805', 'DTEND;VALUE=DATE:20260806', 'TRANSP:OPAQUE']))).toEqual([
      { start: '2026-08-05T04:00:00.000Z', end: '2026-08-06T04:00:00.000Z' },
    ]);
  });

  it('refuses an unexpanded recurring event instead of counting only its first occurrence', () => {
    expect(() => busyOf(vevent(['DTSTART:20260805T180000Z', 'DTEND:20260805T183000Z', 'RRULE:FREQ=WEEKLY']))).toThrow(/unexpanded recurring/);
  });
});

describe('buildBookingCalendar', () => {
  it('writes UTC times, escapes text, folds long lines, and round-trips through the parser', () => {
    const summary = `Haircut; with Sam, at 2pm — ${'long '.repeat(20)}`;
    const ics = buildBookingCalendar({
      uid: 'banjo-abc',
      startMs: Date.parse('2026-08-05T18:00:00.000Z'),
      endMs: Date.parse('2026-08-05T18:30:00.000Z'),
      summary,
      description: 'line one\nline two',
      idempotencyKey: 'confirm:attempt-1',
    });

    expect(ics).toContain('DTSTART:20260805T180000Z\r\n');
    expect(ics).toContain('DTEND:20260805T183000Z\r\n');
    expect(ics).toContain('DESCRIPTION:line one\\nline two\r\n');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);

    const [event] = findEvents(parseICalendar(ics));
    expect(event!.properties.find((p) => p.name === 'SUMMARY')?.value).toBe(summary.replace(/;/g, '\\;').replace(/,/g, '\\,'));
    expect(busyIntervalsFromEvents([event!], { timeZone: TZ })).toHaveLength(1);
  });
});
