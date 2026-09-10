import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Registers the mock definition for this module path. This is hoisted above
// the imports below, but — critically — it does NOT itself import the
// module: the mock factory only runs when something actually imports
// '../../../src/googleContacts/lookup.js', which happens inside beforeAll
// below (after vi.resetModules()). Capturing `findByName` via a top-level
// `await import(...)` here (before resetModules runs) would bind it to a
// *different* module instance than the one src/mcp/tools/findContact.js's
// fresh, post-reset import resolves to — the mocked `findByName` in this
// test's assertions would then be silently disconnected from the one the
// code under test actually calls. See beforeAll below for where it's really
// bound.
vi.mock('../../../src/googleContacts/lookup.js', () => ({ findByName: vi.fn() }));

let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let addContact: any;
let findContactHandler: any;
let findByName: any;

// Set the real database URL and reload modules before any tests run
beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo';
  vi.resetModules();

  // Import modules after env is set and modules are reset. The lookup.js
  // import below is intentionally in this same batch (no vi.resetModules()
  // call in between) so it resolves to the exact same mocked module
  // instance that findContact.js's internal `import { findByName } from
  // '../../googleContacts/lookup.js'` resolves to — same cache generation,
  // same vi.fn() reference.
  const dbModule = await import('../../../src/db/index.js');
  const schemaModule = await import('../../../src/contacts/schema.js');
  const tasksModule = await import('../../../src/tasks/schema.js');
  const serviceModule = await import('../../../src/contacts/service.js');
  const toolModule = await import('../../../src/mcp/tools/findContact.js');
  const lookupModule = await import('../../../src/googleContacts/lookup.js');

  db = dbModule.db;
  contacts = schemaModule.contacts;
  tasks = tasksModule.tasks;
  callAttempts = tasksModule.callAttempts;
  addContact = serviceModule.addContact;
  findContactHandler = toolModule.findContactHandler;
  findByName = lookupModule.findByName;
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Delete in reverse dependency order to handle foreign keys
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
});

describe('findContactHandler', () => {
  it('returns a local match without calling the Google fallback', async () => {
    await addContact({ displayName: 'Local Salon', phoneNumber: '+15551110000' });
    const result = await findContactHandler({ query: 'Local Salon' });
    expect(result.found).toBe(true);
    expect(result.found && result.bestMatch.displayName).toBe('Local Salon');
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

    const result = await findContactHandler({ query: 'Dr. Smith' });

    expect(result.found).toBe(true);
    expect(result.found && result.bestMatch.displayName).toBe('Dr. Smith');
    expect(result.found && result.bestMatch.phoneNumber).toBe('+15552223333');
    expect(result.found && result.alternates).toEqual([]);
  });

  it('surfaces multiple Google matches as alternates', async () => {
    vi.mocked(findByName).mockResolvedValue([
      { googleResourceName: 'people/c1', displayName: 'John Smith', phoneNumber: '+15550001111', email: undefined, relationLabels: [], groupLabels: [] },
      { googleResourceName: 'people/c2', displayName: 'John Smith Jr', phoneNumber: '+15550002222', email: undefined, relationLabels: [], groupLabels: [] },
    ]);

    const result = await findContactHandler({ query: 'John Smith' });

    expect(result.found).toBe(true);
    expect(result.found && result.bestMatch.displayName).toBe('John Smith');
    expect(result.found && result.alternates).toHaveLength(1);
    expect(result.found && result.alternates[0]?.displayName).toBe('John Smith Jr');
  });

  it('returns found: false when both the local search and the Google fallback miss', async () => {
    vi.mocked(findByName).mockResolvedValue([]);
    const result = await findContactHandler({ query: 'Nobody' });
    expect(result.found).toBe(false);
  });
});
