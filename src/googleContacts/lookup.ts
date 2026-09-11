import { ilike, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { withTimeout as raceWithTimeout } from '../lib/withTimeout.js';
import { fetchGroupLabels, upsertGoogleContact } from './sync.js';
import { createPeopleClient } from './googlePeopleClient.js';
import { googleContacts, type GoogleContact } from './schema.js';

export interface GoogleContactMatch {
  googleResourceName: string;
  displayName: string;
  phoneNumber: string;
  email: string | undefined;
  relationLabels: string[];
  groupLabels: string[];
}

// Inbound is on the call-answering hot path — kept short so a slow/failed
// live lookup can never meaningfully delay answering a real phone call.
// Outbound is a normal MCP tool call, not latency-critical the same way.
const INBOUND_LOOKUP_TIMEOUT_MS = 1800;
const OUTBOUND_LOOKUP_TIMEOUT_MS = 5000;

function toMatch(row: GoogleContact, phoneNumber: string | undefined): GoogleContactMatch | undefined {
  // A Google contact with no phone number at all can't be auto-provisioned
  // into contacts (phoneNumber is NOT NULL there), so it can't be a match.
  if (!phoneNumber) return undefined;
  return {
    googleResourceName: row.googleResourceName,
    displayName: row.displayName,
    phoneNumber,
    email: row.email ?? undefined,
    relationLabels: row.relationLabels,
    groupLabels: row.groupLabels,
  };
}

/**
 * Which of a contact's numbers to report as "the" match. people.searchContacts
 * matches fuzzily and a contact can hold several numbers (mobile + home), so
 * when we searched for a specific number, that number — not whichever one
 * happens to be stored first — is the one that identifies this caller.
 */
function pickPhoneNumber(row: GoogleContact, preferE164: string | undefined): string | undefined {
  if (preferE164 && row.phoneNumbers.some((p) => p.e164 === preferE164)) return preferE164;
  return row.phoneNumbers[0]?.e164;
}

/**
 * Filters server-side via jsonb `@>` containment (backed by the GIN index
 * on phoneNumbers, src/googleContacts/schema.ts) rather than loading every
 * cached contact and testing in JS — this runs on the 1800ms inbound
 * call-answering hot path, so cost must not scale with total contact count.
 * `@>` array containment matches an object element by subset, so
 * `[{"e164": e164}]` matches a cached `{e164, type}` entry without needing
 * the `type` field.
 */
async function findCachedByPhone(e164: string): Promise<GoogleContactMatch | undefined> {
  const [row] = await db
    .select()
    .from(googleContacts)
    .where(sql`${googleContacts.phoneNumbers} @> ${JSON.stringify([{ e164 }])}::jsonb`)
    .limit(1);
  return row ? toMatch(row, e164) : undefined;
}

async function findCachedByName(query: string): Promise<GoogleContactMatch[]> {
  const rows = await db.select().from(googleContacts).where(ilike(googleContacts.displayName, `%${query}%`));
  return rows.map((row) => toMatch(row, row.phoneNumbers[0]?.e164)).filter((m): m is GoogleContactMatch => !!m);
}

/**
 * Never throws and never exceeds timeoutMs — a live lookup failing or being
 * slow must fail closed to "no match," not block or crash the caller.
 * Delegates the actual race to src/lib/withTimeout.ts (which clears its
 * timer in a `finally`, unlike a bespoke `Promise.race` + bare `setTimeout`
 * would) and layers the fail-closed semantics on top: both a timeout and a
 * genuine rejection from `promise` are logged and turned into `undefined`
 * rather than propagated.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  try {
    return await raceWithTimeout(promise, timeoutMs);
  } catch (err) {
    logger.error({ err }, 'Google Contacts live lookup failed');
    return undefined;
  }
}

async function liveSearch(query: string, preferE164?: string): Promise<GoogleContactMatch[]> {
  const people = createPeopleClient();
  const { data } = await people.people.searchContacts({ query, readMask: 'names,phoneNumbers,emailAddresses,relations,memberships' });
  const groupLabelsByResourceName = await fetchGroupLabels(people);

  const matches: GoogleContactMatch[] = [];
  for (const result of data.results ?? []) {
    const person = result.person;
    if (!person?.resourceName) continue;
    // Uses the row upsertGoogleContact returns directly, rather than a
    // separate re-select by resourceName — a write-then-reread as two
    // statements left a window for a concurrent writer (the periodic sync,
    // or another liveSearch for the same person) to land in between,
    // making the reread return stale/different data than what was just
    // cached, so pickPhoneNumber could miss the queried number.
    const row = await upsertGoogleContact(person, groupLabelsByResourceName);
    if (row) {
      const match = toMatch(row, pickPhoneNumber(row, preferE164));
      if (match) matches.push(match);
    }
  }
  return matches;
}

export async function findByPhone(e164: string, timeoutMs = INBOUND_LOOKUP_TIMEOUT_MS): Promise<GoogleContactMatch | undefined> {
  const cached = await findCachedByPhone(e164);
  if (cached) return cached;
  const live = await withTimeout(liveSearch(e164, e164), timeoutMs);
  // No `?? live[0]` fallback: people.searchContacts matches fuzzily, so a
  // result that doesn't actually hold the queried number is a different
  // person. Returning them would auto-provision a stranger's contact row and
  // personalize the greeting for the wrong caller — fail closed instead.
  return live?.find((m) => m.phoneNumber === e164);
}

export async function findByName(query: string, timeoutMs = OUTBOUND_LOOKUP_TIMEOUT_MS): Promise<GoogleContactMatch[]> {
  const cached = await findCachedByName(query);
  if (cached.length > 0) return cached;
  const live = await withTimeout(liveSearch(query), timeoutMs);
  return live ?? [];
}
