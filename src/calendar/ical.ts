/**
 * Just enough iCalendar (RFC 5545) for CaldavCalendarProvider: read the
 * VEVENTs a CalDAV server returns, turn them into busy intervals, and write
 * Banjo's own booking events. Recurrence is deliberately NOT handled here —
 * the provider asks the server to expand recurring events into instances
 * (CalDAV's <C:expand>), and busyIntervalsFromEvents refuses an unexpanded
 * recurring event rather than silently treating it as one occurrence.
 */

import { zonedTimeToUtcIso } from '../lib/timezone.js';
import type { BusyInterval } from './freeSlots.js';

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 24 * 60 * 60 * MS_PER_SECOND;

export interface ICalProperty {
  name: string; // upper-cased, e.g. "DTSTART"
  params: Record<string, string>; // upper-cased keys, unquoted values
  value: string; // raw, still escaped
}

export interface ICalComponent {
  name: string; // upper-cased, e.g. "VEVENT"
  properties: ICalProperty[];
  components: ICalComponent[];
}

/** Parses iCalendar text into its top-level components (normally one VCALENDAR). */
export function parseICalendar(text: string): ICalComponent[] {
  // Unfold first: a CRLF (or bare LF) followed by one space or tab continues the previous line.
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const root: ICalComponent = { name: '', properties: [], components: [] };
  const stack: ICalComponent[] = [root];

  for (const line of lines) {
    if (!line.trim()) continue;
    const prop = parseProperty(line);
    if (!prop) continue;
    const current = stack[stack.length - 1]!;
    if (prop.name === 'BEGIN') {
      const component: ICalComponent = { name: prop.value.toUpperCase(), properties: [], components: [] };
      current.components.push(component);
      stack.push(component);
    } else if (prop.name === 'END') {
      if (stack.length > 1) stack.pop();
    } else {
      current.properties.push(prop);
    }
  }

  return root.components;
}

/** Every VEVENT anywhere in the parsed tree. */
export function findEvents(components: ICalComponent[]): ICalComponent[] {
  const events: ICalComponent[] = [];
  for (const component of components) {
    if (component.name === 'VEVENT') events.push(component);
    events.push(...findEvents(component.components));
  }
  return events;
}

function parseProperty(line: string): ICalProperty | undefined {
  // Name runs to the first ';' or ':'. Params follow, and a quoted param
  // value may itself contain ';' or ':', so scan rather than split.
  const nameEnd = line.search(/[;:]/);
  if (nameEnd <= 0) return undefined;
  const name = line.slice(0, nameEnd).toUpperCase();
  const params: Record<string, string> = {};

  let i = nameEnd;
  while (line[i] === ';') {
    i++;
    const eq = line.indexOf('=', i);
    if (eq === -1) return undefined;
    const key = line.slice(i, eq).toUpperCase();
    i = eq + 1;
    let value = '';
    if (line[i] === '"') {
      const close = line.indexOf('"', i + 1);
      if (close === -1) return undefined;
      value = line.slice(i + 1, close);
      i = close + 1;
    } else {
      const end = line.slice(i).search(/[;:]/);
      if (end === -1) return undefined;
      value = line.slice(i, i + end);
      i += end;
    }
    params[key] = value;
  }

  if (line[i] !== ':') return undefined;
  return { name, params, value: line.slice(i + 1) };
}

export function getProperty(component: ICalComponent, name: string): ICalProperty | undefined {
  return component.properties.find((p) => p.name === name);
}

export interface ParsedInstant {
  ms: number;
  allDay: boolean;
}

/**
 * Reads a DATE or DATE-TIME property as an instant. UTC ("...Z") is taken
 * as-is; a TZID is honored; a floating time (neither) or an all-day DATE is
 * read in `defaultTimeZone` — CALENDAR_TIMEZONE, the same zone every other
 * time on a call means. An unknown TZID throws (Intl rejects it), which
 * fails the availability check closed instead of guessing a zone.
 */
export function parseInstant(prop: ICalProperty, defaultTimeZone: string): ParsedInstant {
  const value = prop.value.trim();

  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date) {
    const [, y, m, d] = date;
    return { ms: Date.parse(zonedTimeToUtcIso(`${y}-${m}-${d}T00:00:00`, defaultTimeZone)), allDay: true };
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(value);
  if (!dateTime) throw new Error(`Unparseable iCalendar ${prop.name} value "${value}"`);
  const [, y, m, d, hh, mm, ss, utc] = dateTime;
  const naive = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  if (utc) return { ms: Date.parse(`${naive}Z`), allDay: false };

  // Some clients write a path-style TZID ("/America/New_York").
  const timeZone = prop.params.TZID?.replace(/^\//, '') || defaultTimeZone;
  return { ms: Date.parse(zonedTimeToUtcIso(naive, timeZone)), allDay: false };
}

/** An RFC 5545 DURATION ("PT30M", "P1D", "P1W", "-PT15M") in milliseconds. */
export function parseDurationMs(value: string): number {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) throw new Error(`Unparseable iCalendar DURATION "${value}"`);
  const [, sign, w, d, h, m, s] = match;
  const seconds = Number(w ?? 0) * 604_800 + Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return (sign === '-' ? -1 : 1) * seconds * MS_PER_SECOND;
}

