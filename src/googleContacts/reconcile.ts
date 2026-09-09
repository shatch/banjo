import postgres from 'postgres';
import {
  addContact,
  getContactByGoogleResourceName,
  getContactByPhoneNumber,
  updateContact,
} from '../contacts/service.js';
import type { Contact, NewContact } from '../contacts/schema.js';
import type { GoogleContactMatch } from './lookup.js';

const PG_UNIQUE_VIOLATION = '23505';
// Both unique indexes on `contacts` (added in Task 1) are reachable from
// provisioning: the phone-number one on a concurrent insert of the same new
// person, and the google-resource-name one when a Google contact's phone
// number changed (the cache row moved to the new number, but the previously
// provisioned local row still holds the old number AND this resourceName).
const CONTACTS_UNIQUE_CONSTRAINTS = new Set(['contacts_phone_number_unique', 'contacts_google_resource_name_unique']);

const FAMILY_RELATION_TYPES = new Set([
  'spouse',
  'child',
  'parent',
  'mother',
  'father',
  'sibling',
  'brother',
  'sister',
  'domesticpartner',
  'partner',
  'relative',
]);
const FAMILY_GROUP_NAMES = new Set(['family']);
const FRIEND_GROUP_NAMES = new Set(['friends']);

/**
 * Heuristic, not a guarantee — depends entirely on how the principal has
 * organized their own Google Contacts. An unlabeled contact simply stays
 * null (behaves like any other business contact), which is an acceptable
 * default, not a failure. See the design spec's "Deriving relationshipTier"
 * section.
 */
function deriveRelationshipTier(match: GoogleContactMatch): Contact['relationshipTier'] {
  const hasFamilyRelation = match.relationLabels.some((label) => FAMILY_RELATION_TYPES.has(label.toLowerCase()));
  const inFamilyGroup = match.groupLabels.some((label) => FAMILY_GROUP_NAMES.has(label.toLowerCase()));
  if (hasFamilyRelation || inFamilyGroup) return 'family';
  if (match.groupLabels.some((label) => FRIEND_GROUP_NAMES.has(label.toLowerCase()))) return 'friend';
  return null;
}

/**
 * drizzle-orm's postgres-js driver (src/pg-core/session.ts's
 * queryWithCache) never lets a raw driver error escape — every query error
 * is wrapped in drizzle's own `DrizzleQueryError`, with the original
 * `postgres.PostgresError` attached as `.cause`. So the unique-violation
 * check below must look at `err.cause`, not `err` itself; `err instanceof
 * postgres.PostgresError` is never true for errors coming out of `db.insert`
 * with this driver. Verified empirically: the race test in
 * tests/googleContacts/reconcile.test.ts failed with an uncaught
 * DrizzleQueryError until this unwrap was added.
 */
function isContactsUniqueViolation(err: unknown): boolean {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const pgErr = err instanceof postgres.PostgresError ? err : cause instanceof postgres.PostgresError ? cause : undefined;
  return (
    pgErr?.code === PG_UNIQUE_VIOLATION &&
    pgErr.constraint_name !== undefined &&
    CONTACTS_UNIQUE_CONSTRAINTS.has(pgErr.constraint_name)
  );
}

/**
 * Find-or-create the local contacts row for a resolved Google match.
 * Additive-only on an existing row: never touches displayName, category,
 * preferredChannel, bookingUrl, or notes — those are curated by the
 * principal or the schedule-appointment skill, Google must never overwrite
 * them. Only backfills currently-null email/googleResourceName/relationshipTier.
 */
export async function provisionLocalContact(match: GoogleContactMatch): Promise<Contact> {
  const existing = await getContactByPhoneNumber(match.phoneNumber);
  const relationshipTier = deriveRelationshipTier(match);

  if (existing) {
    const patch: Partial<Pick<NewContact, 'email' | 'googleResourceName' | 'relationshipTier'>> = {};
    if (!existing.email && match.email) patch.email = match.email;
    if (!existing.googleResourceName) patch.googleResourceName = match.googleResourceName;
    if (!existing.relationshipTier && relationshipTier) patch.relationshipTier = relationshipTier;
    if (Object.keys(patch).length === 0) return existing;
    try {
      return await updateContact(existing.id, patch);
    } catch (err) {
      // Same rationale as the insert-path race below: another row may already
      // claim this googleResourceName (e.g. the Google contact's number
      // changed and the old row still holds it). A missed additive backfill
      // must not fail the whole caller-ID resolution.
      if (isContactsUniqueViolation(err)) return existing;
      throw err;
    }
  }

  try {
    return await addContact({
      displayName: match.displayName,
      phoneNumber: match.phoneNumber,
      email: match.email,
      googleResourceName: match.googleResourceName,
      relationshipTier,
    });
  } catch (err) {
    // Benign race, not a business-rule conflict (unlike
    // ActiveBookingConflictError in src/inbound/service.ts) — a concurrent
    // provisionLocalContact call for the same new person already won the
    // insert, so resolve to that row instead of failing.
    if (isContactsUniqueViolation(err)) {
      const raced = await getContactByPhoneNumber(match.phoneNumber);
      if (raced) return raced;
      // Or the googleResourceName index rejected us: this Google person is
      // already provisioned under a different (stale) phone number. Resolve
      // to that row rather than failing — it's the same human.
      const byResourceName = await getContactByGoogleResourceName(match.googleResourceName);
      if (byResourceName) return byResourceName;
    }
    throw err;
  }
}
