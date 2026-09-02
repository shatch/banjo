import { z } from 'zod';
import { findContact } from '../../contacts/service.js';
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
 */
export async function findContactHandler(input: z.infer<typeof findContactInputSchema>): Promise<FindContactResult> {
  const result = await findContact(input.query);
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
