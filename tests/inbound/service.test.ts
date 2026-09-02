import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inboundBookings } from '../../src/inbound/schema.js';

// A minimal fake of drizzle's fluent query builder, wired the same way for
// every test (tx.update(...).set(...).where(...).returning() and
// tx.insert(...).values(...).returning()) — only the *resolved* value of
// each `.returning()` call varies per test, which is enough to exercise
// supersedeBooking's control flow without a real Postgres connection.
// vi.clearAllMocks() (below) clears call history but not the
// mockImplementation wiring set up here, so this only needs to run once.
const txUpdateSet = vi.fn();
const txUpdateWhere = vi.fn();
const txUpdateReturning = vi.fn();
const txInsertValues = vi.fn();
const txInsertReturning = vi.fn();

txUpdateSet.mockImplementation(() => ({ where: txUpdateWhere }));
txUpdateWhere.mockImplementation(() => ({ returning: txUpdateReturning }));
txInsertValues.mockImplementation(() => ({ returning: txInsertReturning }));

const tx = {
  update: vi.fn(() => ({ set: txUpdateSet })),
  insert: vi.fn(() => ({ values: txInsertValues })),
};

const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));

// Separate fakes for findActiveBookingForCaller's db.select(...) chain and
// createBooking's (non-transactional) db.insert(...) chain — neither of
// those functions goes through db.transaction, so they're wired directly
// onto the same mocked `db` object below rather than onto `tx` above.
const selectFrom = vi.fn();
const selectWhere = vi.fn();
const selectOrderBy = vi.fn();
const selectLimit = vi.fn();

selectFrom.mockImplementation(() => ({ where: selectWhere }));
selectWhere.mockImplementation(() => ({ orderBy: selectOrderBy }));
selectOrderBy.mockImplementation(() => ({ limit: selectLimit }));

const selectMock = vi.fn(() => ({ from: selectFrom }));

const dbInsertValues = vi.fn();
const dbInsertReturning = vi.fn();
dbInsertValues.mockImplementation(() => ({ returning: dbInsertReturning }));
const dbInsertMock = vi.fn(() => ({ values: dbInsertValues }));

vi.mock('../../src/db/index.js', () => ({
  db: { transaction: transactionMock, select: selectMock, insert: dbInsertMock },
}));

const { ActiveBookingConflictError, createBooking, findActiveBookingForCaller, supersedeBooking } = await import(
  '../../src/inbound/service.js'
);

