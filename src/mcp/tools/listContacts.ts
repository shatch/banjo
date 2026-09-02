import { z } from 'zod';
import { listContacts } from '../../contacts/service.js';
import { contactCategoryEnum } from '../../contacts/schema.js';
import type { Contact } from '../../contacts/schema.js';

export const listContactsInputSchema = z.object({
  category: z
    .enum(contactCategoryEnum.enumValues)
    .optional()
    .describe('Restrict results to this category. Omit to list every saved contact.'),
});

export async function listContactsHandler(input: z.infer<typeof listContactsInputSchema>): Promise<Contact[]> {
  return listContacts(input.category);
}
