import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressBookChanges } from '../../src/carddavContacts/client.js';
import type { ParsedCard } from '../../src/carddavContacts/vcard.js';

// The CardDAV client is mocked (tests/carddavContacts/client.test.ts covers
// the HTTP side); this file checks how its results land in the real cache
// table, and how lookup.ts uses a sync as its live fallback.
const fetchAddressBookChanges = vi.fn<(url: string, creds: unknown, token?: string) => Promise<AddressBookChanges>>();
vi.mock('../../src/carddavContacts/client.js', () => ({ fetchAddressBookChanges }));

let db: any;
let googleContacts: any;
let sync: typeof import('../../src/carddavContacts/sync.js');
let lookup: typeof import('../../src/googleContacts/lookup.js');

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  process.env.CONTACTS_PROVIDER = 'carddav';
  process.env.CARDDAV_ADDRESSBOOK_URL = 'https://carddav.example.com/dav/addressbooks/user/me@example.com/Default/';
  process.env.DAV_USERNAME = 'me@example.com';
  process.env.DAV_PASSWORD = 'app-password';
  vi.resetModules();

  db = (await import('../../src/db/index.js')).db;
  googleContacts = (await import('../../src/googleContacts/schema.js')).googleContacts;
  sync = await import('../../src/carddavContacts/sync.js');
  lookup = await import('../../src/googleContacts/lookup.js');
});

beforeEach(async () => {
  vi.clearAllMocks();
  sync.resetCardDavSyncState();
  await db.delete(googleContacts);
});

afterAll(async () => {
  await db.delete(googleContacts);
});

function person(uid: string, displayName: string, phone?: string, extra: Partial<ParsedCard> = {}): { href: string; card: ParsedCard } {
  return {
    href: `/book/${uid}.vcf`,
    card: {
      uid,
      kind: 'individual',
      displayName,
      phones: phone ? [{ value: phone, type: 'mobile' }] : [],
      email: undefined,
      relationLabels: [],
      categories: [],
      memberUids: [],
      ...extra,
    },
  };
}

function group(uid: string, name: string, memberUids: string[]) {
  return { href: `/book/${uid}.vcf`, card: { ...person(uid, name).card, kind: 'group' as const, memberUids } };
}

const full = (token: string, changed: AddressBookChanges['changed']): AddressBookChanges => ({ syncToken: token, full: true, changed, removedHrefs: [] });
const delta = (token: string, changed: AddressBookChanges['changed'], removedHrefs: string[] = []): AddressBookChanges => ({
  syncToken: token,
  full: false,
  changed,
  removedHrefs,
});

async function rows() {
  const all = await db.select().from(googleContacts);
  return Object.fromEntries(all.map((r: any) => [r.googleResourceName, r]));
}

