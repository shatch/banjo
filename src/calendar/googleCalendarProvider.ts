/**
 * Direct googleapis client for Steve's own personal Google Calendar.
 *
 * This deliberately uses OAuth2 user-consent (a normal "log in as
 * steve@..." grant), NOT a service-account with domain-wide delegation.
 * Domain-wide delegation is a Google Workspace admin feature for
 * impersonating users in a managed domain — it doesn't apply to a personal
 * Google account, and isn't the right tool even if it did. A single
 * long-lived OAuth2 refresh token, minted once via user consent, is the
 * correct mechanism here.
 *
 * OPS TODO: `GOOGLE_OAUTH_REFRESH_TOKEN` is not something this scaffold can
 * produce. Obtaining it requires a one-time interactive consent flow (e.g.
 * running the OAuth2 client through Google's OAuth Playground
 * https://developers.google.com/oauthplayground with the calendar scope,
 * or a small local script that opens a browser, completes the consent
 * screen, and prints the resulting refresh token) run once by Steve. That
 * token is then stored in the environment for this process. This file
 * assumes that token already exists.
 */

import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import {
  SlotUnavailableError,
  type CalendarProvider,
  type CheckAvailabilityInput,
  type IsFreeInput,
  type CreateEventInput,
  type CreateEventResult,
} from './types.js';
import type { TimeWindow } from '../tasks/schema.js';

const MS_PER_MINUTE = 60_000;

/** A busy interval expressed as epoch milliseconds, for date-math. */
interface BusyInterval {
  startMs: number;
  endMs: number;
}

export class GoogleCalendarProvider implements CalendarProvider {
  private readonly calendar: calendar_v3.Calendar;

