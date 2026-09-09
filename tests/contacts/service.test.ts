import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Registers the mock definition for this module path. This is hoisted above
// the imports below, but — critically — it does NOT itself import the
// module: the mock factory only runs when something actually imports
// '../../src/googleContacts/lookup.js', which happens inside beforeAll below
// (after vi.resetModules()). Capturing `findByName` via a top-level
// `await import(...)` here (before resetModules runs) would bind it to a
// *different* module instance than the one src/contacts/service.js's fresh,
// post-reset import resolves to — the mocked `findByName` in this test's
// assertions would then be silently disconnected from the one the code under
// test actually calls. See beforeAll below for where it's really bound.
vi.mock('../../src/googleContacts/lookup.js', () => ({ findByName: vi.fn() }));

let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let addContact: any;
let findContact: any;
let getContactByPhoneNumber: any;
let updateContact: any;
let findByName: any;

// Set the real database URL and reload modules before any tests run
beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo';
  vi.resetModules();

  // Import modules after env is set and modules are reset. The lookup.js
  // import below is intentionally in this same batch (no vi.resetModules()
  // call in between) so it resolves to the exact same mocked module
  // instance that service.js's internal `import { findByName } from
  // '../googleContacts/lookup.js'` resolves to — same cache generation,
  // same vi.fn() reference.
  const dbModule = await import('../../src/db/index.js');
  const schemaModule = await import('../../src/contacts/schema.js');
  const tasksModule = await import('../../src/tasks/schema.js');
  const serviceModule = await import('../../src/contacts/service.js');
  const lookupModule = await import('../../src/googleContacts/lookup.js');

  db = dbModule.db;
  contacts = schemaModule.contacts;
  tasks = tasksModule.tasks;
  callAttempts = tasksModule.callAttempts;
  addContact = serviceModule.addContact;
  findContact = serviceModule.findContact;
  getContactByPhoneNumber = serviceModule.getContactByPhoneNumber;
  updateContact = serviceModule.updateContact;
  findByName = lookupModule.findByName;
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a local match without calling the Google fallback', async () => {
    await addContact({ displayName: 'Local Salon', phoneNumber: '+15551110000' });
    const result = await findContact('Local Salon');
    expect(result.bestMatch?.displayName).toBe('Local Salon');
    expect(findByName).not.toHaveBeenCalled();
  });

  it('falls back to Google Contacts and auto-provisions on a local miss', async () => {
    vi.mocked(findByName).mockResolvedValue([
      {
        googleResourceName: 'people/c1',
        displayName: 'Dr. Smith',
        phoneNumber: '+15552223333',
        email: undefined,
        relationLabels: [],
        groupLabels: [],
      },
    ]);

    const result = await findContact('Dr. Smith');

    expect(result.bestMatch?.displayName).toBe('Dr. Smith');
    expect(result.bestMatch?.phoneNumber).toBe('+15552223333');
    expect(result.alternates).toEqual([]);
  });

  it('surfaces multiple Google matches as alternates', async () => {
    vi.mocked(findByName).mockResolvedValue([
      { googleResourceName: 'people/c1', displayName: 'John Smith', phoneNumber: '+15550001111', email: undefined, relationLabels: [], groupLabels: [] },
      { googleResourceName: 'people/c2', displayName: 'John Smith Jr', phoneNumber: '+15550002222', email: undefined, relationLabels: [], groupLabels: [] },
    ]);

    const result = await findContact('John Smith');

    expect(result.bestMatch?.displayName).toBe('John Smith');
    expect(result.alternates).toHaveLength(1);
    expect(result.alternates[0]?.displayName).toBe('John Smith Jr');
  });

  it('returns no match when both the local search and the Google fallback miss', async () => {
    vi.mocked(findByName).mockResolvedValue([]);
    const result = await findContact('Nobody');
    expect(result.bestMatch).toBeUndefined();
  });
});
