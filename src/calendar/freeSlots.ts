/**
 * Provider-independent slot math shared by every CalendarProvider: given the
 * busy intervals a provider fetched from its backend, work out the free
 * candidate windows to offer on a call.
 */

import type { TimeWindow } from '../tasks/schema.js';

const MS_PER_MINUTE = 60_000;

/** A busy interval expressed as epoch milliseconds, for date-math. */
export interface BusyInterval {
  startMs: number;
  endMs: number;
}

/**
 * Subtract a set of busy intervals from a single [startMs, endMs) window,
 * returning the free sub-intervals that remain, in chronological order.
 *
 * Assumptions/simplifications:
 * - `busy` intervals may be unsorted, overlapping, or touching; they are
 *   sorted and merged before subtraction.
 * - Busy intervals outside `window` are not clipped defensively here
 *   beyond the merge step, since the freebusy API is only ever queried
 *   with `window` as its own timeMin/timeMax, so Google will not return
 *   busy periods outside it.
 * - Zero-length or inverted (`end <= start`) busy/free intervals are
 *   dropped.
 */
export function subtractBusyIntervals(window: BusyInterval, busy: BusyInterval[]): BusyInterval[] {
  if (window.endMs <= window.startMs) return [];

  const sorted = [...busy].filter((b) => b.endMs > b.startMs).sort((a, b) => a.startMs - b.startMs);

  const merged: BusyInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }

  const free: BusyInterval[] = [];
  let cursor = window.startMs;
  for (const busyInterval of merged) {
    const clippedStart = Math.max(busyInterval.startMs, window.startMs);
    const clippedEnd = Math.min(busyInterval.endMs, window.endMs);
    if (clippedStart > cursor) {
      free.push({ startMs: cursor, endMs: clippedStart });
    }
    cursor = Math.max(cursor, clippedEnd);
  }
  if (cursor < window.endMs) {
    free.push({ startMs: cursor, endMs: window.endMs });
  }

  return free;
}

/**
 * Chunk a free interval into consecutive, non-overlapping
 * `durationMinutes`-sized candidate windows, starting at the interval's
 * start. Any leftover time shorter than a full duration at the end of the
 * interval is dropped (a partial slot isn't a valid candidate).
 */
export function chunkIntoWindows(interval: BusyInterval, durationMinutes: number): TimeWindow[] {
  const durationMs = durationMinutes * MS_PER_MINUTE;
  if (durationMs <= 0) return [];

  const windows: TimeWindow[] = [];
  let slotStart = interval.startMs;
  while (slotStart + durationMs <= interval.endMs) {
    const slotEnd = slotStart + durationMs;
    windows.push({ start: new Date(slotStart).toISOString(), end: new Date(slotEnd).toISOString() });
    slotStart = slotEnd;
  }

  return windows;
}
