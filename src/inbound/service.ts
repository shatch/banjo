import { and, desc, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '../db/index.js';
import { inboundBookings, inboundCalls, type InboundBooking, type InboundCall } from './schema.js';

/**
 * The only module that writes inboundCalls/inboundBookings rows — mirrors
 * tasks/service.ts's role for the outbound path (one place to log every
 * transition, keeps orchestration/tool code from racing on updatedAt).
 */

// Same pattern as src/config/index.ts's `e164` schema — a leading `+`, no
// spaces/dashes/parens. Twilio sends the literal string "anonymous" (not an
// E.164 number) as the `From` value when a caller withholds their caller
// ID; without this guard, findActiveBookingForCaller would treat
// "anonymous" as a real, exact-match identity and collapse every
// blocked-ID caller into one shared booking, letting caller B see/reschedule
// caller A's booking via find_my_booking/reschedule_booking.
//
// Exported (not module-private) so src/inbound/tools.ts's book_appointment
// and reschedule_booking handlers can pre-validate ctx.callerPhoneNumber
// against this exact same pattern BEFORE writing anything — an identity
// that findActiveBookingForCaller can never resolve on read (a non-E.164
// placeholder) must also never be allowed to write a booking. Without that
// write-side guard, two different anonymous callers each pass the
// pre-check (findActiveBookingForCaller("anonymous") finds nothing for
// either, since it refuses to query), both create a real calendar event,
// and only the second one's DB insert fails against the partial unique
// index — after the calendar event was already created and is never
// rolled back.
export const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

export async function createInboundCall(input: { twilioCallSid: string; callerPhoneNumber: string; contactId?: string }): Promise<InboundCall> {
  const [row] = await db.insert(inboundCalls).values(input).returning();
  if (!row) throw new Error('Failed to insert inbound call');
  return row;
}

export async function updateInboundCall(id: string, patch: Partial<Pick<InboundCall, 'status'>>): Promise<InboundCall> {
  const [row] = await db
    .update(inboundCalls)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(inboundCalls.id, id))
    .returning();
  if (!row) throw new Error(`Inbound call not found: ${id}`);
  return row;
}

/**
 * The security/structural lookup at the heart of find_my_booking and
 * reschedule_booking (src/inbound/tools.ts) — resolves "whoever is calling
 * right now's own active booking" from their phone number alone. A caller
 * can have at most one active booking at a time (enforced by
 * book_appointment checking this before creating a new one), so this never
 * needs to disambiguate between multiple active rows for the same number.
 *
 * Refuses to query at all unless `callerPhoneNumber` is a valid E.164
 * string — see E164_PATTERN above. This is the caller-identity-resolving
 * read path (the security boundary find_my_booking/reschedule_booking rely
 * on), so a non-E.164 placeholder like "anonymous" must never match
 * anything, rather than being trusted as an exact-match identity.
 */
export async function findActiveBookingForCaller(callerPhoneNumber: string): Promise<InboundBooking | undefined> {
  if (!E164_PATTERN.test(callerPhoneNumber)) return undefined;

  const [row] = await db
    .select()
    .from(inboundBookings)
    .where(and(eq(inboundBookings.callerPhoneNumber, callerPhoneNumber), eq(inboundBookings.status, 'active')))
    .orderBy(desc(inboundBookings.createdAt))
    .limit(1);
  return row;
}

interface BookingInput {
  inboundCallId: string;
  callerPhoneNumber: string;
  calendarEventId: string;
  confirmedStart: string; // ISO 8601
  durationMinutes: number;
  purpose: string;
  callerName: string;
}

/**
 * Thrown by createBooking when the database's
 * `inbound_bookings_one_active_per_caller` partial unique index
 * (src/inbound/schema.ts) rejects the insert because this caller already
 * has another row with status = 'active'. This is the database-level
 * backstop for the same "one active booking per caller" invariant
 * book_appointment's pre-check (findActiveBookingForCaller) already
 * enforces at the application level — the index closes the race where a
 * timeout-retried book_appointment call passes that pre-check twice before
 * either insert commits. Mirrors SlotUnavailableError's role
 * (src/calendar/types.ts): a specific, catchable error so the caller
 * (book_appointment's handler in tools.ts) can translate it into the same
 * "already_has_active_booking" shape used for the pre-check case, instead
 * of it surfacing as an opaque upstream_error.
 */
export class ActiveBookingConflictError extends Error {
  constructor(message = 'Caller already has an active booking.') {
    super(message);
    this.name = 'ActiveBookingConflictError';
  }
}

// Postgres unique_violation — see
// https://www.postgresql.org/docs/current/errcodes-appendix.html.
const PG_UNIQUE_VIOLATION = '23505';
const ONE_ACTIVE_PER_CALLER_CONSTRAINT = 'inbound_bookings_one_active_per_caller';

export async function createBooking(input: BookingInput): Promise<InboundBooking> {
  try {
    const [row] = await db
      .insert(inboundBookings)
      .values({ ...input, confirmedStart: new Date(input.confirmedStart) })
      .returning();
    if (!row) throw new Error('Failed to insert inbound booking');
    return row;
  } catch (err) {
    if (err instanceof postgres.PostgresError && err.code === PG_UNIQUE_VIOLATION && err.constraint_name === ONE_ACTIVE_PER_CALLER_CONSTRAINT) {
      throw new ActiveBookingConflictError();
    }
    throw err;
  }
}

/**
 * Reschedule as an immutable append: the old row flips to 'rescheduled' and
 * a new row is inserted 'active', linked back via previousBookingId — both
 * writes happen in one transaction so a crash between them can never leave
 * two 'active' rows (or zero) for the same caller.
 *
 * The WHERE clause below guards on `status = 'active'` in addition to id —
 * not redundant with the id lookup. runToolSafely (voice/tools/callTools.ts)
 * races the whole reschedule_booking handler against TOOL_TIMEOUT_MS without
 * cancelling the in-flight work, so a slow request can return a client-side
 * timeout while this transaction is still completing. If the model retries
 * reschedule_booking for the same booking, the first attempt may have
 * already flipped this row to 'rescheduled' and inserted a new 'active' row.
 * Without this guard, the retried call would re-flip the (already
 * 'rescheduled') row and insert a *second* 'active' row for the same
 * caller — findActiveBookingForCaller's LIMIT 1 would then silently hide
 * one of them. With the guard, a retry matches zero rows and throws the
 * same not-found error below, instead of corrupting the data.
 */
export async function supersedeBooking(previousBookingId: string, input: BookingInput): Promise<InboundBooking> {
  return db.transaction(async (tx) => {
    const [old] = await tx
      .update(inboundBookings)
      .set({ status: 'rescheduled', updatedAt: new Date() })
      .where(and(eq(inboundBookings.id, previousBookingId), eq(inboundBookings.status, 'active')))
      .returning();
    if (!old) throw new Error(`Inbound booking not found: ${previousBookingId}`);

    const [next] = await tx
      .insert(inboundBookings)
      .values({ ...input, confirmedStart: new Date(input.confirmedStart), previousBookingId })
      .returning();
    if (!next) throw new Error('Failed to insert superseding inbound booking');
    return next;
  });
}

export async function cancelBooking(id: string): Promise<InboundBooking> {
  const [row] = await db
    .update(inboundBookings)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(inboundBookings.id, id))
    .returning();
  if (!row) throw new Error(`Inbound booking not found: ${id}`);
  return row;
}