const BOOKING_INPUT = {
  inboundCallId: 'inbound-call-1',
  callerPhoneNumber: '+15555550100',
  calendarEventId: 'evt-new',
  confirmedStart: '2026-08-11T18:00:00.000Z',
  durationMinutes: 30,
  purpose: 'Consultation',
  callerName: 'Jamie Rivera',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('supersedeBooking (retry safety)', () => {
  it("guards the UPDATE's WHERE clause on status = 'active' in addition to id — not just an id lookup", async () => {
    // This is the actual regression check for the fix: asserts the exact
    // WHERE condition passed to the query builder, not just the resulting
    // control flow (which the next test covers). Before the fix, this
    // WHERE clause was `eq(inboundBookings.id, previousBookingId)` alone —
    // this would fail against that version, since the two conditions are
    // structurally different (an `and(...)` of two eq()s vs. a bare eq()).
    txUpdateReturning.mockResolvedValue([{ id: 'booking-1', status: 'rescheduled' }]);
    txInsertReturning.mockResolvedValue([{ id: 'booking-2', status: 'active', ...BOOKING_INPUT }]);

    await supersedeBooking('booking-1', BOOKING_INPUT);

    expect(txUpdateWhere).toHaveBeenCalledWith(and(eq(inboundBookings.id, 'booking-1'), eq(inboundBookings.status, 'active')));
  });

  it('supersedes an active booking: flips the old row and inserts a new active one', async () => {
    txUpdateReturning.mockResolvedValue([{ id: 'booking-1', status: 'rescheduled' }]);
    txInsertReturning.mockResolvedValue([{ id: 'booking-2', status: 'active', ...BOOKING_INPUT }]);

    const result = await supersedeBooking('booking-1', BOOKING_INPUT);

    expect(result).toMatchObject({ id: 'booking-2', status: 'active' });
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });

  it('throws (rather than re-superseding) when the target row is no longer active — the WHERE clause guard closes the double-active-row bug from a timed-out-then-retried reschedule_booking call', async () => {
    // Simulates the exact scenario the fix targets: the WHERE clause now
    // includes `status = 'active'`, so a retry against a row that a first
    // (successful, but slow enough to have looked like a timeout to the
    // caller) attempt already flipped to 'rescheduled' matches zero rows.
    txUpdateReturning.mockResolvedValue([]);

    await expect(supersedeBooking('booking-1', BOOKING_INPUT)).rejects.toThrow('Inbound booking not found: booking-1');

    // The critical assertion: no second 'active' row gets inserted for a
    // row that didn't match the guarded UPDATE. Before the fix, the
    // equivalent unguarded UPDATE would have matched the row regardless of
    // its status, re-flipped it, and this insert would have run —
    // producing two 'active' rows for the same caller.
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe('findActiveBookingForCaller (caller-identity validation)', () => {
  it('refuses to query and returns undefined for a non-E.164 placeholder like "anonymous"', async () => {
    // Twilio's documented behavior for a withheld/blocked caller ID: the
    // `From` field is the literal string "anonymous", not a real E.164
    // number. Without this guard, two different blocked-ID callers would
    // collapse into the same identity and one could see/reschedule the
    // other's booking.
    const result = await findActiveBookingForCaller('anonymous');

    expect(result).toBeUndefined();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each(['', '5555550100', '+0555550100', '+1 555 555 0100', '+1555555010000000'])(
    'refuses to query and returns undefined for another non-E.164 value: %j',
    async (value) => {
      const result = await findActiveBookingForCaller(value);
      expect(result).toBeUndefined();
      expect(selectMock).not.toHaveBeenCalled();
    },
  );

  it('queries normally for a valid E.164 caller number', async () => {
    selectLimit.mockResolvedValue([{ id: 'booking-1', callerPhoneNumber: '+15555550100', status: 'active' }]);

    const result = await findActiveBookingForCaller('+15555550100');

    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(selectWhere).toHaveBeenCalledWith(
      and(eq(inboundBookings.callerPhoneNumber, '+15555550100'), eq(inboundBookings.status, 'active')),
    );
    expect(result).toMatchObject({ id: 'booking-1' });
  });
});

// The `postgres` package's own .d.ts only exposes PostgresError's standard
// Error(message, options?) constructor overloads — code/constraint_name
// etc. are declared as plain fields, populated at runtime via
// Object.assign (see node_modules/postgres/src/errors.js), not accepted as
// constructor arguments. Building one for tests the same way keeps this
// aligned with how the real driver actually produces these errors.
function makePostgresError(fields: { message: string; code: string; constraint_name?: string }): InstanceType<typeof postgres.PostgresError> {
  return Object.assign(new postgres.PostgresError(fields.message), fields);
}

describe('createBooking (database-level one-active-per-caller guard)', () => {
  it('translates a unique-constraint violation on the partial index into ActiveBookingConflictError', async () => {
    dbInsertReturning.mockRejectedValue(
      makePostgresError({
        message: 'duplicate key value violates unique constraint "inbound_bookings_one_active_per_caller"',
        code: '23505',
        constraint_name: 'inbound_bookings_one_active_per_caller',
      }),
    );

    await expect(createBooking(BOOKING_INPUT)).rejects.toThrow(ActiveBookingConflictError);
  });

  it('rethrows an unrelated PostgresError unchanged', async () => {
    const unrelated = makePostgresError({ message: 'connection lost', code: '08006' });
    dbInsertReturning.mockRejectedValue(unrelated);

    await expect(createBooking(BOOKING_INPUT)).rejects.toBe(unrelated);
  });

  it('rethrows a unique-constraint violation on a different constraint unchanged', async () => {
    const unrelated = makePostgresError({
      message: 'duplicate key value violates unique constraint "inbound_calls_twilio_call_sid_unique"',
      code: '23505',
      constraint_name: 'inbound_calls_twilio_call_sid_unique',
    });
    dbInsertReturning.mockRejectedValue(unrelated);

    await expect(createBooking(BOOKING_INPUT)).rejects.toBe(unrelated);
  });

  it('returns the inserted row on success', async () => {
    dbInsertReturning.mockResolvedValue([{ id: 'booking-1', status: 'active', ...BOOKING_INPUT }]);

    const result = await createBooking(BOOKING_INPUT);

    expect(result).toMatchObject({ id: 'booking-1', status: 'active' });
  });
});
