import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const contactCategoryEnum = pgEnum('contact_category', [
  'salon',
  'medical',
  'restaurant',
  'home_services',
  'other',
]);

/** 'phone' | 'online' | null (unset — the skill asks Steve once, then persists the answer here). */
export const preferredChannelEnum = pgEnum('preferred_channel', ['phone', 'online']);

/** null = ordinary/business contact. Derived heuristically from Google Contacts relation/group labels — see src/googleContacts/reconcile.ts. */
export const relationshipTierEnum = pgEnum('relationship_tier', ['family', 'friend']);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    phoneNumber: text('phone_number').notNull(), // E.164
    category: contactCategoryEnum('category').notNull().default('other'),
    preferredChannel: preferredChannelEnum('preferred_channel'), // null = ask once, then set
    bookingUrl: text('booking_url'), // used by the schedule-appointment skill's online-booking path
    notes: text('notes'), // free text, injected into the live-call system prompt as context
    // The three columns below are enrichment from Google Contacts (see
    // src/googleContacts/reconcile.ts) — never set directly by the skill or
    // add_contact/update_contact's normal callers, and never overwritten
    // once set by anything other than the reconciliation backfill.
    email: text('email'), // nullable; not a communication channel yet, just data
    googleResourceName: text('google_resource_name'), // e.g. "people/c1234567890"
    relationshipTier: relationshipTierEnum('relationship_tier'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The dedupe key src/googleContacts/reconcile.ts relies on to avoid
    // double-provisioning the same person from two near-simultaneous
    // lookups (inbound + outbound). Pre-existing gap, closed here since
    // this feature is the first thing that actually depends on it.
    phoneNumberUnique: uniqueIndex('contacts_phone_number_unique').on(table.phoneNumber),
    // Postgres unique indexes allow multiple NULLs, so contacts with no
    // Google match are unaffected.
    googleResourceNameUnique: uniqueIndex('contacts_google_resource_name_unique').on(table.googleResourceName),
  }),
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
