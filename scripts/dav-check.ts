#!/usr/bin/env -S npx tsx
/**
 * Read-only check of a CalDAV/CardDAV setup (Fastmail, iCloud, ...). Never
 * writes to the calendar, the address book, or Banjo's database.
 *
 * 1. Signs in with DAV_USERNAME / DAV_PASSWORD and lists the account's
 *    calendars and address books with their URLs — copy one of each into
 *    CALDAV_CALENDAR_URL and CARDDAV_ADDRESSBOOK_URL.
 * 2. If CARDDAV_ADDRESSBOOK_URL is set, reads the address book and summarizes
 *    what Banjo will see: contacts with phone numbers, groups, relations.
 * 3. If CALDAV_CALENDAR_URL is set, lists the next 7 days of what Banjo will
 *    treat as busy, in CALENDAR_TIMEZONE. Compare it with your calendar app.
 *    This step loads Banjo's full config, so the rest of .env must be valid.
 *
 * Usage:
 *   npm run dav:check [-- --caldav-server https://caldav.fastmail.com --carddav-server https://carddav.fastmail.com]
 */

import 'dotenv/config';
import { fetchAddressBookChanges } from '../src/carddavContacts/client.js';
import { discoverCollections, type CollectionKind } from '../src/lib/dav/discovery.js';
import type { DavCredentials } from '../src/lib/dav/davHttp.js';

const LOOKAHEAD_DAYS = 7;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const sameUrl = (a: string, b: string) => a.replace(/\/?$/, '/') === b.replace(/\/?$/, '/');

async function listCollections(kind: CollectionKind, server: string, configured: string | undefined, envName: string, credentials: DavCredentials) {
  console.log(`\n${kind === 'calendar' ? 'Calendars' : 'Address books'} on ${server}:`);
  try {
    const collections = await discoverCollections(server, credentials, kind);
    for (const c of collections) {
      const marker = configured && sameUrl(c.url, configured) ? `  <- ${envName}` : '';
      console.log(`  ${c.displayName}\n    ${c.url}${marker}`);
    }
    if (collections.length === 0) console.log('  (none found)');
  } catch (err) {
    console.log(`  Could not list them: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function summarizeAddressBook(url: string, credentials: DavCredentials) {
  console.log(`\nAddress book ${url}:`);
  const { changed } = await fetchAddressBookChanges(url, credentials);
  const people = changed.filter((c) => c.card.kind === 'individual');
  const groups = changed.filter((c) => c.card.kind === 'group');
  const withPhone = people.filter((c) => c.card.phones.length > 0);
  console.log(`  ${people.length} contacts, ${withPhone.length} with a phone number (only those can identify a caller)`);

  const groupNames = new Map<string, number>();
  for (const g of groups) groupNames.set(g.card.displayName ?? 'Unnamed group', g.card.memberUids.length);
  for (const p of people) for (const c of p.card.categories) groupNames.set(c, (groupNames.get(c) ?? 0) + 1);
  console.log(`  Groups: ${groupNames.size ? [...groupNames].map(([n, count]) => `${n} (${count})`).join(', ') : '(none)'}`);

  const relations = new Map<string, number>();
  for (const p of people) for (const r of p.card.relationLabels) relations.set(r, (relations.get(r) ?? 0) + 1);
  console.log(`  Relations: ${relations.size ? [...relations].map(([r, count]) => `${r} (${count})`).join(', ') : '(none)'}`);
  console.log('  Banjo treats groups named "Family" or "Friends", and relations like spouse or child, as close contacts.');
}

async function showBusy(calendarUrl: string, credentials: DavCredentials) {
  // Imported only now: this loads and validates Banjo's whole config.
  const { config } = await import('../src/config/index.js');
  const { CaldavCalendarProvider } = await import('../src/calendar/caldavCalendarProvider.js');
  const { formatSpokenInZone } = await import('../src/lib/timezone.js');

  const provider = new CaldavCalendarProvider({ calendarUrl, ...credentials, timeZone: config.CALENDAR_TIMEZONE });
  const now = Date.now();
  const busy = await provider.getBusyIntervals({
    start: new Date(now).toISOString(),
    end: new Date(now + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });

  console.log(`\nBusy in the next ${LOOKAHEAD_DAYS} days on ${calendarUrl} (${config.CALENDAR_TIMEZONE}):`);
  for (const b of busy.sort((x, y) => x.startMs - y.startMs)) {
    const start = formatSpokenInZone(new Date(b.startMs).toISOString(), config.CALENDAR_TIMEZONE);
    const end = formatSpokenInZone(new Date(b.endMs).toISOString(), config.CALENDAR_TIMEZONE);
    console.log(`  ${start.day} ${start.time} – ${end.day === start.day ? '' : `${end.day} `}${end.time}`);
  }
  if (busy.length === 0) console.log('  (nothing busy)');
  if (config.CALENDAR_PROVIDER !== 'caldav') console.log('  Banjo is still using Google Calendar — set CALENDAR_PROVIDER=caldav to switch.');
  if (config.CONTACTS_PROVIDER !== 'carddav') console.log('  Banjo is not using CardDAV contacts yet — set CONTACTS_PROVIDER=carddav to switch.');
}

async function main(): Promise<void> {
  const username = process.env.DAV_USERNAME;
  const password = process.env.DAV_PASSWORD;
  if (!username || !password) {
    console.error('Set DAV_USERNAME and DAV_PASSWORD (an app password) in .env first.');
    process.exit(1);
  }
  const credentials = { username, password };
  const calendarUrl = process.env.CALDAV_CALENDAR_URL;
  const addressBookUrl = process.env.CARDDAV_ADDRESSBOOK_URL;

  const caldavServer = argValue('--caldav-server') ?? (calendarUrl ? new URL(calendarUrl).origin : 'https://caldav.fastmail.com');
  const carddavServer = argValue('--carddav-server') ?? (addressBookUrl ? new URL(addressBookUrl).origin : 'https://carddav.fastmail.com');

  console.log(`Signed in as ${username}.`);
  await listCollections('calendar', caldavServer, calendarUrl, 'CALDAV_CALENDAR_URL', credentials);
  await listCollections('addressbook', carddavServer, addressBookUrl, 'CARDDAV_ADDRESSBOOK_URL', credentials);

  if (addressBookUrl) await summarizeAddressBook(addressBookUrl, credentials);
  if (calendarUrl) await showBusy(calendarUrl, credentials);
  if (!calendarUrl || !addressBookUrl) {
    console.log('\nSet CALDAV_CALENDAR_URL and CARDDAV_ADDRESSBOOK_URL from the URLs above, then run this again.');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