describe('CardDAV contacts sync', () => {
  it('fills the cache from a full read: normalized numbers, group labels from group cards and categories', async () => {
    fetchAddressBookChanges.mockResolvedValueOnce(
      full('t1', [
        group('g-fam', 'Family', ['mom']),
        person('mom', 'Mom', '(555) 999-0000', { email: 'mom@example.com', relationLabels: ['mother'], categories: ['VIP'] }),
        person('shop', 'Hair Salon', 'not a number'),
      ]),
    );

    await sync.syncCardDavContacts();

    const cached = await rows();
    expect(Object.keys(cached).sort()).toEqual(['carddav:mom', 'carddav:shop']);
    expect(cached['carddav:mom']).toMatchObject({
      displayName: 'Mom',
      phoneNumbers: [{ e164: '+15559990000', type: 'mobile' }],
      email: 'mom@example.com',
      relationLabels: ['mother'],
      groupLabels: ['VIP', 'Family'],
    });
    expect(cached['carddav:shop'].phoneNumbers).toEqual([]);
    expect(fetchAddressBookChanges).toHaveBeenCalledWith(process.env.CARDDAV_ADDRESSBOOK_URL, { username: 'me@example.com', password: 'app-password' });
  });

  it('removes cached rows that are no longer in the address book, including leftovers from Google', async () => {
    await db.insert(googleContacts).values({ googleResourceName: 'people/c1', displayName: 'Old Google Row', phoneNumbers: [] });
    fetchAddressBookChanges.mockResolvedValueOnce(full('t1', [person('a', 'Ann', '555-111-2222')]));

    await sync.syncCardDavContacts();

    expect(Object.keys(await rows())).toEqual(['carddav:a']);
  });

  it('applies later changes and removals from the sync token', async () => {
    fetchAddressBookChanges.mockResolvedValueOnce(full('t1', [person('a', 'Ann', '555-111-2222'), person('b', 'Bo', '555-333-4444')]));
    await sync.syncCardDavContacts();

    fetchAddressBookChanges.mockResolvedValueOnce(delta('t2', [person('a', 'Ann Updated', '555-111-2222')], ['/book/b.vcf']));
    await sync.syncCardDavContacts();

    expect(fetchAddressBookChanges).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), 't1');
    const cached = await rows();
    expect(Object.keys(cached)).toEqual(['carddav:a']);
    expect(cached['carddav:a'].displayName).toBe('Ann Updated');
  });

  it('falls back to a full read when a group changes, so every member is relabeled', async () => {
    fetchAddressBookChanges.mockResolvedValueOnce(full('t1', [group('g', 'Friends', []), person('a', 'Ann', '555-111-2222')]));
    await sync.syncCardDavContacts();

    fetchAddressBookChanges.mockResolvedValueOnce(delta('t2', [group('g', 'Friends', ['a'])]));
    fetchAddressBookChanges.mockResolvedValueOnce(full('t3', [group('g', 'Friends', ['a']), person('a', 'Ann', '555-111-2222')]));
    await sync.syncCardDavContacts();

    expect(fetchAddressBookChanges).toHaveBeenCalledTimes(3);
    expect(fetchAddressBookChanges.mock.calls[2]).toHaveLength(2); // no token: a full read
    expect((await rows())['carddav:a'].groupLabels).toEqual(['Friends']);
  });

  it('shares one sync between concurrent callers', async () => {
    let release!: () => void;
    fetchAddressBookChanges.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(full('t1', [])))));

    const first = sync.syncCardDavContacts();
    const second = sync.syncCardDavContacts();
    release();
    await Promise.all([first, second]);

    expect(fetchAddressBookChanges).toHaveBeenCalledTimes(1);
  });

  it('runCardDavContactsSync logs a failure instead of throwing, and leaves the cache alone', async () => {
    await db.insert(googleContacts).values({ googleResourceName: 'carddav:keep', displayName: 'Keep', phoneNumbers: [] });
    fetchAddressBookChanges.mockRejectedValueOnce(new Error('HTTP 401'));

    await expect(sync.runCardDavContactsSync()).resolves.toBeUndefined();
    expect(Object.keys(await rows())).toEqual(['carddav:keep']);
  });
});

describe('lookup with CONTACTS_PROVIDER=carddav', () => {
  it('on a cache miss, syncs the address book and finds a contact added since the last sync', async () => {
    fetchAddressBookChanges.mockResolvedValueOnce(full('t1', [person('new', 'New Caller', '555-777-8888')]));

    const match = await lookup.findByPhone('+15557778888');

    expect(match).toMatchObject({ googleResourceName: 'carddav:new', displayName: 'New Caller', phoneNumber: '+15557778888' });
  });

  it('finds by name after a sync, too', async () => {
    fetchAddressBookChanges.mockResolvedValueOnce(full('t1', [person('c', 'Claudia Groomer', '555-777-8888')]));
    expect((await lookup.findByName('claudia')).map((m) => m.displayName)).toEqual(['Claudia Groomer']);
  });

  it('answers from the cache without syncing when the number is already there', async () => {
    await db.insert(googleContacts).values({ googleResourceName: 'carddav:x', displayName: 'Cached', phoneNumbers: [{ e164: '+15551112222' }] });

    expect((await lookup.findByPhone('+15551112222'))?.displayName).toBe('Cached');
    expect(fetchAddressBookChanges).not.toHaveBeenCalled();
  });

  it('fails closed to no match when the sync is slower than the lookup budget', async () => {
    fetchAddressBookChanges.mockImplementationOnce(() => new Promise(() => {}));
    expect(await lookup.findByPhone('+15550000000', 50)).toBeUndefined();
  });
});
