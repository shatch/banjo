import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const searchContacts = vi.fn();
const contactGroupsList = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
      },
    },
    people: () => ({
      people: { searchContacts },
      contactGroups: { list: contactGroupsList },
    }),
  },
}));

let db: any;
let googleContacts: any;
let findByPhone: any;
let findByName: any;

// Set the real database URL and reload modules before any tests run — same
// convention as tests/contacts/service.test.ts and
// tests/googleContacts/sync.test.ts. The googleapis mock above means no real
// OAuth/network ever happens.
beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  vi.resetModules();

  const dbModule = await import('../../src/db/index.js');
  const schemaModule = await import('../../src/googleContacts/schema.js');
  const lookupModule = await import('../../src/googleContacts/lookup.js');

  db = dbModule.db;
  googleContacts = schemaModule.googleContacts;
  findByPhone = lookupModule.findByPhone;
  findByName = lookupModule.findByName;
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(googleContacts);
  contactGroupsList.mockResolvedValue({ data: { contactGroups: [] } });
});

describe('findByPhone', () => {
  it('returns a cached match without calling the live API', async () => {
    await db.insert(googleContacts).values({
      googleResourceName: 'people/c1',
      displayName: 'Clauda',
      phoneNumbers: [{ e164: '+15551234567' }],
    });

    const result = await findByPhone('+15551234567');

    expect(result?.displayName).toBe('Clauda');
    expect(searchContacts).not.toHaveBeenCalled();
  });

  it('falls back to a live search on a cache miss, and caches the hit', async () => {
    searchContacts.mockResolvedValue({
      data: {
        results: [
          {
            person: {
              resourceName: 'people/c2',
              names: [{ displayName: 'Live Match' }],
              phoneNumbers: [{ value: '+15559998888' }],
            },
          },
        ],
      },
    });

    const result = await findByPhone('+15559998888');

    expect(result?.displayName).toBe('Live Match');
    const cached = await db.select().from(googleContacts);
    expect(cached).toHaveLength(1);
  });

  it('returns undefined, without throwing, when the live fallback also misses', async () => {
    searchContacts.mockResolvedValue({ data: { results: [] } });
    await expect(findByPhone('+15550000000')).resolves.toBeUndefined();
  });

  it('returns undefined, without throwing, when the live fallback errors', async () => {
    searchContacts.mockRejectedValue(new Error('boom'));
    await expect(findByPhone('+15550000000')).resolves.toBeUndefined();
  });

  it('returns undefined when the live fallback exceeds the timeout', async () => {
    searchContacts.mockImplementation(() => new Promise(() => {})); // never resolves
    await expect(findByPhone('+15550000000', 10)).resolves.toBeUndefined();
  });

  it('reports the queried number, not the first stored one, when the live hit matched a secondary number', async () => {
    // Google matched this person on their home line, but their mobile is
    // stored first. Reporting phoneNumbers[0] would provision/personalize
    // under a number the caller isn't actually calling from.
    searchContacts.mockResolvedValue({
      data: {
        results: [
          {
            person: {
              resourceName: 'people/c5',
              names: [{ displayName: 'Two Lines' }],
              phoneNumbers: [
                { value: '+15551110000', type: 'mobile' },
                { value: '+15552220000', type: 'home' },
              ],
            },
          },
        ],
      },
    });

    const result = await findByPhone('+15552220000');

    expect(result?.displayName).toBe('Two Lines');
    expect(result?.phoneNumber).toBe('+15552220000');
  });

  it('returns undefined when the fuzzy live search only returns people who do not hold the queried number', async () => {
    // people.searchContacts matches fuzzily — returning its first result
    // regardless would hand back an unrelated person, who would then be
    // auto-provisioned and used to personalize the greeting for the wrong caller.
    searchContacts.mockResolvedValue({
      data: {
        results: [
          {
            person: {
              resourceName: 'people/c6',
              names: [{ displayName: 'Unrelated Person' }],
              phoneNumbers: [{ value: '+15558887777' }],
            },
          },
        ],
      },
    });

    await expect(findByPhone('+15550001111')).resolves.toBeUndefined();
  });
});

describe('findByName', () => {
  it('returns cached matches by display name substring', async () => {
    await db.insert(googleContacts).values({
      googleResourceName: 'people/c3',
      displayName: 'Dr. Smith',
      phoneNumbers: [{ e164: '+15552223333' }],
    });

    const results = await findByName('smith');

    expect(results).toHaveLength(1);
    expect(results[0]?.displayName).toBe('Dr. Smith');
    expect(searchContacts).not.toHaveBeenCalled();
  });

  it('falls back to a live search when the cache has no name match', async () => {
    searchContacts.mockResolvedValue({
      data: {
        results: [
          {
            person: {
              resourceName: 'people/c4',
              names: [{ displayName: 'Dr. Jones' }],
              phoneNumbers: [{ value: '+15554445555' }],
            },
          },
        ],
      },
    });

    const results = await findByName('jones');

    expect(results).toHaveLength(1);
    expect(results[0]?.displayName).toBe('Dr. Jones');
  });
});
