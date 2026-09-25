/**
 * Keeps the local contacts cache (the `google_contacts` table — named for
 * the first source it held) in step with a CardDAV address book, when
 * CONTACTS_PROVIDER=carddav. Rows are keyed `carddav:<vCard UID>` in
 * googleResourceName, so they can't collide with Google's "people/..." names,
 * and the rest of the contacts code (lookup, reconcile) works on them
 * unchanged.
 *
 * The first sync after boot reads the whole address book and makes the cache
 * match it exactly, removing rows for anyone no longer there (including rows
 * left from a previous Google setup). Later syncs send the server's sync
 * token and apply only what changed. The token and what's needed to apply a
 * removal live in memory only, so a restart just means one full read.
 */

import { eq, notInArray } from 'drizzle-orm';
import { config, contactsSyncIntervalHours } from '../config/index.js';
import { db } from '../db/index.js';
import { normalizePhoneNumber } from '../googleContacts/phoneNormalization.js';
import { googleContacts, type GooglePhoneNumber } from '../googleContacts/schema.js';
import { upsertCachedContact } from '../googleContacts/sync.js';
import { logger } from '../lib/logger.js';
import { fetchAddressBookChanges, type AddressBookCard } from './client.js';

const RESOURCE_PREFIX = 'carddav:';

interface SyncState {
  syncToken: string | undefined;
  /** Which cache row each card href fills, to apply a removal (the server reports only the href). */
  uidByHref: Map<string, string>;
  /** Group cards by href: their names and members' UIDs. */
  groups: Map<string, { name: string; memberUids: Set<string> }>;
}

let state: SyncState = emptyState();
let inFlight: Promise<void> | undefined;

function emptyState(): SyncState {
  return { syncToken: undefined, uidByHref: new Map(), groups: new Map() };
}

/** For tests: forget the sync token, as a restart would. */
export function resetCardDavSyncState(): void {
  state = emptyState();
}

function resourceName(uid: string): string {
  return `${RESOURCE_PREFIX}${uid}`;
}

function uidOf({ href, card }: AddressBookCard): string {
  // A card with no UID is out of spec, but its href still identifies it.
  return card.uid ?? href;
}

function groupLabelsFor(uid: string, categories: string[]): string[] {
  const fromGroups = [...state.groups.values()].filter((g) => g.memberUids.has(uid)).map((g) => g.name);
  return [...new Set([...categories, ...fromGroups])];
}

async function upsertCard(entry: AddressBookCard): Promise<string> {
  const uid = uidOf(entry);
  const { card } = entry;
  const phoneNumbers: GooglePhoneNumber[] = card.phones
    .map((p): GooglePhoneNumber | undefined => {
      const e164 = normalizePhoneNumber(p.value);
      if (!e164) return undefined;
      return p.type ? { e164, type: p.type } : { e164 };
    })
    .filter((p): p is GooglePhoneNumber => p !== undefined);

  await upsertCachedContact({
    googleResourceName: resourceName(uid),
    displayName: card.displayName ?? 'Unknown',
    phoneNumbers,
    email: card.email ?? null,
    relationLabels: card.relationLabels,
    groupLabels: groupLabelsFor(uid, card.categories),
  });
  state.uidByHref.set(entry.href, uid);
  return uid;
}

async function fullSync(): Promise<void> {
  const changes = await fetchAddressBookChanges(config.CARDDAV_ADDRESSBOOK_URL!, credentials());
  await applyFull(changes.changed);
  state.syncToken = changes.syncToken;
}

async function applyFull(cards: AddressBookCard[]): Promise<void> {
  state = emptyState();
  // Groups first, so every contact's labels are complete on its first write.
  for (const entry of cards) {
    if (entry.card.kind === 'group') {
      state.groups.set(entry.href, { name: entry.card.displayName ?? 'Unnamed group', memberUids: new Set(entry.card.memberUids) });
    }
  }
  const kept: string[] = [];
  for (const entry of cards) {
    if (entry.card.kind === 'group') continue;
    kept.push(resourceName(await upsertCard(entry)));
  }
  // The cache mirrors the address book: drop everyone else, including rows
  // from a previous Google Contacts setup, so a stale entry can't identify a caller.
  await (kept.length > 0 ? db.delete(googleContacts).where(notInArray(googleContacts.googleResourceName, kept)) : db.delete(googleContacts));
}

async function syncOnce(): Promise<void> {
  if (!state.syncToken) return fullSync();

  const changes = await fetchAddressBookChanges(config.CARDDAV_ADDRESSBOOK_URL!, credentials(), state.syncToken);
  if (changes.full) {
    await applyFull(changes.changed);
    state.syncToken = changes.syncToken;
    return;
  }

  // A group change can relabel any number of contacts. Rare enough that a
  // full read is simpler than tracking which contacts it touched.
  const groupChanged =
    changes.changed.some((entry) => entry.card.kind === 'group' || state.groups.has(entry.href)) ||
    changes.removedHrefs.some((href) => state.groups.has(href));
  if (groupChanged) return fullSync();

  for (const entry of changes.changed) {
    const previousUid = state.uidByHref.get(entry.href);
    const uid = await upsertCard(entry);
    if (previousUid && previousUid !== uid) await db.delete(googleContacts).where(eq(googleContacts.googleResourceName, resourceName(previousUid)));
  }
  for (const href of changes.removedHrefs) {
    const uid = state.uidByHref.get(href);
    if (!uid) continue;
    await db.delete(googleContacts).where(eq(googleContacts.googleResourceName, resourceName(uid)));
    state.uidByHref.delete(href);
  }
  state.syncToken = changes.syncToken;
}

function credentials() {
  return { username: config.DAV_USERNAME!, password: config.DAV_PASSWORD! };
}

/**
 * Brings the cache up to date. Concurrent callers (the poller, a live
 * lookup) share one sync rather than racing two. Throws on failure — the
 * callers below decide how to fail closed.
 */
export function syncCardDavContacts(): Promise<void> {
  inFlight ??= syncOnce().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/** Never throws — a failed sync leaves the cache as it was until the next tick. */
export async function runCardDavContactsSync(): Promise<void> {
  try {
    await syncCardDavContacts();
    logger.info('CardDAV contacts sync completed');
  } catch (err) {
    logger.error({ err }, 'CardDAV contacts sync failed');
  }
}

/** Runs once immediately, then every contactsSyncIntervalHours(). */
export function startCardDavContactsSyncPoller(): void {
  void runCardDavContactsSync();
  setInterval(() => void runCardDavContactsSync(), contactsSyncIntervalHours() * 60 * 60 * 1000);
}
