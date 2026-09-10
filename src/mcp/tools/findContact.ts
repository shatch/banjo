import { z } from 'zod';
import { findContact } from '../../contacts/service.js';
import { findByName } from '../../googleContacts/lookup.js';
import { provisionLocalContact } from '../../googleContacts/reconcile.js';
import { logger } from '../../lib/logger.js';
import type { Contact } from '../../contacts/schema.js';

export const findContactInputSchema = z.object({
  query: z.string().min(1).describe('Name or partial name/notes text to search saved contacts for, e.g. "dentist" or "Dr. Smith".'),
});

export type FindContactResult =
  | {
      found: true;
      bestMatch: Contact;
      alternates: Contact[];
    }
  | {
      found: false;
      message: string;
    };

/**
 * Surfaces "no match" as a clear, distinct shape rather than an undefined
 * bestMatch — the calling skill needs to gracefully offer to add_contact or
 * ask Steve to disambiguate, not silently guess.
 *
 * Falls back to Google Contacts and auto-provisions on a local miss. This
 * orchestration (rather than living in contacts/service.ts's findContact)
 * is what breaks the circular import between src/contacts/service.ts and
 * src/googleContacts/reconcile.ts — reconcile.ts imports contact CRUD
 * helpers from service.ts for its own dedupe lookups, so service.ts can't
 * import back from reconcile.ts.
 */
/**
 * Google fallback is best-effort: a transient DB hiccup or Google API error
 * here must degrade to "no Google match" rather than crash the whole
 * find_contact call — a local miss plus a flaky fallback is still just a
 * miss, not a tool failure.
 */
async function findGoogleFallback(query: string): Promise<{ bestMatch: Contact | undefined; alternates: Contact[] }> {
  try {
    const googleMatches = await findByName(query);
    const provisioned = await Promise.all(googleMatches.map((m) => provisionLocalContact(m)));
    return { bestMatch: provisioned[0], alternates: provisioned.slice(1) };
  } catch (err) {
    logger.error({ err, query }, 'find_contact Google fallback failed');
    return { bestMatch: undefined, alternates: [] };
  }
}

export async function findContactHandler(input: z.infer<typeof findContactInputSchema>): Promise<FindContactResult> {
  const localResult = await findContact(input.query);
  const result = localResult.bestMatch ? localResult : await findGoogleFallback(input.query);

  if (!result.bestMatch) {
    return {
      found: false,
      message: `No contact found matching "${input.query}". Consider using add_contact to create one.`,
    };
  }
  return {
    found: true,
    bestMatch: result.bestMatch,
    alternates: result.alternates,
  };
}