  constructor() {
    const oauth2Client = new google.auth.OAuth2(config.GOOGLE_OAUTH_CLIENT_ID, config.GOOGLE_OAUTH_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: config.GOOGLE_OAUTH_REFRESH_TOKEN });
    this.calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  }

  async computeCandidateWindows({ dateWindows, durationMinutes }: CheckAvailabilityInput): Promise<TimeWindow[]> {
    const candidates: TimeWindow[] = [];

    for (const window of dateWindows) {
      const busy = await this.getBusyIntervals(window);
      const freeIntervals = subtractBusyIntervals(
        { startMs: Date.parse(window.start), endMs: Date.parse(window.end) },
        busy,
      );
      for (const free of freeIntervals) {
        candidates.push(...chunkIntoWindows(free, durationMinutes));
      }
    }

    return candidates;
  }

  async isFree({ start, durationMinutes }: IsFreeInput): Promise<boolean> {
    const startMs = Date.parse(start);
    const endMs = startMs + durationMinutes * MS_PER_MINUTE;

    const busy = await this.getBusyIntervals({ start, end: new Date(endMs).toISOString() });

    // Belt-and-suspenders: the freebusy API should only return periods that
    // overlap the requested range, but we re-check overlap explicitly
    // rather than trusting `busy.length === 0` alone.
    const overlapsAny = busy.some((b) => b.startMs < endMs && b.endMs > startMs);
    return !overlapsAny;
  }

  async createEventIdempotent({
    idempotencyKey,
    start,
    durationMinutes,
    summary,
    description,
  }: CreateEventInput): Promise<CreateEventResult> {
    // Step 1: check-then-insert idempotency guard, plus a double-booking
    // guard, run concurrently (both are read-only lookups against Google,
    // so there's no ordering dependency between them — doing this serially
    // would just add latency on a live phone call).
    //
    // NOTE: neither guard is atomic with the eventual insert. Two
    // near-simultaneous calls could both pass their check before either has
    // inserted, and end up creating two events / double-booking the same
    // slot. For this system's actual usage pattern — one call-attempt
    // handling one confirmation at a time — that race window is an
    // acceptable v1 risk. A stronger guarantee (e.g. under real
    // concurrency) would require a local Postgres-backed idempotency table
    // with a unique constraint, claimed before the Google Calendar call is
    // made. That's out of scope for this file.
    // Timed to find the slow step during the next real call that gets cut
    // off — see the handoff note this responds to: even after fail()/end()
    // correctly hang up Twilio, confirm_appointment itself is slow enough
    // to risk the watchdog/grace-period cutting off the model mid-sentence,
    // and it wasn't clear which Google API call was the culprit.
    const guardCheckStartedAt = Date.now();
    const [existing, free] = await Promise.all([
      this.calendar.events.list({
        calendarId: config.GOOGLE_CALENDAR_ID,
        privateExtendedProperty: [`idempotencyKey=${idempotencyKey}`],
      }),
      this.isFree({ start, durationMinutes }),
    ]);
    logger.info({ idempotencyKey, durationMs: Date.now() - guardCheckStartedAt }, 'createEventIdempotent: idempotency + free-slot guard checks completed');

    const existingEvent = existing.data.items?.[0];
    if (existingEvent?.id && existingEvent.start?.dateTime && existingEvent.end?.dateTime) {
      logger.info({ idempotencyKey, eventId: existingEvent.id }, 'createEventIdempotent: found existing event, skipping insert');
      return {
        eventId: existingEvent.id,
        confirmedStart: existingEvent.start.dateTime,
        confirmedEnd: existingEvent.end.dateTime,
      };
    }

    // This is a genuinely new booking attempt (no existing event for this
    // idempotency key) — refuse it if the slot is no longer free rather
    // than silently double-booking.
    if (!free) {
      logger.warn({ idempotencyKey, start, durationMinutes }, 'createEventIdempotent: requested slot is no longer free, refusing to double-book');
      throw new SlotUnavailableError();
    }

    // Step 2: create the event.
    const startMs = Date.parse(start);
    const endIso = new Date(startMs + durationMinutes * MS_PER_MINUTE).toISOString();

    const insertStartedAt = Date.now();
    const created = await this.calendar.events.insert({
      calendarId: config.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary,
        description,
        // `start`/`end` are always a correct, unambiguous UTC instant by
        // the time they reach this class (see zonedTimeToUtcIso — callers
        // are responsible for zone conversion before calling
        // createEventIdempotent), so `timeZone` isn't load-bearing for
        // correctness here. Still included as good practice: it's what
        // Google's own examples do, and it affects how the event displays
        // (e.g. for anyone else who can see this calendar).
        start: { dateTime: start, timeZone: config.CALENDAR_TIMEZONE },
        end: { dateTime: endIso, timeZone: config.CALENDAR_TIMEZONE },
        extendedProperties: {
          private: { idempotencyKey },
        },
      },
    });
    logger.info({ idempotencyKey, durationMs: Date.now() - insertStartedAt }, 'createEventIdempotent: events.insert completed');

    const event = created.data;
    if (!event.id || !event.start?.dateTime || !event.end?.dateTime) {
      throw new Error(`createEventIdempotent: Google Calendar insert response missing required fields (idempotencyKey=${idempotencyKey})`);
    }

    logger.info({ idempotencyKey, eventId: event.id }, 'createEventIdempotent: created new event');
    return {
      eventId: event.id,
      confirmedStart: event.start.dateTime,
      confirmedEnd: event.end.dateTime,
    };
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.calendar.events.delete({
      calendarId: config.GOOGLE_CALENDAR_ID,
      eventId,
    });
  }

  /** Query freebusy for a single window and return normalized epoch-ms intervals. */
  private async getBusyIntervals(window: TimeWindow): Promise<BusyInterval[]> {
    const response = await this.calendar.freebusy.query({
      requestBody: {
        timeMin: window.start,
        timeMax: window.end,
        items: [{ id: config.GOOGLE_CALENDAR_ID }],
      },
    });

    const calendarBusy = response.data.calendars?.[config.GOOGLE_CALENDAR_ID]?.busy ?? [];

    return calendarBusy
      .filter((b): b is { start: string; end: string } => !!b.start && !!b.end)
      .map((b) => ({ startMs: Date.parse(b.start), endMs: Date.parse(b.end) }));
  }
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
function subtractBusyIntervals(window: BusyInterval, busy: BusyInterval[]): BusyInterval[] {
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
function chunkIntoWindows(interval: BusyInterval, durationMinutes: number): TimeWindow[] {
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