/** Start and end of one VEVENT, or undefined if it has no DTSTART. */
export function eventSpan(event: ICalComponent, defaultTimeZone: string): (BusyInterval & { allDay: boolean }) | undefined {
  const dtstart = getProperty(event, 'DTSTART');
  if (!dtstart) return undefined;
  const start = parseInstant(dtstart, defaultTimeZone);

  const dtend = getProperty(event, 'DTEND');
  const duration = getProperty(event, 'DURATION');
  let endMs: number;
  if (dtend) endMs = parseInstant(dtend, defaultTimeZone).ms;
  else if (duration) endMs = start.ms + parseDurationMs(duration.value);
  // RFC 5545 §3.6.1: with neither, an all-day event lasts one day and a timed one takes no time.
  else endMs = start.allDay ? start.ms + MS_PER_DAY : start.ms;

  return { startMs: start.ms, endMs, allDay: start.allDay };
}

export interface BusyOptions {
  /** CALENDAR_TIMEZONE — for floating times and all-day dates. */
  timeZone: string;
  /** The calendar owner's address, to skip invitations they declined. */
  ownerEmail?: string;
}

/**
 * The busy intervals among already-expanded VEVENTs. Mirrors what Google's
 * freebusy query counts, so switching providers doesn't change which slots
 * Banjo offers:
 * - cancelled events and events marked free (TRANSP:TRANSPARENT) don't block;
 * - invitations the owner declined don't block;
 * - all-day events block only when explicitly marked busy (TRANSP:OPAQUE) —
 *   a birthday or a holiday shouldn't make a whole day unbookable.
 */
export function busyIntervalsFromEvents(events: ICalComponent[], { timeZone, ownerEmail }: BusyOptions): BusyInterval[] {
  const busy: BusyInterval[] = [];
  const owner = ownerEmail ? `mailto:${ownerEmail.toLowerCase()}` : undefined;

  for (const event of events) {
    if (getProperty(event, 'RRULE') || getProperty(event, 'RDATE')) {
      // The server ignored <C:expand>. Treating the master event as a single
      // occurrence would report every later occurrence as free, so refuse.
      const uid = getProperty(event, 'UID')?.value ?? 'unknown';
      throw new Error(`CalDAV server returned an unexpanded recurring event (UID ${uid}); cannot compute availability safely`);
    }
    if (getProperty(event, 'STATUS')?.value.toUpperCase() === 'CANCELLED') continue;

    const declined =
      owner !== undefined &&
      event.properties.some(
        (p) => p.name === 'ATTENDEE' && p.value.toLowerCase() === owner && p.params.PARTSTAT?.toUpperCase() === 'DECLINED',
      );
    if (declined) continue;

    const span = eventSpan(event, timeZone);
    if (!span) continue;

    const transp = getProperty(event, 'TRANSP')?.value.toUpperCase();
    if (transp === 'TRANSPARENT') continue;
    if (span.allDay && transp !== 'OPAQUE') continue;

    busy.push({ startMs: span.startMs, endMs: span.endMs });
  }

  return busy;
}

/** RFC 5545 TEXT escaping. */
export function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** "20260805T180000Z" — the UTC DATE-TIME form. */
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** Folds one content line at 75 octets (RFC 5545 §3.1), never splitting a UTF-8 character. */
function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (currentBytes + bytes > limit) {
      out.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  out.push(current);
  return out.join('\r\n ');
}

export interface BookingEvent {
  uid: string;
  startMs: number;
  endMs: number;
  summary: string;
  description?: string;
  idempotencyKey: string;
}

/**
 * A complete VCALENDAR for one Banjo booking. Times are written in UTC:
 * callers have already converted spoken local times (zonedTimeToUtcIso), and
 * calendar apps display UTC events in the viewer's own zone.
 */
export function buildBookingCalendar({ uid, startMs, endMs, summary, description, idempotencyKey }: BookingEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Banjo//CalDAV//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatUtc(Date.now())}`,
    `DTSTART:${formatUtc(startMs)}`,
    `DTEND:${formatUtc(endMs)}`,
    `SUMMARY:${escapeText(summary)}`,
    ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
    'TRANSP:OPAQUE',
    // Informational only — the resource name is what makes the write
    // idempotent (see CaldavCalendarProvider). Kept so a person looking at
    // the raw event can tell which call booked it.
    `X-BANJO-IDEMPOTENCY-KEY:${escapeText(idempotencyKey)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
