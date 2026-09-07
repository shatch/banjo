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
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo';
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
