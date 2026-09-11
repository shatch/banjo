import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const connectionsList = vi.fn();
const contactGroupsList = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
      },
    },
    people: () => ({
      people: { connections: { list: connectionsList } },
      contactGroups: { list: contactGroupsList },
    }),
  },
}));

let db: any;
let googleContacts: any;
let runGoogleContactsSync: any;

// Set the real database URL (and a fake-but-truthy refresh token, since
// runGoogleContactsSync no-ops when it's unset) and reload modules before
// any tests run — same convention as tests/contacts/service.test.ts. The
// googleapis mock above means no real OAuth/network ever happens.
beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'test-refresh-token';
  vi.resetModules();

  const dbModule = await import('../../src/db/index.js');
  const schemaModule = await import('../../src/googleContacts/schema.js');
  const syncModule = await import('../../src/googleContacts/sync.js');

  db = dbModule.db;
  googleContacts = schemaModule.googleContacts;
  runGoogleContactsSync = syncModule.runGoogleContactsSync;
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(googleContacts);
  contactGroupsList.mockResolvedValue({
    data: { contactGroups: [{ resourceName: 'contactGroups/family1', name: 'Family' }] },
  });
});

describe('runGoogleContactsSync', () => {
  it('upserts a synced contact with normalized phone numbers and resolved group labels', async () => {
    connectionsList.mockResolvedValueOnce({
      data: {
        connections: [
          {
            resourceName: 'people/c1',
            etag: 'etag1',
            names: [{ displayName: 'Mom' }],
            phoneNumbers: [{ value: '(555) 999-0000', type: 'mobile' }],
            emailAddresses: [{ value: 'mom@example.com' }],
            relations: [{ type: 'mother' }],
            memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/family1' } }],
          },
        ],
      },
    });

    await runGoogleContactsSync();

    const rows = await db.select().from(googleContacts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      googleResourceName: 'people/c1',
      displayName: 'Mom',
      email: 'mom@example.com',
      relationLabels: ['mother'],
      groupLabels: ['Family'],
    });
    expect(rows[0]?.phoneNumbers).toEqual([{ e164: '+15559990000', type: 'mobile' }]);
  });

  it('pages through connections.list until nextPageToken is absent', async () => {
    connectionsList
      .mockResolvedValueOnce({
        data: {
          connections: [{ resourceName: 'people/c1', names: [{ displayName: 'Page One' }] }],
          nextPageToken: 'page2',
        },
      })
      .mockResolvedValueOnce({
        data: { connections: [{ resourceName: 'people/c2', names: [{ displayName: 'Page Two' }] }] },
      });

    await runGoogleContactsSync();

    const rows = await db.select().from(googleContacts);
    expect(rows.map((r: any) => r.displayName).sort()).toEqual(['Page One', 'Page Two']);
    expect(connectionsList).toHaveBeenCalledTimes(2);
  });

  it('re-upserting the same resourceName updates rather than duplicates', async () => {
    connectionsList.mockResolvedValue({
      data: { connections: [{ resourceName: 'people/c1', names: [{ displayName: 'Old Name' }] }] },
    });
    await runGoogleContactsSync();
    connectionsList.mockResolvedValue({
      data: { connections: [{ resourceName: 'people/c1', names: [{ displayName: 'New Name' }] }] },
    });
    await runGoogleContactsSync();

    const rows = await db.select().from(googleContacts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe('New Name');
  });

  it('logs and does not throw when the People API call fails', async () => {
    connectionsList.mockRejectedValue(new Error('boom'));
    await expect(runGoogleContactsSync()).resolves.toBeUndefined();
  });

  it('skips a phone number that fails to normalize but keeps the rest of the contact', async () => {
    connectionsList.mockResolvedValueOnce({
      data: {
        connections: [
          {
            resourceName: 'people/c1',
            names: [{ displayName: 'Weird Number' }],
            phoneNumbers: [{ value: 'not-a-number' }],
          },
        ],
      },
    });

    await runGoogleContactsSync();

    const rows = await db.select().from(googleContacts);
    expect(rows[0]?.displayName).toBe('Weird Number');
    expect(rows[0]?.phoneNumbers).toEqual([]);
  });
});
