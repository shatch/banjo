import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const contactCategoryEnum = pgEnum('contact_category', [
  'salon',
  'medical',
  'restaurant',
  'home_services',
  'other',
]);

/** 'phone' | 'online' | null (unset — the skill asks Steve once, then persists the answer here). */
export const preferredChannelEnum = pgEnum('preferred_channel', ['phone', 'online']);

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  phoneNumber: text('phone_number').notNull(), // E.164
  category: contactCategoryEnum('category').notNull().default('other'),
  preferredChannel: preferredChannelEnum('preferred_channel'), // null = ask once, then set
  bookingUrl: text('booking_url'), // used by the schedule-appointment skill's online-booking path
  notes: text('notes'), // free text, injected into the live-call system prompt as context
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
