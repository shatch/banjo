import { z } from 'zod';
import { updateContact } from '../../contacts/service.js';
import { preferredChannelEnum } from '../../contacts/schema.js';
import type { Contact } from '../../contacts/schema.js';

export const updateContactInputSchema = z.object({
  id: z.string().uuid().describe('Id of the contact to update.'),
  preferredChannel: z
    .enum(preferredChannelEnum.enumValues)
    .optional()
    .describe("How the assistant's owner prefers this contact be reached going forward — set this once they state a preference so future tasks don't have to ask again."),
  bookingUrl: z.string().url().optional().describe('Online booking URL for this contact.'),
  notes: z.string().optional().describe('Free-text notes to store on this contact (overwrites existing notes).'),
});

export async function updateContactHandler(input: z.infer<typeof updateContactInputSchema>): Promise<Contact> {
  const { id, ...patch } = input;
  return updateContact(id, patch);
}
