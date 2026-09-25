/**
 * CalendarProvider for any CalDAV server — Fastmail, iCloud, Nextcloud,
 * Radicale. Authenticates with HTTP Basic and an app password, so unlike
 * GoogleCalendarProvider there's no OAuth consent flow to run first.
 *
 * Idempotency works differently from Google, and more strongly. Google's
 * version searches for an event tagged with the idempotency key, then
 * inserts — two near-simultaneous calls can both pass the search (Open
 * Risks #8 in docs/ARCHITECTURE.md). Here the key determines the event's
 * resource name, and the event is written with `If-None-Match: *`, so the
 * server itself refuses a second create under the same key. The free-slot
 * guard before it is still check-then-write, exactly as in Google's version.
 */

import { createHash } from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import type { TimeWindow } from '../tasks/schema.js';
import { davRequest, isOkStatus, parseMultistatus, textOf, type DavCredentials } from '../lib/dav/davHttp.js';
import { chunkIntoWindows, subtractBusyIntervals, type BusyInterval } from './freeSlots.js';
import { buildBookingCalendar, busyIntervalsFromEvents, eventSpan, findEvents, formatUtc, parseICalendar } from './ical.js';
import {
  SlotUnavailableError,
  type CalendarProvider,
  type CheckAvailabilityInput,
  type CreateEventInput,
  type CreateEventResult,
  type IsFreeInput,
} from './types.js';

const MS_PER_MINUTE = 60_000;

export interface CaldavCalendarOptions {
  /** The calendar collection, e.g. https://caldav.fastmail.com/dav/calendars/user/me@fastmail.com/<id>/ */
  calendarUrl: string;
  username: string;
  password: string;
  /** CALENDAR_TIMEZONE — how floating times and all-day dates are read. */
  timeZone: string;
}

function optionsFromConfig(): CaldavCalendarOptions {
  if (!config.CALDAV_CALENDAR_URL || !config.DAV_USERNAME || !config.DAV_PASSWORD) {
    // Unreachable when CALENDAR_PROVIDER=caldav — config's refine requires all three.
    throw new Error('CaldavCalendarProvider needs CALDAV_CALENDAR_URL, DAV_USERNAME, and DAV_PASSWORD');
  }
  return {
    calendarUrl: config.CALDAV_CALENDAR_URL,
    username: config.DAV_USERNAME,
    password: config.DAV_PASSWORD,
    timeZone: config.CALENDAR_TIMEZONE,
  };
}

/**
 * The event's resource name (and UID) for an idempotency key. Hashed rather
 * than escaped: keys contain ':' and timestamps (see inbound's
 * `inbound-reschedule:<id>:<iso>`), and a hash gives every key a distinct,
 * URL-safe name with no escaping rules to get wrong.
 */
export function resourceNameForKey(idempotencyKey: string): string {
  return `banjo-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40)}.ics`;
}

export class CaldavCalendarProvider implements CalendarProvider {
  private readonly calendarUrl: string;
  private readonly credentials: DavCredentials;
  private readonly timeZone: string;
  private readonly ownerEmail: string | undefined;

  constructor(options: CaldavCalendarOptions = optionsFromConfig()) {
    // Resource names resolve relative to the collection, which needs a trailing slash.
    this.calendarUrl = options.calendarUrl.endsWith('/') ? options.calendarUrl : `${options.calendarUrl}/`;
    this.credentials = { username: options.username, password: options.password };
    this.timeZone = options.timeZone;
    // Fastmail and iCloud usernames are the account's email address — the
    // address declined invitations are addressed to.
    this.ownerEmail = options.username.includes('@') ? options.username : undefined;
  }

  async computeCandidateWindows({ dateWindows, durationMinutes }: CheckAvailabilityInput): Promise<TimeWindow[]> {
    const candidates: TimeWindow[] = [];
    for (const window of dateWindows) {
      const busy = await this.getBusyIntervals(window);
      const freeIntervals = subtractBusyIntervals({ startMs: Date.parse(window.start), endMs: Date.parse(window.end) }, busy);
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
    return !busy.some((b) => b.startMs < endMs && b.endMs > startMs);
  }

  async findEventByIdempotencyKey(idempotencyKey: string): Promise<CreateEventResult | undefined> {
    const eventId = resourceNameForKey(idempotencyKey);
    const response = await davRequest({
      method: 'GET',
      url: this.eventUrl(eventId),
      credentials: this.credentials,
      allowStatuses: [404, 410],
    });
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      return undefined;
    }

    // Read the event back rather than assuming what we wrote: the owner may
    // have moved it in their calendar app since.
    const [event] = findEvents(parseICalendar(await response.text()));
    const span = event ? eventSpan(event, this.timeZone) : undefined;
    if (!span) return undefined;
    return {
      eventId,
      confirmedStart: new Date(span.startMs).toISOString(),
      confirmedEnd: new Date(span.endMs).toISOString(),
    };
  }

