import { describe, expect, it } from 'vitest';
import { formatInZone, getZonedParts, zonedTimeToUtcIso } from '../../src/lib/timezone.js';

describe('zonedTimeToUtcIso', () => {
  it('converts a naive 2pm America/New_York (EDT, summer) to 18:00 UTC', () => {
    // Regression test for the exact bug: "2pm" requested, event landed at
    // 10am on the calendar (4 hours off — 2pm was silently treated as UTC).
    expect(zonedTimeToUtcIso('2026-08-04T14:00:00', 'America/New_York')).toBe('2026-08-04T18:00:00.000Z');
  });

  it('converts a naive 2pm America/New_York (EST, winter) to 19:00 UTC', () => {
    // DST-aware: winter is UTC-5, not UTC-4 — a fixed-offset implementation
    // would get this wrong half the year.
    expect(zonedTimeToUtcIso('2026-01-15T14:00:00', 'America/New_York')).toBe('2026-01-15T19:00:00.000Z');
  });

  it('converts a naive time in a different zone correctly (America/Los_Angeles)', () => {
    expect(zonedTimeToUtcIso('2026-08-04T14:00:00', 'America/Los_Angeles')).toBe('2026-08-04T21:00:00.000Z');
  });

  it('trusts an already-offset string as-is instead of re-interpreting it', () => {
    expect(zonedTimeToUtcIso('2026-08-04T14:00:00-04:00', 'America/Los_Angeles')).toBe('2026-08-04T18:00:00.000Z');
  });

  it('trusts an already-UTC (Z-suffixed) string as-is', () => {
    expect(zonedTimeToUtcIso('2026-08-04T18:00:00Z', 'America/New_York')).toBe('2026-08-04T18:00:00.000Z');
  });

  it('round-trips midnight correctly (a known ICU h23 edge case)', () => {
    // Local midnight in New York in August is 04:00 UTC the same day.
    expect(zonedTimeToUtcIso('2026-08-04T00:00:00', 'America/New_York')).toBe('2026-08-04T04:00:00.000Z');
  });

  // #233: the offset was read at the input-as-UTC instant, which on a DST
  // change day can fall on the other side of the switch from the real one.
  it('converts early morning on the fall-back day with the standard-time offset', () => {
    expect(zonedTimeToUtcIso('2026-11-01T05:00:00', 'America/New_York')).toBe('2026-11-01T10:00:00.000Z');
    expect(zonedTimeToUtcIso('2026-11-01T02:00:00', 'America/New_York')).toBe('2026-11-01T07:00:00.000Z');
  });

  it('converts early morning on the spring-forward day with the daylight-time offset', () => {
    expect(zonedTimeToUtcIso('2026-03-08T05:00:00', 'America/New_York')).toBe('2026-03-08T09:00:00.000Z');
    expect(zonedTimeToUtcIso('2026-03-08T03:00:00', 'America/New_York')).toBe('2026-03-08T07:00:00.000Z');
  });

  it('converts the hour before the switch in a zone east of UTC (Europe/Berlin)', () => {
    expect(zonedTimeToUtcIso('2026-10-25T01:30:00', 'Europe/Berlin')).toBe('2026-10-24T23:30:00.000Z');
    expect(zonedTimeToUtcIso('2026-03-29T01:30:00', 'Europe/Berlin')).toBe('2026-03-29T00:30:00.000Z');
  });

  it('takes the first occurrence of a repeated time when clocks fall back', () => {
    // 01:30 happens twice on 2026-11-01: first EDT (05:30Z), then EST (06:30Z).
    expect(zonedTimeToUtcIso('2026-11-01T01:30:00', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  });

  it('moves a skipped time forward when clocks spring forward, never earlier', () => {
    // 02:30 doesn't exist on 2026-03-08; it's read as 02:30 EST, which is 03:30 EDT.
    expect(zonedTimeToUtcIso('2026-03-08T02:30:00', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
  });

  it('keeps milliseconds instead of folding them into the offset', () => {
    expect(zonedTimeToUtcIso('2026-08-04T14:00:00.500', 'America/New_York')).toBe('2026-08-04T18:00:00.500Z');
  });

  it('round-trips every half hour of a year through formatInZone, across zones', () => {
    for (const zone of ['America/New_York', 'Europe/Berlin', 'Australia/Sydney', 'America/Santiago', 'Australia/Lord_Howe']) {
      for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 30 * 60 * 1000) {
        const local = formatInZone(new Date(ms).toISOString(), zone);
        const utc = zonedTimeToUtcIso(local, zone);
        if (formatInZone(utc, zone) !== local) throw new Error(`${zone} ${local} -> ${utc}`);
      }
    }
  });
});

describe('formatInZone', () => {
  it('renders a UTC instant as an offset-less local-time string (EDT, summer)', () => {
    // Inverse of the zonedTimeToUtcIso regression above: 18:00 UTC in
    // August is 14:00 EDT, with no Z/offset suffix on the output.
    expect(formatInZone('2026-08-11T18:00:00.000Z', 'America/New_York')).toBe('2026-08-11T14:00:00');
  });

  it('renders a UTC instant as an offset-less local-time string (EST, winter)', () => {
    // DST-aware: winter is UTC-5, not UTC-4.
    expect(formatInZone('2026-01-15T19:00:00.000Z', 'America/New_York')).toBe('2026-01-15T14:00:00');
  });

  it('rolls the calendar date across midnight when the zone is behind UTC', () => {
    expect(formatInZone('2026-08-04T02:00:00.000Z', 'America/New_York')).toBe('2026-08-03T22:00:00');
  });

  it('pads single-digit month/day/hour/minute/second components', () => {
    expect(formatInZone('2026-01-05T09:05:03.000Z', 'America/New_York')).toBe('2026-01-05T04:05:03');
  });
});

describe('getZonedParts', () => {
  it('reads the correct wall-clock date/time for a UTC instant in America/New_York (EDT, summer)', () => {
    // 18:00 UTC in August is 14:00 EDT (UTC-4) — Tuesday, 2026-08-04.
    expect(getZonedParts('2026-08-04T18:00:00.000Z', 'America/New_York')).toEqual({
      year: 2026,
      month: 8,
      day: 4,
      hour: 14,
      minute: 0,
      second: 0,
      weekday: 2, // Tuesday
    });
  });

  it('reads the correct wall-clock date/time for a UTC instant in America/New_York (EST, winter)', () => {
    // 19:00 UTC in January is 14:00 EST (UTC-5) — DST-aware.
    expect(getZonedParts('2026-01-15T19:00:00.000Z', 'America/New_York')).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 14,
      minute: 0,
      second: 0,
      weekday: 4, // Thursday
    });
  });

  it('rolls the calendar date across midnight when the zone is behind UTC', () => {
    // 2026-08-04T02:00:00Z is still 2026-08-03T22:00:00 in New York (EDT).
    expect(getZonedParts('2026-08-04T02:00:00.000Z', 'America/New_York')).toEqual({
      year: 2026,
      month: 8,
      day: 3,
      hour: 22,
      minute: 0,
      second: 0,
      weekday: 1, // Monday
    });
  });
});
