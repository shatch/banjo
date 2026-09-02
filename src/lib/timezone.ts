/**
 * Reads the wall-clock calendar date/time that a UTC instant displays as in
 * `timeZone` — the "what does this instant look like on a clock/calendar in
 * this zone" step of the DST-aware round-trip zonedTimeToUtcIso (below)
 * uses to compute an offset. Extracted as its own function because
 * src/inbound/businessHours.ts needs the same read (is this instant's local
 * hour/weekday within Mon-Fri 9-5) without needing the full
 * naive-string-to-UTC conversion zonedTimeToUtcIso does — a second
 * hand-rolled Intl.DateTimeFormat implementation would drift from this one.
 */
export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 (Sunday) - 6 (Saturday), matches Date#getUTCDay()
}

export function getZonedParts(utcIso: string, timeZone: string): ZonedParts {
  const instant = new Date(utcIso);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`getZonedParts: could not parse "${utcIso}" as a date-time`);
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(instant).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // hourCycle 'h23' can still render midnight as "24" in some ICU
  // implementations — normalize defensively.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  // Deriving weekday from the already-extracted Y/M/D via Date.UTC is safe
  // (no timezone ambiguity): a calendar date's day-of-week doesn't depend on
  // what UTC offset produced it.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return { year, month, day, hour, minute, second, weekday };
}

/**
 * Converts a "naive" local date-time string (no UTC offset, e.g.
 * "2026-08-04T14:00:00") — interpreted as wall-clock time in `timeZone` —
 * into a correct UTC ISO instant. If `input` already carries an explicit
 * offset or `Z`, it's trusted as-is and returned normalized (no ambiguity
 * to resolve, and re-interpreting it against `timeZone` would be wrong).
 *
 * This exists because a real appointment booking landed 4 hours off: the
 * model produced a bare "2026-08-04T14:00:00" (2pm, no offset), and
 * `new Date(...)` parses an offset-less date-time as local time to the
 * *server's* timezone (typically UTC), not the caller's — so "2pm" silently
 * became "2pm UTC" (10am Eastern). There's no npm dependency for this
 * because the standard technique below (round-tripping a timestamp through
 * Intl.DateTimeFormat) is reliable, DST-aware, and needs nothing beyond
 * Node's built-in ICU support.
 */
export function zonedTimeToUtcIso(input: string, timeZone: string): string {
  const HAS_EXPLICIT_OFFSET = /[Zz]$|[+-]\d{2}:\d{2}$/;
  if (HAS_EXPLICIT_OFFSET.test(input.trim())) {
    return new Date(input).toISOString();
  }

  // Step 1: interpret the naive string AS IF it were UTC, purely to get a
  // baseline instant to reason about (its actual meaning is still unknown).
  const asIfUtc = new Date(`${input.trim()}Z`);
  if (Number.isNaN(asIfUtc.getTime())) {
    throw new Error(`zonedTimeToUtcIso: could not parse "${input}" as a date-time`);
  }

  // Step 2: ask what that instant looks like when displayed in `timeZone`.
  const parts = getZonedParts(asIfUtc.toISOString(), timeZone);
  const asIfInZoneMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

  // Step 3: the gap between the two readings of the same instant IS the
  // zone's UTC offset at that moment (correctly DST-aware, since it's
  // derived from the real calendar date, not a fixed offset table). Apply
  // it to correct the baseline instant to the true UTC instant that
  // displays as `input` in `timeZone`.
  const offsetMs = asIfUtc.getTime() - asIfInZoneMs;
  return new Date(asIfUtc.getTime() + offsetMs).toISOString();
}

/**
 * The inverse direction of zonedTimeToUtcIso's core concern: given a UTC
 * instant, renders the local wall-clock date-time it displays as in
 * `timeZone`, WITHOUT a UTC offset — e.g. "2026-08-11T14:00:00" for
 * "2026-08-11T18:00:00.000Z" in America/New_York. Exists because tool
 * results handed back to the model (src/inbound/tools.ts) must never carry
 * a raw `Z`-suffixed UTC timestamp: buildBaseSystemPromptGuidance
 * (src/voice/systemPrompt.ts) tells the model every date/time it discusses
 * is in CALENDAR_TIMEZONE local time and explicitly instructs it not to
 * convert to UTC itself — handing back a `Z`-suffixed string forces exactly
 * that conversion, the same failure class as the 4-hour-off booking
 * incident documented on zonedTimeToUtcIso above. The output format matches
 * the offset-less local-time string confirm_appointment's schema
 * (voice/tools/callTools.ts) already asks the model to produce, so the
 * model sees one consistent local-time convention in both directions.
 */
export function formatInZone(utcIso: string, timeZone: string): string {
  const parts = getZonedParts(utcIso, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}
