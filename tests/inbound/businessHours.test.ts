import { describe, expect, it } from 'vitest';
import {
  businessHoursFromConfig,
  intersectWithBusinessHours,
  isWithinBusinessHours,
  type BusinessHours,
} from '../../src/inbound/businessHours.js';

const MON_FRI_9_5_NY: BusinessHours = {
  days: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 17,
  timeZone: 'America/New_York',
};

describe('isWithinBusinessHours', () => {
  it('accepts a slot fully inside the window', () => {
    // 2026-08-04 is a Tuesday. 14:00 EDT = 18:00 UTC.
    expect(isWithinBusinessHours('2026-08-04T18:00:00.000Z', 30, MON_FRI_9_5_NY)).toBe(true);
  });

  it('accepts a slot starting exactly at the opening hour', () => {
    // 09:00 EDT = 13:00 UTC.
    expect(isWithinBusinessHours('2026-08-04T13:00:00.000Z', 30, MON_FRI_9_5_NY)).toBe(true);
  });

  it('accepts a slot ending exactly at the closing hour', () => {
    // 16:30 EDT = 20:30 UTC, +30min ends exactly at 17:00.
    expect(isWithinBusinessHours('2026-08-04T20:30:00.000Z', 30, MON_FRI_9_5_NY)).toBe(true);
  });

  it('rejects a slot starting exactly at the closing hour', () => {
    // 17:00 EDT = 21:00 UTC — the boundary itself is not a valid start.
    expect(isWithinBusinessHours('2026-08-04T21:00:00.000Z', 30, MON_FRI_9_5_NY)).toBe(false);
  });

  it('rejects a slot that starts in-hours but runs past closing', () => {
    // 16:45 EDT start + 30min would end at 17:15, past closing.
    expect(isWithinBusinessHours('2026-08-04T20:45:00.000Z', 30, MON_FRI_9_5_NY)).toBe(false);
  });

  it('rejects a slot before the opening hour', () => {
    // 08:59 EDT = 12:59 UTC.
    expect(isWithinBusinessHours('2026-08-04T12:59:00.000Z', 30, MON_FRI_9_5_NY)).toBe(false);
  });

  it('rejects a weekend day even if the hour is otherwise valid', () => {
    // 2026-08-08 is a Saturday. 14:00 EDT = 18:00 UTC.
    expect(isWithinBusinessHours('2026-08-08T18:00:00.000Z', 30, MON_FRI_9_5_NY)).toBe(false);
  });

  it('is DST-aware — the same local 9am-5pm bound holds in winter (EST, UTC-5)', () => {
    // 2026-01-13 is a Tuesday. 09:00 EST = 14:00 UTC.
    expect(isWithinBusinessHours('2026-01-13T14:00:00.000Z', 30, MON_FRI_9_5_NY)).toBe(true);
    // 08:59 EST = 13:59 UTC — one minute before opening.
    expect(isWithinBusinessHours('2026-01-13T13:59:00.000Z', 30, MON_FRI_9_5_NY)).toBe(false);
  });
});

describe('intersectWithBusinessHours', () => {
  it('keeps windows fully inside business hours and drops the rest', () => {
    const windows = [
      { start: '2026-08-04T13:00:00.000Z', end: '2026-08-04T13:30:00.000Z' }, // 09:00-09:30 EDT, in
      { start: '2026-08-04T12:00:00.000Z', end: '2026-08-04T12:30:00.000Z' }, // 08:00-08:30 EDT, before opening
      { start: '2026-08-08T18:00:00.000Z', end: '2026-08-08T18:30:00.000Z' }, // Saturday, out
    ];

    expect(intersectWithBusinessHours(windows, MON_FRI_9_5_NY)).toEqual([windows[0]]);
  });
});

describe('businessHoursFromConfig', () => {
  it('reads days/start/end/timeZone from config', () => {
    const hours = businessHoursFromConfig();
    expect(hours.days).toEqual([1, 2, 3, 4, 5]); // BUSINESS_HOURS_DAYS default
    expect(hours.startHour).toBe(9);
    expect(hours.endHour).toBe(17);
    expect(hours.timeZone).toBe('America/New_York'); // CALENDAR_TIMEZONE default
  });
});
