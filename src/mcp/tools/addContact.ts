import { z } from 'zod';
import { addContact } from '../../contacts/service.js';
import { contactCategoryEnum } from '../../contacts/schema.js';
import type { Contact } from '../../contacts/schema.js';

export const addContactInputSchema = z.object({
  displayName: z.string().min(1).describe('Human-readable name for the contact, e.g. "Luxe Salon" or "Dr. Patel".'),
  phoneNumber: z.string().min(1).describe('Phone number in E.164 format, e.g. "+14155551234".'),
  category: z
    .enum(contactCategoryEnum.enumValues)
    .optional()
    .describe('Type of business/person. Defaults to "other" if omitted.'),
  notes: z
    .string()
    .optional()
    .describe('Free-text notes about this contact — injected into the live-call system prompt as context (hours, quirks, prior history, etc).'),
  bookingUrl: z
    .string()
    .url()
    .optional()
    .describe('Online booking URL, if this contact supports booking online as an alternative to a phone call.'),
});

export async function addContactHandler(input: z.infer<typeof addContactInputSchema>): Promise<Contact> {
  return addContact(input);
}
