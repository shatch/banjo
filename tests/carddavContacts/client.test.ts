import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAddressBookChanges } from '../../src/carddavContacts/client.js';

// Mocked at fetch, the client's only way out.

const BOOK = 'https://carddav.example.com/dav/addressbooks/user/me@example.com/Default/';
const BOOK_PATH = '/dav/addressbooks/user/me@example.com/Default';
const CREDS = { username: 'me@example.com', password: 'pw' };

interface Recorded {
  method: string;
  headers: Record<string, string>;
  body: string;
}
let requests: Recorded[];
let replies: Array<() => Response>;

const vcard = (uid: string, fn: string) => `BEGIN:VCARD&#13;\nVERSION:3.0&#13;\nUID:${uid}&#13;\nFN:${fn}&#13;\nEND:VCARD`;

function ok(href: string, data?: string) {
  const prop = data === undefined ? '<d:getetag>"e"</d:getetag>' : `<d:getetag>"e"</d:getetag><card:address-data>${data}</card:address-data>`;
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}
const gone = (href: string) => `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
const truncated = `<d:response><d:href>${BOOK_PATH}/</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>`;
const ms = (token: string, ...items: string[]) =>
  new Response(`<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${items.join('')}<d:sync-token>${token}</d:sync-token></d:multistatus>`, {
    status: 207,
  });

beforeEach(() => {
  requests = [];
  replies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      requests.push({ method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: String(init.body ?? '') });
      const next = replies.shift();
      if (!next) throw new Error('unexpected request');
      return next();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAddressBookChanges', () => {
  it('reads the whole address book with an empty token, returning parsed cards and the new token', async () => {
    replies.push(() => ms('tok-1', ok(`${BOOK_PATH}/a.vcf`, vcard('a', 'Ann'))));

    const result = await fetchAddressBookChanges(BOOK, CREDS);

    expect(requests[0]).toMatchObject({ method: 'REPORT', headers: expect.objectContaining({ Depth: '0' }) });
    expect(requests[0]!.body).toContain('<d:sync-token></d:sync-token>');
    expect(result).toMatchObject({ syncToken: 'tok-1', full: true, removedHrefs: [] });
    expect(result.changed).toEqual([{ href: `${BOOK_PATH}/a.vcf`, card: expect.objectContaining({ uid: 'a', displayName: 'Ann' }) }]);
  });

  it('sends the previous token and reports removals separately from changes', async () => {
    replies.push(() => ms('tok-2', ok(`${BOOK_PATH}/b.vcf`, vcard('b', 'Bo')), gone(`${BOOK_PATH}/a.vcf`)));

    const result = await fetchAddressBookChanges(BOOK, CREDS, 'tok-1');

    expect(requests[0]!.body).toContain('<d:sync-token>tok-1</d:sync-token>');
    expect(result.full).toBe(false);
    expect(result.changed.map((c) => c.card.uid)).toEqual(['b']);
    expect(result.removedHrefs).toEqual([`${BOOK_PATH}/a.vcf`]);
  });

  it('starts over with a full read when the server rejects an expired token', async () => {
    replies.push(() => new Response('', { status: 409 }));
    replies.push(() => ms('tok-new', ok(`${BOOK_PATH}/a.vcf`, vcard('a', 'Ann'))));

    const result = await fetchAddressBookChanges(BOOK, CREDS, 'stale');

    expect(requests[1]!.body).toContain('<d:sync-token></d:sync-token>');
    expect(result).toMatchObject({ syncToken: 'tok-new', full: true });
  });

  it('keeps reading when the server truncates its reply', async () => {
    replies.push(() => ms('tok-part', ok(`${BOOK_PATH}/a.vcf`, vcard('a', 'Ann')), truncated));
    replies.push(() => ms('tok-done', ok(`${BOOK_PATH}/b.vcf`, vcard('b', 'Bo'))));

    const result = await fetchAddressBookChanges(BOOK, CREDS);

    expect(requests[1]!.body).toContain('<d:sync-token>tok-part</d:sync-token>');
    expect(result.syncToken).toBe('tok-done');
    expect(result.changed.map((c) => c.card.uid)).toEqual(['a', 'b']);
  });

  it('fetches card data the sync reply left out', async () => {
    replies.push(() => ms('tok-1', ok(`${BOOK_PATH}/a.vcf`)));
    replies.push(() => ms('', ok(`${BOOK_PATH}/a.vcf`, vcard('a', 'Ann'))));

    const result = await fetchAddressBookChanges(BOOK, CREDS);

    expect(requests[1]!.body).toContain('addressbook-multiget');
    expect(requests[1]!.body).toContain(`<d:href>${BOOK_PATH}/a.vcf</d:href>`);
    expect(result.changed.map((c) => c.card.uid)).toEqual(['a']);
  });

  it('throws when the server refuses sync-collection outright', async () => {
    replies.push(() => new Response('', { status: 403 }));
    await expect(fetchAddressBookChanges(BOOK, CREDS)).rejects.toThrow(/HTTP 403/);
  });
});
