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
