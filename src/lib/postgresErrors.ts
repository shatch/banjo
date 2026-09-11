import postgres from 'postgres';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * drizzle-orm's postgres-js driver (pg-core/session.ts's queryWithCache)
 * never lets a raw driver error escape — every query error is wrapped in
 * drizzle's own `DrizzleQueryError`, with the original
 * `postgres.PostgresError` attached as `.cause`. So this must look at
 * `err.cause`, not `err` itself; `err instanceof postgres.PostgresError` is
 * never true for errors coming out of `db.insert`/`db.update` with this
 * driver. Verified empirically: a race test in
 * tests/googleContacts/reconcile.test.ts failed with an uncaught
 * DrizzleQueryError until this unwrap was added.
 *
 * Shared by every table-specific unique-violation check (e.g.
 * src/contacts/service.ts's isContactsUniqueViolation,
 * src/inbound/service.ts's createBooking) so the driver-wrapping quirk
 * above only has to be gotten right once.
 */
export function isPostgresUniqueViolation(err: unknown, constraintNames: string | Set<string>): boolean {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const pgErr = err instanceof postgres.PostgresError ? err : cause instanceof postgres.PostgresError ? cause : undefined;
  if (pgErr?.code !== PG_UNIQUE_VIOLATION || pgErr.constraint_name === undefined) return false;
  return typeof constraintNames === 'string' ? pgErr.constraint_name === constraintNames : constraintNames.has(pgErr.constraint_name);
}
