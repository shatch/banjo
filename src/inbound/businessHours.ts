import { config } from '../config/index.js';
import { getZonedParts } from '../lib/timezone.js';
import type { TimeWindow } from '../tasks/schema.js';

export interface BusinessHours {
  days: number[]; // 0 (Sun) - 6 (Sat)
  startHour: number; // 0-23, inclusive — a booking may start no earlier than this
  endHour: number; // 1-24, exclusive-of-start/inclusive-of-end — a booking must end at or before this
  timeZone: string;
}

export function businessHoursFromConfig(): BusinessHours {
  return {
    days: config.BUSINESS_HOURS_DAYS.split(',').map(Number),
    startHour: config.BUSINESS_HOURS_START,
    endHour: config.BUSINESS_HOURS_END,
    timeZone: config.CALENDAR_TIMEZONE,
  };
}

/**
 * Whether a proposed [start, start + durationMinutes) slot falls entirely
 * within `hours` — same weekday, doesn't start before opening, doesn't run
 * past closing. `start`/`end` are checked independently against the
 * *start's* local calendar day (never re-deriving the weekday from `end`)
 * since a slot that starts on a valid business day and stays under the
 * daily duration bound can't cross into a different calendar day.
 */
export function isWithinBusinessHours(startUtcIso: string, durationMinutes: number, hours: BusinessHours): boolean {
  const start = getZonedParts(startUtcIso, hours.timeZone);
  if (!hours.days.includes(start.weekday)) return false;

  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = startMinutes + durationMinutes;
  return startMinutes >= hours.startHour * 60 && endMinutes <= hours.endHour * 60;
}

/** Filters candidate windows (as produced by CalendarProvider.computeCandidateWindows) down to only those fully inside `hours`. */
export function intersectWithBusinessHours(windows: TimeWindow[], hours: BusinessHours): TimeWindow[] {
  return windows.filter((window) => {
    const durationMinutes = (Date.parse(window.end) - Date.parse(window.start)) / 60_000;
    return isWithinBusinessHours(window.start, durationMinutes, hours);
  });
}
