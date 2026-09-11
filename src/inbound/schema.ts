import { sql } from 'drizzle-orm';
import { type AnyPgColumn, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { contacts } from '../contacts/schema.js';
import { callAttemptStatusEnum } from '../tasks/schema.js';

export const inboundBookingStatusEnum = pgEnum('inbound_booking_status', ['active', 'rescheduled', 'cancelled']);

/**
 * One row per inbound phone call to the public booking line. Deliberately
 * separate from tasks/schema.ts's Task/CallAttempt — that state machine is
 * shaped entirely around "ea proactively originates a call and drives it
 * toward an outcome," confirmed not to fit "a call just arrives unprompted"
 * (see docs/superpowers/specs/2026-08-07-inbound-voice-booking-design.md's
 * "Confirmed codebase state"). `status` reuses callAttemptStatusEnum since
 * the connecting/active/tool_pending/ending/ended/error lifecycle is
 * identical regardless of call direction.
 */
export const inboundCalls = pgTable('inbound_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Twilio's own CallSid — the id TwilioProvider's per-call state (and
  // every TelephonyProvider method) is keyed by for inbound calls, since no
  // second id needs minting (unlike outbound's callAttempts.id).
  twilioCallSid: text('twilio_call_sid').notNull().unique(),
  callerPhoneNumber: text('caller_phone_number').notNull(),
  // Nullable — set when src/inbound/callerContext.ts resolves the caller to
  // a known local contact (directly, or via a Google Contacts match).
  // Purely for interaction-count/greeting purposes, not a security key —
  // the booking security boundary stays callerPhoneNumber, unchanged.
  contactId: uuid('contact_id').references(() => contacts.id),
  status: callAttemptStatusEnum('status').notNull().default('connecting'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A booking made through the inbound line. Reschedule is modeled as an
 * immutable append, never an in-place mutation: the old row flips to
 * 'rescheduled' and a new row is inserted 'active' with previousBookingId
 * pointing back. This keeps "find the caller's active booking"
 * (callerPhoneNumber + status = 'active') an unambiguous single-row query
 * and gives a clean audit trail — see the design spec's "New module"
 * section.
 */
export const inboundBookings = pgTable(
  'inbound_bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inboundCallId: uuid('inbound_call_id')
      .notNull()
      .references(() => inboundCalls.id),
    // Denormalized onto the booking (not just reachable via inboundCallId)
    // because it's the actual security lookup key — find_my_booking/
    // reschedule_booking key off of "whoever is calling right now," which
    // must resolve to a booking with one query, not a join per lookup.
    callerPhoneNumber: text('caller_phone_number').notNull(),
    calendarEventId: text('calendar_event_id').notNull(),
    confirmedStart: timestamp('confirmed_start', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    purpose: text('purpose').notNull(),
    // Carried forward on reschedule (supersedeBooking), never re-asked — see
    // rescheduleBookingTool (src/inbound/tools.ts), which reads this off the
    // existing row instead of taking it as a caller-supplied argument, the
    // same way it already does for purpose.
    callerName: text('caller_name').notNull(),
    status: inboundBookingStatusEnum('status').notNull().default('active'),
    previousBookingId: uuid('previous_booking_id').references((): AnyPgColumn => inboundBookings.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    callerStatusIdx: index('inbound_bookings_caller_status_idx').on(table.callerPhoneNumber, table.status),
    // Database-level backstop for "one active booking per caller" (see
    // service.ts's ActiveBookingConflictError doc comment): a partial
    // unique index that only enforces uniqueness of callerPhoneNumber among
    // rows where status = 'active'. Closes a race book_appointment's
    // application-level pre-check (findActiveBookingForCaller) alone can't:
    // a timeout-retried book_appointment call can pass that pre-check twice
    // before either insert commits, which would otherwise create two active
    // rows for the same caller. rescheduled/cancelled rows for the same
    // caller are unaffected — only one 'active' row per caller is ever
    // allowed to exist at a time.
    oneActivePerCallerIdx: uniqueIndex('inbound_bookings_one_active_per_caller')
      .on(table.callerPhoneNumber)
      .where(sql`status = 'active'`),
  }),
);

export type InboundCall = typeof inboundCalls.$inferSelect;
export type NewInboundCall = typeof inboundCalls.$inferInsert;
export type InboundBooking = typeof inboundBookings.$inferSelect;
export type NewInboundBooking = typeof inboundBookings.$inferInsert;
