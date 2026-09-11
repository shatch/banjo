import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** One phone number as reported by Google Contacts, normalized to E.164. */
export interface GooglePhoneNumber {
  e164: string;
  type?: string; // e.g. 'mobile', 'home', 'work' — as Google reports it, informational only
}

/**
 * Local cache of the principal's own Google Contacts, refreshed by
 * src/googleContacts/sync.ts on a timer (GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS).
 * Hot-path lookups (src/googleContacts/lookup.ts) read this table, never the
 * live People API, so an inbound call or outbound find_contact never waits
 * on a network round trip in the common case.
 */
export const googleContacts = pgTable(
  'google_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    googleResourceName: text('google_resource_name').notNull().unique(), // e.g. "people/c1234567890"
    displayName: text('display_name').notNull(),
    phoneNumbers: jsonb('phone_numbers').$type<GooglePhoneNumber[]>().notNull().default([]),
    email: text('email'),
    // Raw signal from People API's `relations` field (e.g. "spouse", "child") —
    // src/googleContacts/reconcile.ts derives contacts.relationshipTier from this.
    relationLabels: jsonb('relation_labels').$type<string[]>().notNull().default([]),
    // Names of Google contact groups this person belongs to (e.g. "Family",
    // "Friends"), resolved from group resource names at sync time.
    groupLabels: jsonb('group_labels').$type<string[]>().notNull().default([]),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Backs src/googleContacts/lookup.ts's findCachedByPhone `@>` containment
    // query — that's the inbound call-answering hot path (1800ms budget),
    // so a seq scan over the whole cache isn't acceptable as the cache grows.
    phoneNumbersGin: index('google_contacts_phone_numbers_gin').using('gin', table.phoneNumbers),
  }),
);

export type GoogleContact = typeof googleContacts.$inferSelect;
export type NewGoogleContact = typeof googleContacts.$inferInsert;
