import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let addContact: any;
let getContactByPhoneNumber: any;
let updateContact: any;

// Set the real database URL and reload modules before any tests run
beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo';
  vi.resetModules();

  // Import modules after env is set and modules are reset
  const dbModule = await import('../../src/db/index.js');
  const schemaModule = await import('../../src/contacts/schema.js');
  const tasksModule = await import('../../src/tasks/schema.js');
  const serviceModule = await import('../../src/contacts/service.js');

  db = dbModule.db;
  contacts = schemaModule.contacts;
  tasks = tasksModule.tasks;
  callAttempts = tasksModule.callAttempts;
  addContact = serviceModule.addContact;
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
