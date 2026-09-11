import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { isPostgresUniqueViolation } from '../../src/lib/postgresErrors.js';

// The `postgres` package's own .d.ts only exposes PostgresError's standard
// Error(message, options?) constructor overloads — code/constraint_name
// etc. are declared as plain fields, populated at runtime via
// Object.assign (see node_modules/postgres/src/errors.js), not accepted as
// constructor arguments.
function makePostgresError(fields: { message: string; code: string; constraint_name?: string }): InstanceType<typeof postgres.PostgresError> {
  return Object.assign(new postgres.PostgresError(fields.message), fields);
}

// drizzle-orm's postgres-js driver wraps every query error in its own
// DrizzleQueryError, attaching the raw postgres.PostgresError as `.cause` —
// this is the shape a real db.insert()/db.update() call actually throws,
// as opposed to the bare PostgresError instance a naive test double might
// throw directly.
class FakeDrizzleQueryError extends Error {
  constructor(cause: unknown) {
    super('Failed query', { cause });
    this.name = 'DrizzleQueryError';
  }
}

describe('isPostgresUniqueViolation', () => {
  it('matches a bare PostgresError against a single constraint name', () => {
    const err = makePostgresError({ message: 'dup', code: '23505', constraint_name: 'contacts_phone_number_unique' });
    expect(isPostgresUniqueViolation(err, 'contacts_phone_number_unique')).toBe(true);
  });

  it("matches a drizzle-wrapped PostgresError via `.cause` — the shape a real db.insert()/db.update() call actually throws", () => {
    const pgErr = makePostgresError({ message: 'dup', code: '23505', constraint_name: 'inbound_bookings_one_active_per_caller' });
    const wrapped = new FakeDrizzleQueryError(pgErr);
    expect(isPostgresUniqueViolation(wrapped, 'inbound_bookings_one_active_per_caller')).toBe(true);
  });

  it('matches against a set of constraint names', () => {
    const pgErr = makePostgresError({ message: 'dup', code: '23505', constraint_name: 'contacts_google_resource_name_unique' });
    const wrapped = new FakeDrizzleQueryError(pgErr);
    expect(isPostgresUniqueViolation(wrapped, new Set(['contacts_phone_number_unique', 'contacts_google_resource_name_unique']))).toBe(true);
  });

  it('returns false for a unique violation on an unrelated constraint', () => {
    const pgErr = makePostgresError({ message: 'dup', code: '23505', constraint_name: 'inbound_calls_twilio_call_sid_unique' });
    const wrapped = new FakeDrizzleQueryError(pgErr);
    expect(isPostgresUniqueViolation(wrapped, 'inbound_bookings_one_active_per_caller')).toBe(false);
  });

  it('returns false for a non-unique-violation Postgres error code', () => {
    const pgErr = makePostgresError({ message: 'connection lost', code: '08006' });
    const wrapped = new FakeDrizzleQueryError(pgErr);
    expect(isPostgresUniqueViolation(wrapped, 'inbound_bookings_one_active_per_caller')).toBe(false);
  });

  it('returns false for an error unrelated to Postgres entirely', () => {
    expect(isPostgresUniqueViolation(new Error('boom'), 'inbound_bookings_one_active_per_caller')).toBe(false);
  });
});
