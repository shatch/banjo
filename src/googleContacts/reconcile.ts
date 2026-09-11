import {
  addContact,
  getContactByGoogleResourceName,
  getContactByPhoneNumber,
  isContactsUniqueViolation,
  updateContact,
} from '../contacts/service.js';
import type { Contact, NewContact } from '../contacts/schema.js';
import type { GoogleContactMatch } from './lookup.js';

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
    // `match.email !== undefined` (presence), not truthiness — a genuine
    // empty-string email from Google is still a value to backfill, not the
    // same as Google reporting no email at all.
    if (!existing.email && match.email !== undefined) patch.email = match.email;
    if (!existing.googleResourceName) patch.googleResourceName = match.googleResourceName;
    if (!existing.relationshipTier && relationshipTier) patch.relationshipTier = relationshipTier;
    if (Object.keys(patch).length === 0) return existing;
    try {
      return await updateContact(existing.id, patch);
    } catch (err) {
      // Same rationale as the insert-path race below: another row may already
      // claim this googleResourceName (e.g. the Google contact's number
      // changed and the old row still holds it). A missed additive backfill
      // must not fail the whole caller-ID resolution — but unlike a missed
      // backfill, silently returning `existing` here would permanently
      // orphan the row that actually holds this googleResourceName (call it
      // B): every future lookup for this Google person keeps landing on
      // `existing` instead of ever being reconciled to B. Resolve to B first,
      // same as the insert-path race just below.
      if (isContactsUniqueViolation(err)) {
        const byResourceName = await getContactByGoogleResourceName(match.googleResourceName);
        return byResourceName ?? existing;
      }
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

/**
 * Provisions a batch of Google matches and de-duplicates the result by
 * contact id. Shared by both Google-fallback call sites —
 * src/mcp/tools/findContact.ts (potentially several name matches) and
 * src/inbound/callerContext.ts (a single phone match) — so the "provision,
 * then de-dupe" step has one implementation instead of drifting apart.
 *
 * De-duping matters because two distinct Google matches can resolve to the
 * *same* local row: provisionLocalContact's own race recovery above
 * resolves a phone-number or googleResourceName conflict to an
 * already-existing row, so e.g. two Google contact cards sharing one phone
 * number would otherwise show up as a contact and its own alternate.
 */
export async function provisionLocalContacts(matches: GoogleContactMatch[]): Promise<Contact[]> {
  const provisioned = await Promise.all(matches.map((match) => provisionLocalContact(match)));
  const seen = new Set<string>();
  const deduped: Contact[] = [];
  for (const contact of provisioned) {
    if (seen.has(contact.id)) continue;
    seen.add(contact.id);
    deduped.push(contact);
  }
  return deduped;
}
