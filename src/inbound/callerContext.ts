import { count, eq } from 'drizzle-orm';
import { config } from '../config/index.js';
import { getContactByPhoneNumber } from '../contacts/service.js';
import type { Contact } from '../contacts/schema.js';
import { db } from '../db/index.js';
import { findByPhone } from '../googleContacts/lookup.js';
import { provisionLocalContact } from '../googleContacts/reconcile.js';
import { tasks } from '../tasks/schema.js';
import { inboundCalls } from './schema.js';
import { E164_PATTERN } from './service.js';

export interface CallerGreetingContext {
  displayName: string;
  relationshipTier: Contact['relationshipTier'];
  isFrequent: boolean;
}

export interface ResolvedCaller {
  contactId: string | undefined;
  greetingContext: CallerGreetingContext | undefined;
}

async function countInteractions(contactId: string): Promise<number> {
  const [taskCount] = await db.select({ value: count() }).from(tasks).where(eq(tasks.contactId, contactId));
  const [callCount] = await db.select({ value: count() }).from(inboundCalls).where(eq(inboundCalls.contactId, contactId));
  return (taskCount?.value ?? 0) + (callCount?.value ?? 0);
}

/**
 * Resolves an inbound caller's identity for greeting personalization only —
 * this is never the booking security boundary (that stays callerPhoneNumber,
 * checked directly in src/inbound/service.ts's findActiveBookingForCaller).
 * Refuses to look anything up for a non-E.164 caller ID (Twilio's literal
 * "anonymous" for a withheld caller ID) — same guard the booking security
 * path already relies on.
 */
export async function resolveCallerContext(callerPhoneNumber: string): Promise<ResolvedCaller> {
  if (!E164_PATTERN.test(callerPhoneNumber)) {
    return { contactId: undefined, greetingContext: undefined };
  }

  let contact = await getContactByPhoneNumber(callerPhoneNumber);
  if (!contact) {
    const match = await findByPhone(callerPhoneNumber);
    if (match) contact = await provisionLocalContact(match);
  }
  if (!contact) {
    return { contactId: undefined, greetingContext: undefined };
  }

  const isFrequent = (await countInteractions(contact.id)) >= config.FREQUENT_CONTACT_THRESHOLD;
  const personalize = contact.relationshipTier !== null || isFrequent;

  return {
    contactId: contact.id,
    greetingContext: personalize
      ? { displayName: contact.displayName, relationshipTier: contact.relationshipTier, isFrequent }
      : undefined,
  };
}
