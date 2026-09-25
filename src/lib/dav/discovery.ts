/**
 * Finds the calendars or address books on a DAV account (RFC 6764 service
 * discovery, then RFC 4791 / RFC 6352 home sets), so the owner can pick one
 * for CALDAV_CALENDAR_URL or CARDDAV_ADDRESSBOOK_URL. Used only by
 * scripts/dav-check.ts — Banjo itself is configured with one URL of each and
 * never discovers at runtime.
 */

import { davRequest, okProps, parseMultistatus, textOf, type DavCredentials } from './davHttp.js';

export type CollectionKind = 'calendar' | 'addressbook';

export interface DiscoveredCollection {
  url: string;
  displayName: string;
}

const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };

const KINDS = {
  calendar: { wellKnown: '/.well-known/caldav', homeSet: '<c:calendar-home-set/>', homeSetProp: 'calendar-home-set' },
  addressbook: { wellKnown: '/.well-known/carddav', homeSet: '<card:addressbook-home-set/>', homeSetProp: 'addressbook-home-set' },
} as const;

async function propfind(url: string, credentials: DavCredentials, depth: '0' | '1', props: string) {
  const response = await davRequest({
    method: 'PROPFIND',
    url,
    credentials,
    headers: { ...XML_HEADERS, Depth: depth },
    body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>${props}</d:prop>
</d:propfind>`,
  });
  // Resolve hrefs against where we ended up, after any redirect.
  return { baseUrl: response.url || url, responses: parseMultistatus(await response.text()) };
}

function hrefIn(prop: unknown): string | undefined {
  if (!prop || typeof prop !== 'object') return undefined;
  const hrefs = (prop as { href?: unknown[] }).href;
  return textOf(hrefs?.[0]);
}

/**
 * Lists the `kind` collections for `credentials` on the server at `serverUrl`
 * (e.g. https://caldav.fastmail.com or https://carddav.fastmail.com).
 * Calendars that hold only tasks (VTODO) are left out.
 */
export async function discoverCollections(serverUrl: string, credentials: DavCredentials, kind: CollectionKind): Promise<DiscoveredCollection[]> {
  const { wellKnown, homeSet, homeSetProp } = KINDS[kind];

  const start = new URL(wellKnown, serverUrl).toString();
  const principalLookup = await propfind(start, credentials, '0', '<d:current-user-principal/>');
  const principalHref = principalLookup.responses.map((r) => hrefIn(okProps(r)['current-user-principal'])).find(Boolean);
  if (!principalHref) throw new Error(`No current-user-principal found at ${start}`);
  const principalUrl = new URL(principalHref, principalLookup.baseUrl).toString();

  const homeLookup = await propfind(principalUrl, credentials, '0', homeSet);
  const homeHref = homeLookup.responses.map((r) => hrefIn(okProps(r)[homeSetProp])).find(Boolean);
  if (!homeHref) throw new Error(`No ${homeSetProp} found for principal ${principalUrl}`);
  const homeUrl = new URL(homeHref, homeLookup.baseUrl).toString();

  const listing = await propfind(homeUrl, credentials, '1', '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>');

  const collections: DiscoveredCollection[] = [];
  for (const response of listing.responses) {
    const props = okProps(response);
    const resourceType = props.resourcetype;
    const isKind = !!resourceType && typeof resourceType === 'object' && kind in resourceType;
    if (!isKind) continue;
    if (kind === 'calendar' && props['supported-calendar-component-set']) {
      // Skip task-only (VTODO) collections when the server says what a collection holds.
      if (!JSON.stringify(props['supported-calendar-component-set']).includes('VEVENT')) continue;
    }
    collections.push({
      url: new URL(response.href, listing.baseUrl).toString(),
      displayName: textOf(props.displayname) ?? '(unnamed)',
    });
  }
  return collections;
}
