import { eq, ilike, or } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '../db/index.js';
import { contacts, type Contact, type NewContact } from './schema.js';

const PG_UNIQUE_VIOLATION = '23505';
const CONTACTS_UNIQUE_CONSTRAINTS = new Set(['contacts_phone_number_unique', 'contacts_google_resource_name_unique']);

/**
 * drizzle-orm's postgres-js driver (src/pg-core/session.ts's
 * queryWithCache) never lets a raw driver error escape — every query error
 * is wrapped in drizzle's own `DrizzleQueryError`, with the original
 * `postgres.PostgresError` attached as `.cause`. So the unique-violation
 * check below must look at `err.cause`, not `err` itself; `err instanceof
 * postgres.PostgresError` is never true for errors coming out of `db.insert`
 * with this driver. Verified empirically: a race test in
 * tests/googleContacts/reconcile.test.ts failed with an uncaught
 * DrizzleQueryError until this unwrap was added. Shared by every caller that
 * needs to react to either of `contacts`' two unique indexes rather than
 * crash (src/googleContacts/reconcile.ts, src/mcp/tools/addContact.ts).
 */
export function isContactsUniqueViolation(err: unknown): boolean {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const pgErr = err instanceof postgres.PostgresError ? err : cause instanceof postgres.PostgresError ? cause : undefined;
  return (
    pgErr?.code === PG_UNIQUE_VIOLATION &&
    pgErr.constraint_name !== undefined &&
    CONTACTS_UNIQUE_CONSTRAINTS.has(pgErr.constraint_name)
  );
}

export async function addContact(input: {
  displayName: string;
  phoneNumber: string;
  category?: NewContact['category'];
  notes?: string;
  bookingUrl?: string;
  email?: string;
  googleResourceName?: string;
  relationshipTier?: NewContact['relationshipTier'];
}): Promise<Contact> {
  const [row] = await db
    .insert(contacts)
    .values({
      displayName: input.displayName,
      phoneNumber: input.phoneNumber,
      category: input.category ?? 'other',
      notes: input.notes,
      bookingUrl: input.bookingUrl,
      email: input.email,
      googleResourceName: input.googleResourceName,
      relationshipTier: input.relationshipTier,
    })
    .returning();
  if (!row) throw new Error('Failed to insert contact');
  return row;
}

export async function updateContact(
  id: string,
  patch: Partial<
    Pick<
      NewContact,
      | 'preferredChannel'
      | 'bookingUrl'
      | 'notes'
      | 'displayName'
      | 'phoneNumber'
      | 'category'
      | 'email'
      | 'googleResourceName'
      | 'relationshipTier'
    >
  >,
): Promise<Contact> {
  const [row] = await db
    .update(contacts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(contacts.id, id))
    .returning();
  if (!row) throw new Error(`Contact not found: ${id}`);
  return row;
}

export async function listContacts(category?: Contact['category']): Promise<Contact[]> {
  if (category) {
    return db.select().from(contacts).where(eq(contacts.category, category));
  }
  return db.select().from(contacts);
}

export async function getContact(id: string): Promise<Contact | undefined> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id));
  return row;
}

/** The dedupe/lookup key src/googleContacts/reconcile.ts and inbound caller-ID resolution rely on. */
export async function getContactByPhoneNumber(phoneNumber: string): Promise<Contact | undefined> {
  const [row] = await db.select().from(contacts).where(eq(contacts.phoneNumber, phoneNumber));
  return row;
}

/**
 * The second dedupe key src/googleContacts/reconcile.ts relies on: the
 * contacts_google_resource_name_unique index means a Google person can only
 * ever claim one local row, so a provisioning attempt rejected on that index
 * resolves to whichever row already holds it (e.g. after the Google contact's
 * phone number changed).
 */
export async function getContactByGoogleResourceName(googleResourceName: string): Promise<Contact | undefined> {
  const [row] = await db.select().from(contacts).where(eq(contacts.googleResourceName, googleResourceName));
  return row;
}

export interface FindContactResult {
  bestMatch: Contact | undefined;
  alternates: Contact[];
}

/**
 * Fuzzy name match against locally-saved contacts only — simple ILIKE,
 * sufficient at single-user scale. Returns alternates alongside the best
 * match so callers (the MCP tool, ultimately the schedule-appointment skill)
 * can surface ambiguity to Steve rather than silently guessing which
 * "Dr. Smith" was meant.
 *
 * Does not fall back to Google Contacts — that orchestration lives in
 * src/mcp/tools/findContact.ts, one layer up, so this module never needs to
 * import from src/googleContacts/ (which itself imports back from here for
 * dedupe lookups, e.g. getContactByPhoneNumber).
 */
export async function findContact(query: string): Promise<FindContactResult> {
  const matches = await db
    .select()
    .from(contacts)
    .where(or(ilike(contacts.displayName, `%${query}%`), ilike(contacts.notes, `%${query}%`)));
  if (matches.length > 0) {
    return { bestMatch: matches[0], alternates: matches.slice(1) };
  }
  return { bestMatch: undefined, alternates: [] };
}
