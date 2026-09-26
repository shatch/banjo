import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let addContact: any;
let findContact: any;
let getContactByPhoneNumber: any;
let updateContact: any;

// Set the real database URL and reload modules before any tests run
beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';

  const dbModule = await import('../../src/db/index.js');
  const schemaModule = await import('../../src/contacts/schema.js');
  const tasksModule = await import('../../src/tasks/schema.js');
  const serviceModule = await import('../../src/contacts/service.js');

  db = dbModule.db;
  contacts = schemaModule.contacts;
  tasks = tasksModule.tasks;
  callAttempts = tasksModule.callAttempts;
  addContact = serviceModule.addContact;
  findContact = serviceModule.findContact;
  getContactByPhoneNumber = serviceModule.getContactByPhoneNumber;
  updateContact = serviceModule.updateContact;
});

beforeEach(async () => {
  // Delete in reverse dependency order to handle foreign keys
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
});

describe('getContactByPhoneNumber', () => {
  it('returns the contact with an exact phone number match', async () => {
    const created = await addContact({ displayName: 'Clauda', phoneNumber: '+15551234567' });
    const found = await getContactByPhoneNumber('+15551234567');
    expect(found?.id).toBe(created.id);
  });

  it('returns undefined when no contact has that phone number', async () => {
    expect(await getContactByPhoneNumber('+19998887777')).toBeUndefined();
  });
});

describe('addContact', () => {
  it('accepts email, googleResourceName, and relationshipTier', async () => {
    const created = await addContact({
      displayName: 'Mom',
      phoneNumber: '+15559990000',
      email: 'mom@example.com',
      googleResourceName: 'people/c123',
      relationshipTier: 'family',
    });
    expect(created.email).toBe('mom@example.com');
    expect(created.googleResourceName).toBe('people/c123');
    expect(created.relationshipTier).toBe('family');
  });
});

describe('updateContact', () => {
  it('can backfill email, googleResourceName, and relationshipTier', async () => {
    const created = await addContact({ displayName: 'Clauda', phoneNumber: '+15551234567' });
    const updated = await updateContact(created.id, {
      email: 'clauda@example.com',
      googleResourceName: 'people/c456',
      relationshipTier: 'friend',
    });
    expect(updated.email).toBe('clauda@example.com');
    expect(updated.googleResourceName).toBe('people/c456');
    expect(updated.relationshipTier).toBe('friend');
  });
});

describe('findContact', () => {
  it('returns a local match', async () => {
    await addContact({ displayName: 'Local Salon', phoneNumber: '+15551110000' });
    const result = await findContact('Local Salon');
    expect(result.bestMatch?.displayName).toBe('Local Salon');
  });

  it('returns no match on a local miss (no Google fallback — that lives in the MCP tool layer)', async () => {
    const result = await findContact('Nobody');
    expect(result.bestMatch).toBeUndefined();
    expect(result.alternates).toEqual([]);
  });
});

describe('phone numbers are stored in E.164, so one number is one contact (per-number call cap)', () => {
  it('normalizes a number on the way in', async () => {
    const created = await addContact({ displayName: 'Formatted', phoneNumber: '(555) 123-4599' });
    expect(created.phoneNumber).toBe('+15551234599');
  });

  it('treats the same number in another format as a duplicate, not a new contact', async () => {
    await addContact({ displayName: 'First', phoneNumber: '+15551234598' });
    await expect(addContact({ displayName: 'Again', phoneNumber: '555-123-4598' })).rejects.toThrow();
    expect(await getContactByPhoneNumber('(555) 123-4598')).toMatchObject({ displayName: 'First' });
  });

  it('refuses something that is not a phone number', async () => {
    await expect(addContact({ displayName: 'Nope', phoneNumber: 'not a number' })).rejects.toThrow(/phone number/i);
  });
});
