/**
 * Reads a CardDAV address book (Fastmail, iCloud, Nextcloud) with a
 * sync-collection REPORT (RFC 6578): given the token from the last read, the
 * server returns only the cards added, changed, or removed since — so the
 * live-lookup fallback in src/googleContacts/lookup.ts can afford to refresh
 * before re-checking the cache. No app config and no database here;
 * src/carddavContacts/sync.ts applies the result to the cache.
 */

import { davRequest, isOkStatus, parseMultistatusWithToken, textOf, type DavCredentials, type DavResponse } from '../lib/dav/davHttp.js';
import { parseCard, type ParsedCard } from './vcard.js';

const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };
// A server may cap how many changes one response holds (507 on the collection
// itself, with a token to continue from). Bounds the follow-up requests.
const MAX_CONTINUATIONS = 50;
const MULTIGET_BATCH = 100;

export interface AddressBookCard {
  /** Decoded absolute path — stable per card, and how removals are reported. */
  href: string;
  card: ParsedCard;
}

export interface AddressBookChanges {
  /** Pass back next time to get only what changed after this read. */
  syncToken: string | undefined;
  /** True when `changed` is the whole address book (no token, or the server rejected the old one). */
  full: boolean;
  changed: AddressBookCard[];
  removedHrefs: string[];
}

function canonicalPath(href: string, base: string): string {
  return decodeURIComponent(new URL(href, base).pathname).replace(/\/$/, '');
}

function syncCollectionBody(syncToken: string | undefined): string {
  const escaped = (syncToken ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:sync-token>${escaped}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag/><card:address-data/></d:prop>
</d:sync-collection>`;
}

/**
 * Everything that changed in the address book since `syncToken`, or the
 * whole address book when there's no token or the server no longer accepts
 * it (RFC 6578 answers an expired token with 403 or 409).
 */
export async function fetchAddressBookChanges(
  addressBookUrl: string,
  credentials: DavCredentials,
  syncToken?: string,
): Promise<AddressBookChanges> {
  const collectionPath = canonicalPath(addressBookUrl, addressBookUrl);
  let token = syncToken;
  let full = !syncToken;
  // Keyed by href so a card changed twice across continuations keeps its latest state.
  const latest = new Map<string, { removed: true } | { removed: false; data: string | undefined }>();

  for (let continuation = 0; ; continuation++) {
    if (continuation > MAX_CONTINUATIONS) throw new Error(`CardDAV sync of ${addressBookUrl} did not finish after ${MAX_CONTINUATIONS} continuations`);

    const response = await davRequest({
      method: 'REPORT',
      url: addressBookUrl,
      credentials,
      headers: { ...XML_HEADERS, Depth: '0' },
      body: syncCollectionBody(token),
      allowStatuses: token ? [403, 409] : [],
    });
    if (response.status === 403 || response.status === 409) {
      // The token expired or the server reset. Start over with a full read.
      await response.body?.cancel();
      token = undefined;
      full = true;
      latest.clear();
      continue;
    }

    const { responses, syncToken: nextToken } = parseMultistatusWithToken(await response.text());
    token = nextToken;
    let truncated = false;

    for (const item of responses) {
      const path = canonicalPath(item.href, addressBookUrl);
      if (path === collectionPath) {
        if (item.status?.includes(' 507')) truncated = true;
        continue;
      }
      if (item.status?.includes(' 404')) {
        latest.set(path, { removed: true });
        continue;
      }
      latest.set(path, { removed: false, data: addressDataOf(item) });
    }

    if (!truncated) break;
  }

  // Some servers list changes without the card data; fetch those in batches.
  const missing = [...latest].filter(([, v]) => !v.removed && !v.data).map(([href]) => href);
  for (let i = 0; i < missing.length; i += MULTIGET_BATCH) {
    const fetched = await multiget(addressBookUrl, credentials, missing.slice(i, i + MULTIGET_BATCH));
    for (const [href, data] of fetched) latest.set(href, { removed: false, data });
  }

  const changed: AddressBookCard[] = [];
  const removedHrefs: string[] = [];
  for (const [href, state] of latest) {
    if (state.removed) removedHrefs.push(href);
    else if (state.data) {
      const card = parseCard(state.data);
      if (card) changed.push({ href, card });
    }
  }
  return { syncToken: token, full, changed, removedHrefs };
}

function addressDataOf(item: DavResponse): string | undefined {
  for (const propstat of item.propstats) {
    if (!isOkStatus(propstat.status)) continue;
    const data = textOf(propstat.prop['address-data']);
    if (data) return data;
  }
  return undefined;
}

async function multiget(addressBookUrl: string, credentials: DavCredentials, hrefs: string[]): Promise<Map<string, string>> {
  const hrefXml = hrefs.map((h) => `<d:href>${encodeURI(h).replace(/&/g, '&amp;')}</d:href>`).join('');
  const response = await davRequest({
    method: 'REPORT',
    url: addressBookUrl,
    credentials,
    headers: { ...XML_HEADERS, Depth: '1' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><card:address-data/></d:prop>
  ${hrefXml}
</card:addressbook-multiget>`,
  });
  const found = new Map<string, string>();
  for (const item of parseMultistatusWithToken(await response.text()).responses) {
    const data = addressDataOf(item);
    if (data) found.set(canonicalPath(item.href, addressBookUrl), data);
  }
  return found;
}
