import { eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contacts, type Contact, type NewContact } from './schema.js';

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

export interface FindContactResult {
  bestMatch: Contact | undefined;
  alternates: Contact[];
}

/**
 * Fuzzy name match — simple ILIKE, sufficient at single-user scale. Returns
 * alternates alongside the best match so callers (the MCP tool, ultimately
 * the schedule-appointment skill) can surface ambiguity to Steve rather than
 * silently guessing which "Dr. Smith" was meant.
 */
export async function findContact(query: string): Promise<FindContactResult> {
  const matches = await db
    .select()
    .from(contacts)
    .where(or(ilike(contacts.displayName, `%${query}%`), ilike(contacts.notes, `%${query}%`)));
  return { bestMatch: matches[0], alternates: matches.slice(1) };
}
