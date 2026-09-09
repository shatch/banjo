import { eq, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
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

async function findCachedByPhone(e164: string): Promise<GoogleContactMatch | undefined> {
  const rows = await db.select().from(googleContacts);
  for (const row of rows) {
    if (row.phoneNumbers.some((p) => p.e164 === e164)) return toMatch(row, e164);
  }
  return undefined;
}

async function findCachedByName(query: string): Promise<GoogleContactMatch[]> {
  const rows = await db.select().from(googleContacts).where(ilike(googleContacts.displayName, `%${query}%`));
  return rows.map((row) => toMatch(row, row.phoneNumbers[0]?.e164)).filter((m): m is GoogleContactMatch => !!m);
}

/**
 * Never throws and never exceeds timeoutMs — a live lookup failing or being
 * slow must fail closed to "no match," not block or crash the caller.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
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
    await upsertGoogleContact(person, groupLabelsByResourceName); // cache the hit for next time
    const [row] = await db.select().from(googleContacts).where(eq(googleContacts.googleResourceName, person.resourceName));
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
