import type { people_v1 } from 'googleapis';
import { config } from '../config/index.js';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { createPeopleClient } from './googlePeopleClient.js';
import { normalizePhoneNumber } from './phoneNormalization.js';
import { googleContacts, type GoogleContact, type GooglePhoneNumber } from './schema.js';

const PERSON_FIELDS = 'names,phoneNumbers,emailAddresses,relations,memberships';
const PAGE_SIZE = 200;

/**
 * Resolves each contact group's resource name (e.g. "contactGroups/abc123")
 * to its human label (e.g. "Family") — People API's connections.list only
 * ever returns the resource name on a membership, never the label, so this
 * is a required second call. Refetched every sync run rather than cached
 * separately: the principal's group list is tiny, and this keeps the sync
 * job free of its own cache-invalidation problem.
 */
export async function fetchGroupLabels(people: people_v1.People): Promise<Map<string, string>> {
  const { data } = await people.contactGroups.list({ pageSize: PAGE_SIZE, groupFields: 'name' });
  const map = new Map<string, string>();
  for (const group of data.contactGroups ?? []) {
    if (group.resourceName && group.name) map.set(group.resourceName, group.name);
  }
  return map;
}

/**
 * Upserts one Google Contacts person into the local cache. Exported (not
 * module-private) so src/googleContacts/lookup.ts's live-fallback path can
 * cache a fresh live-search hit through the exact same logic, rather than
 * duplicating the field-mapping rules.
 *
 * Returns the upserted row directly (via `.returning()`) rather than making
 * the caller do a separate SELECT afterward — a write-then-reread as two
 * statements would leave a window for a concurrent writer (the periodic
 * sync, or another live search for the same person) to land in between,
 * making the reread return someone else's newer data instead of what was
 * just written.
 */
export async function upsertGoogleContact(
  person: people_v1.Schema$Person,
  groupLabelsByResourceName: Map<string, string>,
): Promise<GoogleContact | undefined> {
  if (!person.resourceName) return undefined;

  const displayName = person.names?.[0]?.displayName ?? 'Unknown';
  const phoneNumbers: GooglePhoneNumber[] = (person.phoneNumbers ?? [])
    .map((p): GooglePhoneNumber | undefined => {
      const e164 = p.value ? normalizePhoneNumber(p.value) : undefined;
      if (!e164) return undefined;
      return p.type ? { e164, type: p.type } : { e164 };
    })
    .filter((p): p is GooglePhoneNumber => p !== undefined);
  // `?? null`, not `?? undefined`: drizzle's onConflictDoUpdate set clause
  // (below) filters out any key whose value is `undefined`, so an
  // undefined email would silently leave a stale previously-cached address
  // in place once Google stops reporting one. `null` is a real column
  // value here and always makes it into the UPDATE.
  const email = person.emailAddresses?.[0]?.value ?? null;
  const relationLabels = (person.relations ?? []).map((r) => r.type).filter((t): t is string => !!t);
  const groupLabels = (person.memberships ?? [])
    .map((m) => m.contactGroupMembership?.contactGroupResourceName)
    .filter((r): r is string => !!r)
    .map((resourceName) => groupLabelsByResourceName.get(resourceName))
    .filter((label): label is string => !!label);

  const values = {
    googleResourceName: person.resourceName,
    displayName,
    phoneNumbers,
    email,
    relationLabels,
    groupLabels,
    lastSyncedAt: new Date(),
  };

  const [row] = await db
    .insert(googleContacts)
    .values(values)
    .onConflictDoUpdate({ target: googleContacts.googleResourceName, set: values })
    .returning();
  return row;
}

async function syncOnce(): Promise<void> {
  const people = createPeopleClient();
  const groupLabelsByResourceName = await fetchGroupLabels(people);

  let pageToken: string | undefined;
  do {
    const { data } = await people.people.connections.list({
      resourceName: 'people/me',
      personFields: PERSON_FIELDS,
      pageSize: PAGE_SIZE,
      pageToken,
    });
    for (const person of data.connections ?? []) {
      await upsertGoogleContact(person, groupLabelsByResourceName);
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
}

/**
 * Never throws — a failed sync just leaves the local cache stale until the
 * next tick, same fail-closed posture as every other lookup in this module.
 * Matches src/tasks/orchestrator.ts's poller idiom (log, don't crash).
 */
export async function runGoogleContactsSync(): Promise<void> {
  if (!config.GOOGLE_OAUTH_REFRESH_TOKEN) {
    logger.info('Google Contacts sync skipped — GOOGLE_OAUTH_REFRESH_TOKEN not configured');
    return;
  }
  try {
    await syncOnce();
    logger.info('Google Contacts sync completed');
  } catch (err) {
    logger.error({ err }, 'Google Contacts sync failed');
  }
}

/** Runs once immediately, then on GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS. */
export function startGoogleContactsSyncPoller(): void {
  void runGoogleContactsSync();
  setInterval(() => void runGoogleContactsSync(), config.GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS * 60 * 60 * 1000);
}