  async createEventIdempotent({ idempotencyKey, start, durationMinutes, summary, description }: CreateEventInput): Promise<CreateEventResult> {
    // Both are read-only lookups, so run them together — this is on a live call.
    const guardCheckStartedAt = Date.now();
    const [existing, free] = await Promise.all([this.findEventByIdempotencyKey(idempotencyKey), this.isFree({ start, durationMinutes })]);
    logger.info({ idempotencyKey, durationMs: Date.now() - guardCheckStartedAt }, 'createEventIdempotent: idempotency + free-slot guard checks completed');

    if (existing) {
      logger.info({ idempotencyKey, eventId: existing.eventId }, 'createEventIdempotent: found existing event, skipping insert');
      return existing;
    }
    if (!free) {
      logger.warn({ idempotencyKey, start, durationMinutes }, 'createEventIdempotent: requested slot is no longer free, refusing to double-book');
      throw new SlotUnavailableError();
    }

    const eventId = resourceNameForKey(idempotencyKey);
    const startMs = Date.parse(start);
    const endMs = startMs + durationMinutes * MS_PER_MINUTE;

    const insertStartedAt = Date.now();
    const response = await davRequest({
      method: 'PUT',
      url: this.eventUrl(eventId),
      credentials: this.credentials,
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
      body: buildBookingCalendar({ uid: eventId.replace(/\.ics$/, ''), startMs, endMs, summary, description, idempotencyKey }),
      allowStatuses: [412],
    });
    await response.body?.cancel();
    logger.info({ idempotencyKey, durationMs: Date.now() - insertStartedAt }, 'createEventIdempotent: PUT completed');

    if (response.status === 412) {
      // Another attempt with the same key created it between our check and
      // our write. That's the retry this guards against — return its event.
      const raced = await this.findEventByIdempotencyKey(idempotencyKey);
      if (!raced) throw new Error(`createEventIdempotent: create refused as a duplicate but no event found (idempotencyKey=${idempotencyKey})`);
      logger.info({ idempotencyKey, eventId: raced.eventId }, 'createEventIdempotent: concurrent create won, returning its event');
      return raced;
    }

    logger.info({ idempotencyKey, eventId }, 'createEventIdempotent: created new event');
    return { eventId, confirmedStart: new Date(startMs).toISOString(), confirmedEnd: new Date(endMs).toISOString() };
  }

  async deleteEvent(eventId: string): Promise<void> {
    // Already gone (e.g. the owner deleted it by hand) is the outcome we
    // wanted, so it isn't an error — reschedule deletes then recreates, and
    // shouldn't fail on an event that's no longer there.
    const response = await davRequest({
      method: 'DELETE',
      url: this.eventUrl(eventId),
      credentials: this.credentials,
      allowStatuses: [404, 410],
    });
    await response.body?.cancel();
  }

  private eventUrl(eventId: string): string {
    return new URL(encodeURIComponent(eventId), this.calendarUrl).toString();
  }

  /**
   * Every event overlapping `window`, with recurring events expanded into
   * instances by the server, reduced to the intervals that block booking.
   * Public (though not part of CalendarProvider) so scripts/dav-check.ts
   * can show what Banjo will treat as busy.
   */
  async getBusyIntervals(window: TimeWindow): Promise<BusyInterval[]> {
    const rangeStart = formatUtc(Date.parse(window.start));
    const rangeEnd = formatUtc(Date.parse(window.end));
    const response = await davRequest({
      method: 'REPORT',
      url: this.calendarUrl,
      credentials: this.credentials,
      headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-data>
      <c:expand start="${rangeStart}" end="${rangeEnd}"/>
    </c:calendar-data>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${rangeStart}" end="${rangeEnd}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
    });

    const busy: BusyInterval[] = [];
    for (const resource of parseMultistatus(await response.text())) {
      if (resource.status && !isOkStatus(resource.status)) {
        // e.g. 507: the server truncated the results. A partial list of busy
        // times would make busy slots look free, so fail instead.
        throw new Error(`CalDAV availability query returned ${resource.status} for ${resource.href}`);
      }
      for (const propstat of resource.propstats) {
        if (!isOkStatus(propstat.status)) continue;
        const calendarData = textOf(propstat.prop['calendar-data']);
        if (!calendarData) continue;
        const events = findEvents(parseICalendar(calendarData));
        busy.push(...busyIntervalsFromEvents(events, { timeZone: this.timeZone, ownerEmail: this.ownerEmail }));
      }
    }
    return busy;
  }
}
