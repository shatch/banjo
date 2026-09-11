import { count, eq } from 'drizzle-orm';
import { config } from '../config/index.js';
import { getContactByPhoneNumber } from '../contacts/service.js';
import type { Contact } from '../contacts/schema.js';
import { db } from '../db/index.js';
import { findByPhone } from '../googleContacts/lookup.js';
import { provisionLocalContacts } from '../googleContacts/reconcile.js';
import { logger } from '../lib/logger.js';
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
  const [[taskCount], [callCount]] = await Promise.all([
    db.select({ value: count() }).from(tasks).where(eq(tasks.contactId, contactId)),
    db.select({ value: count() }).from(inboundCalls).where(eq(inboundCalls.contactId, contactId)),
  ]);
  return (taskCount?.value ?? 0) + (callCount?.value ?? 0);
}

/**
 * Resolves an inbound caller's identity for greeting personalization only —
 * this is never the booking security boundary (that stays callerPhoneNumber,
 * checked directly in src/inbound/service.ts's findActiveBookingForCaller).
 * Refuses to look anything up for a non-E.164 caller ID (Twilio's literal
 * "anonymous" for a withheld caller ID) — same guard the booking security
 * path already relies on.
 *
 * Fails closed to "no match" on ANY error: this runs on the call-answering
 * hot path, where throwing would propagate out of src/server.ts's inbound
 * webhook handler and (absent the rollback there) leave the call registered
 * forever, latching isAnyCallActive() to true and silently declining every
 * future inbound call. A missed greeting personalization is a cosmetic
 * degradation; a permanently-dead inbound line is not.
 */
export async function resolveCallerContext(callerPhoneNumber: string): Promise<ResolvedCaller> {
  if (!E164_PATTERN.test(callerPhoneNumber)) {
    return { contactId: undefined, greetingContext: undefined };
  }

  try {
    let contact = await getContactByPhoneNumber(callerPhoneNumber);
    if (!contact) {
      const match = await findByPhone(callerPhoneNumber);
      // Shares provisioning/de-dup with src/mcp/tools/findContact.ts's
      // Google fallback via provisionLocalContacts, even though this path
      // only ever has one match to provision.
      if (match) [contact] = await provisionLocalContacts([match]);
    }
    if (!contact) {
      return { contactId: undefined, greetingContext: undefined };
    }

    const isFrequent = (await countInteractions(contact.id)) >= config.FREQUENT_CONTACT_THRESHOLD;
    // src/googleContacts/sync.ts defaults a nameless Google contact's
    // displayName to 'Unknown' — never speak that placeholder aloud
    // ("Hi Unknown!"), so treat it as having no usable name at all.
    const hasUsableName = contact.displayName !== 'Unknown';
    const personalize = hasUsableName && (contact.relationshipTier !== null || isFrequent);

    return {
      contactId: contact.id,
      greetingContext: personalize
        ? { displayName: contact.displayName, relationshipTier: contact.relationshipTier, isFrequent }
        : undefined,
    };
  } catch (err) {
    logger.error({ err, callerPhoneNumber }, 'caller context resolution failed');
    return { contactId: undefined, greetingContext: undefined };
  }
}
