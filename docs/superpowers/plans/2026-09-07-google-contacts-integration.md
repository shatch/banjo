# Google Contacts Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the Google People API (same OAuth client as the existing `GoogleCalendarProvider`, a broader granted scope) to resolve real people for both outbound `find_contact` lookups and inbound caller ID, auto-provisioning matches into Banjo's own `contacts` table and personalizing the inbound greeting for family/friend/frequent contacts — with no change to booking capability.

**Architecture:** One new module, `src/googleContacts/` (a concrete client, not a swappable `*Provider` interface — there's only ever one real implementation). It owns a local sync cache (`google_contacts` table, refreshed on a timer) so hot-path lookups never wait on a live network call, a lookup layer used by both directions (cache-first, live-API fallback with a hard timeout on a miss), and a reconciliation step that creates/backfills rows in the existing `contacts` table. `src/contacts/schema.ts` and `src/inbound/systemPrompt.ts` get targeted extensions; the `schedule-appointment` skill needs no changes.

**Tech Stack:** TypeScript, Drizzle ORM/Postgres, `googleapis` (already a dependency — People API v1 client), new dependency `libphonenumber-js` for E.164 normalization, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-google-contacts-integration-design.md`

## Global Constraints

- Never overwrite curated local `contacts` fields (`displayName`, `category`, `preferredChannel`, `bookingUrl`, `notes`) from Google data — reconciliation only backfills fields that are currently null (`email`, `googleResourceName`, `relationshipTier`).
- Every hot-path lookup (inbound call answering, outbound `find_contact`) must fail closed to "no match" on any error/timeout — never throw, never block/delay the caller.
- `buildInboundSystemPrompt()` must produce byte-for-byte the same output as today when called with no caller context (regression safety for the common case: an unrecognized/anonymous caller).
- Inbound call *capability* never changes for a recognized personal contact — only greeting tone. The toolset stays `check_availability`/`suggest_times`/`book_appointment`/`find_my_booking`/`reschedule_booking`/`flag_for_owner_and_end_call` for everyone.
- **Deliberate simplification vs. the spec:** the spec describes an incremental sync using People API's `syncToken`. This plan does a full `people.connections.list` on every sync tick instead — personal contact lists are small (hundreds of entries, not more), a full list is 1-2 API calls at `pageSize: 200`, and dropping incremental-sync bookkeeping (token storage, 410-expiry handling, resumable paging state) removes real implementation/test complexity for no meaningful cost at this scale. The `google_contacts_sync_state` table from the spec is dropped entirely as a result.

---

### Task 1: Extend `contacts` schema — email, Google linkage, relationship tier, phone uniqueness

**Files:**
- Modify: `src/contacts/schema.ts`
- Modify: `src/contacts/service.ts`
- Create: `tests/contacts/service.test.ts`

**Interfaces:**
- Produces: `relationshipTierEnum` (values `'family' | 'friend'`) and updated `contacts` table (adds nullable `email`, `googleResourceName`, `relationshipTier`; adds unique indexes on `phoneNumber` and `googleResourceName`) from `src/contacts/schema.ts`.
- Produces: `getContactByPhoneNumber(phoneNumber: string): Promise<Contact | undefined>` from `src/contacts/service.ts`.
- Produces: `addContact` input type gains optional `email?: string`, `googleResourceName?: string`, `relationshipTier?: Contact['relationshipTier']`.
- Produces: `updateContact`'s patch type gains `'email' | 'googleResourceName' | 'relationshipTier'` to its allowed keys.

- [ ] **Step 1: Write the failing test for `getContactByPhoneNumber`**

Create `tests/contacts/service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/index.js';
import { contacts } from '../../src/contacts/schema.js';
import { addContact, getContactByPhoneNumber, updateContact } from '../../src/contacts/service.js';

beforeEach(async () => {
  await db.delete(contacts);
});

describe('getContactByPhoneNumber', () => {
  it('returns the contact with an exact phone number match', async () => {
    const created = await addContact({ displayName: 'Clauda', phoneNumber: '+15551234567' });
    const found = await getContactByPhoneNumber('+15551234567');
    expect(found?.id).toBe(created.id);
  });

  it('returns undefined when no contact has that phone number', async () => {
    expect(await getContactByPhoneNumber('+19998887777')).toBeUndefined();
  });
});

describe('addContact', () => {
  it('accepts email, googleResourceName, and relationshipTier', async () => {
    const created = await addContact({
      displayName: 'Mom',
      phoneNumber: '+15559990000',
      email: 'mom@example.com',
      googleResourceName: 'people/c123',
      relationshipTier: 'family',
    });
    expect(created.email).toBe('mom@example.com');
    expect(created.googleResourceName).toBe('people/c123');
    expect(created.relationshipTier).toBe('family');
  });
});

describe('updateContact', () => {
  it('can backfill email, googleResourceName, and relationshipTier', async () => {
    const created = await addContact({ displayName: 'Clauda', phoneNumber: '+15551234567' });
    const updated = await updateContact(created.id, {
      email: 'clauda@example.com',
      googleResourceName: 'people/c456',
      relationshipTier: 'friend',
    });
    expect(updated.email).toBe('clauda@example.com');
    expect(updated.googleResourceName).toBe('people/c456');
    expect(updated.relationshipTier).toBe('friend');
  });
});
```

This test file requires a real Postgres connection (matching this codebase's existing convention — `GoogleCalendarProvider`'s tests mock `googleapis`, but tables/service-layer tests here run against the local dev database from `DATABASE_URL`; no other `contacts`/`inbound` service test file exists yet to follow, so this establishes the pattern). Run it against your local dev Postgres, not the CI-style fake env in `vitest.config.ts` — that config only stubs `DATABASE_URL`'s *value* for schema validation, it does not stand up a real database.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contacts/service.test.ts`
Expected: FAIL — `getContactByPhoneNumber` is not exported, and `addContact`/`updateContact` reject the new fields (TypeScript compile error surfaced by Vitest, or a runtime error since the columns don't exist yet).

- [ ] **Step 3: Extend the schema**

Edit `src/contacts/schema.ts` — replace the whole file with:

```ts
import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const contactCategoryEnum = pgEnum('contact_category', [
  'salon',
  'medical',
  'restaurant',
  'home_services',
  'other',
]);

/** 'phone' | 'online' | null (unset — the skill asks Steve once, then persists the answer here). */
export const preferredChannelEnum = pgEnum('preferred_channel', ['phone', 'online']);

/** null = ordinary/business contact. Derived heuristically from Google Contacts relation/group labels — see src/googleContacts/reconcile.ts. */
export const relationshipTierEnum = pgEnum('relationship_tier', ['family', 'friend']);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    phoneNumber: text('phone_number').notNull(), // E.164
    category: contactCategoryEnum('category').notNull().default('other'),
    preferredChannel: preferredChannelEnum('preferred_channel'), // null = ask once, then set
    bookingUrl: text('booking_url'), // used by the schedule-appointment skill's online-booking path
    notes: text('notes'), // free text, injected into the live-call system prompt as context
    // The three columns below are enrichment from Google Contacts (see
    // src/googleContacts/reconcile.ts) — never set directly by the skill or
    // add_contact/update_contact's normal callers, and never overwritten
    // once set by anything other than the reconciliation backfill.
    email: text('email'), // nullable; not a communication channel yet, just data
    googleResourceName: text('google_resource_name'), // e.g. "people/c1234567890"
    relationshipTier: relationshipTierEnum('relationship_tier'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The dedupe key src/googleContacts/reconcile.ts relies on to avoid
    // double-provisioning the same person from two near-simultaneous
    // lookups (inbound + outbound). Pre-existing gap, closed here since
    // this feature is the first thing that actually depends on it.
    phoneNumberUnique: uniqueIndex('contacts_phone_number_unique').on(table.phoneNumber),
    // Postgres unique indexes allow multiple NULLs, so contacts with no
    // Google match are unaffected.
    googleResourceNameUnique: uniqueIndex('contacts_google_resource_name_unique').on(table.googleResourceName),
  }),
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
```

- [ ] **Step 4: Extend `contacts/service.ts`**

Edit `src/contacts/service.ts` — replace the whole file with:

```ts
import { eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contacts, type Contact, type NewContact } from './schema.js';

export async function addContact(input: {
  displayName: string;
  phoneNumber: string;
  category?: NewContact['category'];
  notes?: string;
  bookingUrl?: string;
  email?: string;
  googleResourceName?: string;
  relationshipTier?: NewContact['relationshipTier'];
}): Promise<Contact> {
  const [row] = await db
    .insert(contacts)
    .values({
      displayName: input.displayName,
      phoneNumber: input.phoneNumber,
      category: input.category ?? 'other',
      notes: input.notes,
      bookingUrl: input.bookingUrl,
      email: input.email,
      googleResourceName: input.googleResourceName,
      relationshipTier: input.relationshipTier,
    })
    .returning();
  if (!row) throw new Error('Failed to insert contact');
  return row;
}

export async function updateContact(
  id: string,
  patch: Partial<
    Pick<
      NewContact,
      | 'preferredChannel'
      | 'bookingUrl'
      | 'notes'
      | 'displayName'
      | 'phoneNumber'
      | 'category'
      | 'email'
      | 'googleResourceName'
      | 'relationshipTier'
    >
  >,
): Promise<Contact> {
  const [row] = await db
    .update(contacts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(contacts.id, id))
    .returning();
  if (!row) throw new Error(`Contact not found: ${id}`);
  return row;
}

export async function listContacts(category?: Contact['category']): Promise<Contact[]> {
  if (category) {
    return db.select().from(contacts).where(eq(contacts.category, category));
  }
  return db.select().from(contacts);
}

export async function getContact(id: string): Promise<Contact | undefined> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id));
  return row;
}

/** The dedupe/lookup key src/googleContacts/reconcile.ts and inbound caller-ID resolution rely on. */
export async function getContactByPhoneNumber(phoneNumber: string): Promise<Contact | undefined> {
  const [row] = await db.select().from(contacts).where(eq(contacts.phoneNumber, phoneNumber));
  return row;
}

export interface FindContactResult {
  bestMatch: Contact | undefined;
  alternates: Contact[];
}

/**
 * Fuzzy name match — simple ILIKE, sufficient at single-user scale. Returns
 * alternates alongside the best match so callers (the MCP tool, ultimately
 * the schedule-appointment skill) can surface ambiguity to Steve rather than
 * silently guessing which "Dr. Smith" was meant.
 */
export async function findContact(query: string): Promise<FindContactResult> {
  const matches = await db
    .select()
    .from(contacts)
    .where(or(ilike(contacts.displayName, `%${query}%`), ilike(contacts.notes, `%${query}%`)));
  return { bestMatch: matches[0], alternates: matches.slice(1) };
}
```

(The Google-fallback branch on `findContact` is added in Task 8 — this task only adds the plumbing it needs.)

- [ ] **Step 5: Generate and apply the migration**

Run: `npm run db:generate`
Expected: a new file under `drizzle/` describing the new columns/indexes (drizzle-kit names it automatically).

Run: `npm run db:migrate`
Expected: `migrations applied successfully!`

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/contacts/service.test.ts`
Expected: PASS (all cases)

- [ ] **Step 7: Run the full suite and typecheck to confirm no regressions**

Run: `npm run typecheck && npm test`
Expected: both clean — no existing test references the removed/changed shape in a way that breaks.

- [ ] **Step 8: Commit**

```bash
git add src/contacts/schema.ts src/contacts/service.ts tests/contacts/service.test.ts drizzle/
git commit -m "feat(contacts): add email/googleResourceName/relationshipTier and a unique phone index"
```

---

### Task 2: Config additions and phone number normalization

**Files:**
- Modify: `src/config/index.ts`
- Modify: `.env.example`
- Modify: `package.json` (via `npm install`)
- Create: `src/googleContacts/phoneNormalization.ts`
- Create: `tests/googleContacts/phoneNormalization.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `config.DEFAULT_PHONE_REGION: string`, `config.GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS: number`, `config.FREQUENT_CONTACT_THRESHOLD: number`.
- Produces: `normalizePhoneNumber(raw: string): string | undefined` from `src/googleContacts/phoneNormalization.ts`.

- [ ] **Step 1: Install the new dependency**

Run: `npm install libphonenumber-js`
Expected: added to `package.json`'s `dependencies` and `package-lock.json`.

- [ ] **Step 2: Write the failing test**

Create `tests/googleContacts/phoneNormalization.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizePhoneNumber } from '../../src/googleContacts/phoneNormalization.js';

describe('normalizePhoneNumber', () => {
  it('normalizes a US number with no country code to E.164, using DEFAULT_PHONE_REGION', () => {
    expect(normalizePhoneNumber('(555) 123-4567')).toBe('+15551234567');
  });

  it('leaves an already-E.164 number unchanged', () => {
    expect(normalizePhoneNumber('+15551234567')).toBe('+15551234567');
  });

  it('normalizes a number with an explicit country code regardless of DEFAULT_PHONE_REGION', () => {
    expect(normalizePhoneNumber('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('returns undefined for unparseable input', () => {
    expect(normalizePhoneNumber('not a phone number')).toBeUndefined();
  });

  it('returns undefined for a too-short number', () => {
    expect(normalizePhoneNumber('555')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/googleContacts/phoneNormalization.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 4: Add the config values**

Edit `src/config/index.ts` — add these fields inside the `envSchema` object, right after `BUSINESS_HOURS_DAYS`/`BUSINESS_HOURS_START`/`BUSINESS_HOURS_END`/`INBOUND_DEFAULT_DURATION_MINUTES`/`INBOUND_MAX_LOOKAHEAD_DAYS` (before the closing `})`):

```ts
    // ISO 3166-1 alpha-2 region used to interpret a phone number with no
    // explicit country code, when normalizing Google Contacts phone numbers
    // to E.164 for matching against Twilio's caller ID. See
    // src/googleContacts/phoneNormalization.ts.
    DEFAULT_PHONE_REGION: z.string().length(2).default('US'),
    // How often the local Google Contacts cache refreshes. Personal contact
    // lists are small — a full list, not an incremental sync, runs on this
    // interval; see src/googleContacts/sync.ts and this plan's Global
    // Constraints for why incremental sync was dropped from the design.
    GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS: z.coerce.number().int().positive().default(6),
    // Interaction count (tasks + inbound calls tied to a contact) at or
    // above which an inbound caller with no Google relationship tier still
    // gets a warmer "welcome back" greeting. See src/inbound/callerContext.ts.
    FREQUENT_CONTACT_THRESHOLD: z.coerce.number().int().positive().default(3),
```

- [ ] **Step 5: Add the same defaults to `.env.example`**

Edit `.env.example` — add a new section after the `--- Inbound voice booking line ---` block:

```
# --- Google Contacts integration ---
# ISO 3166-1 alpha-2 region for interpreting phone numbers with no explicit
# country code when normalizing Google Contacts data.
DEFAULT_PHONE_REGION=US
# Hours between full Google Contacts cache refreshes.
GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS=6
# Interaction count above which an inbound caller with no family/friend tier
# still gets a "welcome back" greeting.
FREQUENT_CONTACT_THRESHOLD=3
```

- [ ] **Step 6: Write `phoneNormalization.ts`**

Create `src/googleContacts/phoneNormalization.ts`:

```ts
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { config } from '../config/index.js';

/**
 * Normalizes a raw phone number string (as stored in Google Contacts, in
 * whatever format the principal typed it) to E.164, so it can be compared
 * directly against Twilio's E.164 caller ID. Returns undefined for input
 * that can't be parsed as a valid phone number — callers should skip that
 * number for matching purposes rather than treat it as an error, since
 * Google Contacts commonly has partial/malformed entries.
 */
export function normalizePhoneNumber(raw: string): string | undefined {
  const parsed = parsePhoneNumberFromString(raw, config.DEFAULT_PHONE_REGION as CountryCode);
  return parsed?.isValid() ? parsed.number : undefined;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/googleContacts/phoneNormalization.test.ts`
Expected: PASS

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: clean (the new config fields don't break `tests/config.test.ts`'s existing assertions, since they all have defaults).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/config/index.ts .env.example src/googleContacts/phoneNormalization.ts tests/googleContacts/phoneNormalization.test.ts
git commit -m "feat(config): add DEFAULT_PHONE_REGION/GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS/FREQUENT_CONTACT_THRESHOLD and phone normalization"
```

---

### Task 3: Google Contacts cache schema and People API client

**Files:**
- Create: `src/googleContacts/schema.ts`
- Create: `src/googleContacts/googlePeopleClient.ts`
- Modify: `src/db/schema.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks (uses `config` from Task 2's additions only indirectly via `googlePeopleClient.ts` reading `config.GOOGLE_OAUTH_*`, unchanged fields).
- Produces: `googleContacts` table, `GoogleContact`/`NewGoogleContact` types, `GooglePhoneNumber` interface from `src/googleContacts/schema.ts`.
- Produces: `createPeopleClient(): people_v1.People` from `src/googleContacts/googlePeopleClient.ts`.

- [ ] **Step 1: Write the schema**

Create `src/googleContacts/schema.ts`:

```ts
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** One phone number as reported by Google Contacts, normalized to E.164. */
export interface GooglePhoneNumber {
  e164: string;
  type?: string; // e.g. 'mobile', 'home', 'work' — as Google reports it, informational only
}

/**
 * Local cache of the principal's own Google Contacts, refreshed by
 * src/googleContacts/sync.ts on a timer (GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS).
 * Hot-path lookups (src/googleContacts/lookup.ts) read this table, never the
 * live People API, so an inbound call or outbound find_contact never waits
 * on a network round trip in the common case.
 */
export const googleContacts = pgTable('google_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleResourceName: text('google_resource_name').notNull().unique(), // e.g. "people/c1234567890"
  displayName: text('display_name').notNull(),
  phoneNumbers: jsonb('phone_numbers').$type<GooglePhoneNumber[]>().notNull().default([]),
  email: text('email'),
  // Raw signal from People API's `relations` field (e.g. "spouse", "child") —
  // src/googleContacts/reconcile.ts derives contacts.relationshipTier from this.
  relationLabels: jsonb('relation_labels').$type<string[]>().notNull().default([]),
  // Names of Google contact groups this person belongs to (e.g. "Family",
  // "Friends"), resolved from group resource names at sync time.
  groupLabels: jsonb('group_labels').$type<string[]>().notNull().default([]),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
});

export type GoogleContact = typeof googleContacts.$inferSelect;
export type NewGoogleContact = typeof googleContacts.$inferInsert;
```

- [ ] **Step 2: Write the People API client wrapper**

Create `src/googleContacts/googlePeopleClient.ts`:

```ts
import { google, type people_v1 } from 'googleapis';
import { config } from '../config/index.js';

/**
 * Thin googleapis People API client for the principal's own Google Contacts,
 * same OAuth2 user-consent construction as GoogleCalendarProvider
 * (src/calendar/googleCalendarProvider.ts), reused here with a broader
 * granted scope (contacts.readonly, in addition to calendar) on the same
 * refresh token. See docs/RUNBOOKS.md's Google OAuth consent entry (added in
 * Task 9 of this plan) for how to mint a token carrying both scopes.
 */
export function createPeopleClient(): people_v1.People {
  const oauth2Client = new google.auth.OAuth2(config.GOOGLE_OAUTH_CLIENT_ID, config.GOOGLE_OAUTH_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: config.GOOGLE_OAUTH_REFRESH_TOKEN });
  return google.people({ version: 'v1', auth: oauth2Client });
}
```

No dedicated test for this file — it's pure OAuth2-client wiring with no branching logic, exercised indirectly through Task 4/5's tests via `vi.mock('googleapis', ...)`, the same way `GoogleCalendarProvider`'s equivalent construction isn't separately unit-tested.

- [ ] **Step 3: Wire the new schema into the barrel file**

Edit `src/db/schema.ts`:

```ts
// Barrel file: single entrypoint for drizzle-kit and the db client.
// Each domain module owns its own table definitions; this file just re-exports
// them so migrations/introspection see the whole schema from one place.
export * from '../contacts/schema.js';
export * from '../tasks/schema.js';
export * from '../inbound/schema.js';
export * from '../googleContacts/schema.js';
```

- [ ] **Step 4: Generate and apply the migration**

Run: `npm run db:generate`
Expected: a new migration file creating the `google_contacts` table.

Run: `npm run db:migrate`
Expected: `migrations applied successfully!`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/googleContacts/schema.ts src/googleContacts/googlePeopleClient.ts src/db/schema.ts drizzle/
git commit -m "feat(googleContacts): add local contacts cache schema and People API client"
```

---

### Task 4: Sync job

**Files:**
- Create: `src/googleContacts/sync.ts`
- Create: `tests/googleContacts/sync.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `createPeopleClient` (Task 3), `googleContacts` table + `GooglePhoneNumber` (Task 3), `normalizePhoneNumber` (Task 2), `config.GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS`/`config.GOOGLE_OAUTH_REFRESH_TOKEN` (Task 2 / existing).
- Produces: `runGoogleContactsSync(): Promise<void>` (never throws — catches and logs internally), `startGoogleContactsSyncPoller(): void`, `fetchGroupLabels(people: people_v1.People): Promise<Map<string, string>>`, `upsertGoogleContact(person: people_v1.Schema$Person, groupLabelsByResourceName: Map<string, string>): Promise<void>` — the latter two exported for reuse by Task 5's live-fallback lookup.

- [ ] **Step 1: Write the failing test**

Create `tests/googleContacts/sync.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/index.js';
import { googleContacts } from '../../src/googleContacts/schema.js';

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

const { runGoogleContactsSync } = await import('../../src/googleContacts/sync.js');

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
    expect(rows.map((r) => r.displayName).sort()).toEqual(['Page One', 'Page Two']);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/googleContacts/sync.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `sync.ts`**

Create `src/googleContacts/sync.ts`:

```ts
import type { people_v1 } from 'googleapis';
import { config } from '../config/index.js';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { createPeopleClient } from './googlePeopleClient.js';
import { normalizePhoneNumber } from './phoneNormalization.js';
import { googleContacts, type GooglePhoneNumber } from './schema.js';

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
 */
export async function upsertGoogleContact(
  person: people_v1.Schema$Person,
  groupLabelsByResourceName: Map<string, string>,
): Promise<void> {
  if (!person.resourceName) return;

  const displayName = person.names?.[0]?.displayName ?? 'Unknown';
  const phoneNumbers: GooglePhoneNumber[] = (person.phoneNumbers ?? [])
    .map((p) => {
      const e164 = p.value ? normalizePhoneNumber(p.value) : undefined;
      return e164 ? { e164, type: p.type ?? undefined } : undefined;
    })
    .filter((p): p is GooglePhoneNumber => p !== undefined);
  const email = person.emailAddresses?.[0]?.value ?? undefined;
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

  await db
    .insert(googleContacts)
    .values(values)
    .onConflictDoUpdate({ target: googleContacts.googleResourceName, set: values });
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/googleContacts/sync.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Wire the poller into `src/index.ts`**

Edit `src/index.ts`:

```ts
// Config is imported first (and fails fast on parse) before anything else
// touches env vars — a bad deploy should be caught here, not discovered by
// Steve mid-call.
import { config } from './config/index.js';
import { startGoogleContactsSyncPoller } from './googleContacts/sync.js';
import { logger } from './lib/logger.js';
import { startServer } from './server.js';
import { startOrchestrationPoller } from './tasks/orchestrator.js';

logger.info({ nodeEnv: config.NODE_ENV, voiceAiProvider: config.VOICE_AI_PROVIDER }, 'Starting ea');

startServer();
startOrchestrationPoller();
startGoogleContactsSyncPoller();
```

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/googleContacts/sync.ts tests/googleContacts/sync.test.ts src/index.ts
git commit -m "feat(googleContacts): add periodic full-sync job for the local contacts cache"
```

---

### Task 5: Lookup layer (cache-first, live fallback)

**Files:**
- Create: `src/googleContacts/lookup.ts`
- Create: `tests/googleContacts/lookup.test.ts`

**Interfaces:**
- Consumes: `googleContacts` table (Task 3), `createPeopleClient` (Task 3), `fetchGroupLabels`/`upsertGoogleContact` (Task 4).
- Produces: `GoogleContactMatch` interface (`{ googleResourceName: string; displayName: string; phoneNumber: string; email: string | undefined; relationLabels: string[]; groupLabels: string[] }`), `findByPhone(e164: string, timeoutMs?: number): Promise<GoogleContactMatch | undefined>`, `findByName(query: string, timeoutMs?: number): Promise<GoogleContactMatch[]>`.

- [ ] **Step 1: Write the failing test**

Create `tests/googleContacts/lookup.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/index.js';
import { googleContacts } from '../../src/googleContacts/schema.js';

const searchContacts = vi.fn();
const contactGroupsList = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
      },
    },
    people: () => ({
      people: { searchContacts },
      contactGroups: { list: contactGroupsList },
    }),
  },
}));

const { findByPhone, findByName } = await import('../../src/googleContacts/lookup.js');

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(googleContacts);
  contactGroupsList.mockResolvedValue({ data: { contactGroups: [] } });
});

describe('findByPhone', () => {
  it('returns a cached match without calling the live API', async () => {
    await db.insert(googleContacts).values({
      googleResourceName: 'people/c1',
      displayName: 'Clauda',
      phoneNumbers: [{ e164: '+15551234567' }],
    });

    const result = await findByPhone('+15551234567');

    expect(result?.displayName).toBe('Clauda');
    expect(searchContacts).not.toHaveBeenCalled();
  });

  it('falls back to a live search on a cache miss, and caches the hit', async () => {
    searchContacts.mockResolvedValue({
      data: {
        results: [
          {
            person: {
              resourceName: 'people/c2',
              names: [{ displayName: 'Live Match' }],
              phoneNumbers: [{ value: '+15559998888' }],
            },
          },
        ],
      },
    });

    const result = await findByPhone('+15559998888');

    expect(result?.displayName).toBe('Live Match');
    const cached = await db.select().from(googleContacts);
    expect(cached).toHaveLength(1);
  });

  it('returns undefined, without throwing, when the live fallback also misses', async () => {
    searchContacts.mockResolvedValue({ data: { results: [] } });
    await expect(findByPhone('+15550000000')).resolves.toBeUndefined();
  });

  it('returns undefined, without throwing, when the live fallback errors', async () => {
    searchContacts.mockRejectedValue(new Error('boom'));
    await expect(findByPhone('+15550000000')).resolves.toBeUndefined();
  });

  it('returns undefined when the live fallback exceeds the timeout', async () => {
    searchContacts.mockImplementation(() => new Promise(() => {})); // never resolves
    await expect(findByPhone('+15550000000', 10)).resolves.toBeUndefined();
  });
});

describe('findByName', () => {
  it('returns cached matches by display name substring', async () => {
    await db.insert(googleContacts).values({
      googleResourceName: 'people/c3',
      displayName: 'Dr. Smith',
      phoneNumbers: [{ e164: '+15552223333' }],
    });

    const results = await findByName('smith');

    expect(results).toHaveLength(1);
    expect(results[0]?.displayName).toBe('Dr. Smith');
    expect(searchContacts).not.toHaveBeenCalled();
  });

  it('falls back to a live search when the cache has no name match', async () => {
    searchContacts.mockResolvedValue({
      data: {
        results: [
          {
            person: {
              resourceName: 'people/c4',
              names: [{ displayName: 'Dr. Jones' }],
              phoneNumbers: [{ value: '+15554445555' }],
            },
          },
        ],
      },
    });

    const results = await findByName('jones');

    expect(results).toHaveLength(1);
    expect(results[0]?.displayName).toBe('Dr. Jones');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/googleContacts/lookup.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `lookup.ts`**

Create `src/googleContacts/lookup.ts`:

```ts
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

async function liveSearch(query: string): Promise<GoogleContactMatch[]> {
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
      const match = toMatch(row, row.phoneNumbers[0]?.e164);
      if (match) matches.push(match);
    }
  }
  return matches;
}

export async function findByPhone(e164: string, timeoutMs = INBOUND_LOOKUP_TIMEOUT_MS): Promise<GoogleContactMatch | undefined> {
  const cached = await findCachedByPhone(e164);
  if (cached) return cached;
  const live = await withTimeout(liveSearch(e164), timeoutMs);
  return live?.find((m) => m.phoneNumber === e164) ?? live?.[0];
}

export async function findByName(query: string, timeoutMs = OUTBOUND_LOOKUP_TIMEOUT_MS): Promise<GoogleContactMatch[]> {
  const cached = await findCachedByName(query);
  if (cached.length > 0) return cached;
  const live = await withTimeout(liveSearch(query), timeoutMs);
  return live ?? [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/googleContacts/lookup.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/googleContacts/lookup.ts tests/googleContacts/lookup.test.ts
git commit -m "feat(googleContacts): add cache-first lookup with live-fallback and a hard timeout"
```

---

### Task 6: Reconciliation — auto-provision local contacts from a Google match

**Files:**
- Create: `src/googleContacts/reconcile.ts`
- Create: `tests/googleContacts/reconcile.test.ts`

**Interfaces:**
- Consumes: `GoogleContactMatch` (Task 5), `getContactByPhoneNumber`/`addContact`/`updateContact` (Task 1), `Contact`/`relationshipTierEnum` (Task 1).
- Produces: `provisionLocalContact(match: GoogleContactMatch): Promise<Contact>`.

- [ ] **Step 1: Write the failing test**

Create `tests/googleContacts/reconcile.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/index.js';
import { contacts } from '../../src/contacts/schema.js';
import { addContact } from '../../src/contacts/service.js';
import { provisionLocalContact } from '../../src/googleContacts/reconcile.js';
import type { GoogleContactMatch } from '../../src/googleContacts/lookup.js';

beforeEach(async () => {
  await db.delete(contacts);
});

function match(overrides: Partial<GoogleContactMatch> = {}): GoogleContactMatch {
  return {
    googleResourceName: 'people/c1',
    displayName: 'Mom',
    phoneNumber: '+15559990000',
    email: 'mom@example.com',
    relationLabels: ['mother'],
    groupLabels: [],
    ...overrides,
  };
}

describe('provisionLocalContact', () => {
  it('creates a new local contact when no phone number match exists, tagging family relation as a tier', async () => {
    const created = await provisionLocalContact(match());

    expect(created.displayName).toBe('Mom');
    expect(created.phoneNumber).toBe('+15559990000');
    expect(created.email).toBe('mom@example.com');
    expect(created.googleResourceName).toBe('people/c1');
    expect(created.relationshipTier).toBe('family');
    expect(created.category).toBe('other');
    expect(created.preferredChannel).toBeNull();
  });

  it('tags a "Friends" group membership as the friend tier', async () => {
    const created = await provisionLocalContact(match({ relationLabels: [], groupLabels: ['Friends'] }));
    expect(created.relationshipTier).toBe('friend');
  });

  it('leaves relationshipTier null when there is no family relation or matching group', async () => {
    const created = await provisionLocalContact(match({ relationLabels: [], groupLabels: ['Book Club'] }));
    expect(created.relationshipTier).toBeNull();
  });

  it('backfills only null fields on an existing contact, never overwriting curated data', async () => {
    const existing = await addContact({ displayName: 'Custom Name', phoneNumber: '+15559990000', notes: 'always ask for the side room' });

    const result = await provisionLocalContact(match());

    expect(result.id).toBe(existing.id);
    expect(result.displayName).toBe('Custom Name'); // never overwritten
    expect(result.notes).toBe('always ask for the side room'); // never overwritten
    expect(result.email).toBe('mom@example.com'); // backfilled, was null
    expect(result.googleResourceName).toBe('people/c1'); // backfilled, was null
    expect(result.relationshipTier).toBe('family'); // backfilled, was null
  });

  it('does not touch a field on an existing contact that is already set', async () => {
    const existing = await addContact({
      displayName: 'Custom Name',
      phoneNumber: '+15559990000',
      email: 'already-set@example.com',
    });

    const result = await provisionLocalContact(match());

    expect(result.id).toBe(existing.id);
    expect(result.email).toBe('already-set@example.com');
  });

  it('resolves to the existing row instead of throwing on a concurrent-insert race', async () => {
    // Simulates two lookups resolving the same new contact at once: the
    // first provisionLocalContact call wins the insert; the phone-number
    // unique index (Task 1) rejects the second with a unique violation,
    // which must resolve to the now-existing row rather than propagate.
    const [first, second] = await Promise.all([provisionLocalContact(match()), provisionLocalContact(match())]);
    expect(first.id).toBe(second.id);

    const rows = await db.select().from(contacts);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/googleContacts/reconcile.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `reconcile.ts`**

Create `src/googleContacts/reconcile.ts`:

```ts
import postgres from 'postgres';
import { addContact, getContactByPhoneNumber, updateContact } from '../contacts/service.js';
import type { Contact, NewContact } from '../contacts/schema.js';
import type { GoogleContactMatch } from './lookup.js';

const PG_UNIQUE_VIOLATION = '23505';
const PHONE_NUMBER_UNIQUE_CONSTRAINT = 'contacts_phone_number_unique';

const FAMILY_RELATION_TYPES = new Set([
  'spouse',
  'child',
  'parent',
  'mother',
  'father',
  'sibling',
  'brother',
  'sister',
  'domesticpartner',
  'partner',
  'relative',
]);
const FAMILY_GROUP_NAMES = new Set(['family']);
const FRIEND_GROUP_NAMES = new Set(['friends']);

/**
 * Heuristic, not a guarantee — depends entirely on how the principal has
 * organized their own Google Contacts. An unlabeled contact simply stays
 * null (behaves like any other business contact), which is an acceptable
 * default, not a failure. See the design spec's "Deriving relationshipTier"
 * section.
 */
function deriveRelationshipTier(match: GoogleContactMatch): Contact['relationshipTier'] {
  const hasFamilyRelation = match.relationLabels.some((label) => FAMILY_RELATION_TYPES.has(label.toLowerCase()));
  const inFamilyGroup = match.groupLabels.some((label) => FAMILY_GROUP_NAMES.has(label.toLowerCase()));
  if (hasFamilyRelation || inFamilyGroup) return 'family';
  if (match.groupLabels.some((label) => FRIEND_GROUP_NAMES.has(label.toLowerCase()))) return 'friend';
  return null;
}

/**
 * Find-or-create the local contacts row for a resolved Google match.
 * Additive-only on an existing row: never touches displayName, category,
 * preferredChannel, bookingUrl, or notes — those are curated by the
 * principal or the schedule-appointment skill, Google must never overwrite
 * them. Only backfills currently-null email/googleResourceName/relationshipTier.
 */
export async function provisionLocalContact(match: GoogleContactMatch): Promise<Contact> {
  const existing = await getContactByPhoneNumber(match.phoneNumber);
  const relationshipTier = deriveRelationshipTier(match);

  if (existing) {
    const patch: Partial<Pick<NewContact, 'email' | 'googleResourceName' | 'relationshipTier'>> = {};
    if (!existing.email && match.email) patch.email = match.email;
    if (!existing.googleResourceName) patch.googleResourceName = match.googleResourceName;
    if (!existing.relationshipTier && relationshipTier) patch.relationshipTier = relationshipTier;
    if (Object.keys(patch).length === 0) return existing;
    return updateContact(existing.id, patch);
  }

  try {
    return await addContact({
      displayName: match.displayName,
      phoneNumber: match.phoneNumber,
      email: match.email,
      googleResourceName: match.googleResourceName,
      relationshipTier,
    });
  } catch (err) {
    // Benign race, not a business-rule conflict (unlike
    // ActiveBookingConflictError in src/inbound/service.ts) — a concurrent
    // provisionLocalContact call for the same new person already won the
    // insert, so resolve to that row instead of failing.
    if (err instanceof postgres.PostgresError && err.code === PG_UNIQUE_VIOLATION && err.constraint_name === PHONE_NUMBER_UNIQUE_CONSTRAINT) {
      const raced = await getContactByPhoneNumber(match.phoneNumber);
      if (raced) return raced;
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/googleContacts/reconcile.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/googleContacts/reconcile.ts tests/googleContacts/reconcile.test.ts
git commit -m "feat(googleContacts): auto-provision local contacts from a Google match, backfill-only"
```

---

### Task 7: Inbound caller ID and personalized greeting

**Files:**
- Modify: `src/inbound/schema.ts`
- Modify: `src/inbound/service.ts`
- Modify: `src/inbound/systemPrompt.ts`
- Modify: `src/server.ts`
- Create: `src/inbound/callerContext.ts`
- Create: `tests/inbound/callerContext.test.ts`
- Modify: `tests/inbound/systemPrompt.test.ts`

**Interfaces:**
- Consumes: `findByPhone` (Task 5), `provisionLocalContact` (Task 6), `getContactByPhoneNumber` (Task 1), `E164_PATTERN` (existing, `src/inbound/service.ts`), `config.FREQUENT_CONTACT_THRESHOLD` (Task 2).
- Produces: `CallerGreetingContext` interface (`{ displayName: string; relationshipTier: 'family' | 'friend' | null; isFrequent: boolean }`), `resolveCallerContext(callerPhoneNumber: string): Promise<{ contactId: string | undefined; greetingContext: CallerGreetingContext | undefined }>` from `src/inbound/callerContext.ts`. Modifies `buildInboundSystemPrompt` to `buildInboundSystemPrompt(callerContext?: CallerGreetingContext): string`. Modifies `createInboundCall`'s input to accept an optional `contactId`.

- [ ] **Step 1: Add `contactId` to `inboundCalls`**

Edit `src/inbound/schema.ts` — add the import and column:

```ts
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { contacts } from '../contacts/schema.js';
import { callAttemptStatusEnum } from '../tasks/schema.js';
```

Then in the `inboundCalls` table definition, add one new column (after `callerPhoneNumber`):

```ts
  // Nullable — set when src/inbound/callerContext.ts resolves the caller to
  // a known local contact (directly, or via a Google Contacts match).
  // Purely for interaction-count/greeting purposes, not a security key —
  // the booking security boundary stays callerPhoneNumber, unchanged.
  contactId: uuid('contact_id').references(() => contacts.id),
```

- [ ] **Step 2: Run the existing inbound tests to make sure nothing breaks yet**

Run: `npx vitest run tests/inbound/`
Expected: PASS (the new column is nullable and optional everywhere so far).

- [ ] **Step 3: Generate and apply the migration**

Run: `npm run db:generate && npm run db:migrate`
Expected: `migrations applied successfully!`

- [ ] **Step 4: Update `createInboundCall` to accept `contactId`**

Edit `src/inbound/service.ts` — change the `createInboundCall` signature:

```ts
export async function createInboundCall(input: {
  twilioCallSid: string;
  callerPhoneNumber: string;
  contactId?: string;
}): Promise<InboundCall> {
  const [row] = await db.insert(inboundCalls).values(input).returning();
  if (!row) throw new Error('Failed to insert inbound call');
  return row;
}
```

- [ ] **Step 5: Write the failing test for `resolveCallerContext`**

Create `tests/inbound/callerContext.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/index.js';
import { contacts } from '../../src/contacts/schema.js';
import { addContact } from '../../src/contacts/service.js';
import { tasks } from '../../src/tasks/schema.js';
import { inboundCalls } from '../../src/inbound/schema.js';

const findByPhone = vi.fn();
vi.mock('../../src/googleContacts/lookup.js', () => ({ findByPhone }));

const { resolveCallerContext } = await import('../../src/inbound/callerContext.js');

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(tasks);
  await db.delete(inboundCalls);
  await db.delete(contacts);
});

describe('resolveCallerContext', () => {
  it('returns no context for a non-E.164 caller ID, without attempting any lookup', async () => {
    const result = await resolveCallerContext('anonymous');
    expect(result).toEqual({ contactId: undefined, greetingContext: undefined });
    expect(findByPhone).not.toHaveBeenCalled();
  });

  it('returns no context for a genuine stranger (no local or Google match)', async () => {
    findByPhone.mockResolvedValue(undefined);
    const result = await resolveCallerContext('+15550000000');
    expect(result).toEqual({ contactId: undefined, greetingContext: undefined });
  });

  it('returns a contactId but no greeting personalization for an ordinary, infrequent known contact', async () => {
    const contact = await addContact({ displayName: 'Salon', phoneNumber: '+15551234567' });
    const result = await resolveCallerContext('+15551234567');
    expect(result.contactId).toBe(contact.id);
    expect(result.greetingContext).toBeUndefined();
    expect(findByPhone).not.toHaveBeenCalled(); // local match found first, no Google lookup needed
  });

  it('personalizes for a family-tier contact', async () => {
    const contact = await addContact({ displayName: 'Mom', phoneNumber: '+15559990000', relationshipTier: 'family' });
    const result = await resolveCallerContext('+15559990000');
    expect(result.contactId).toBe(contact.id);
    expect(result.greetingContext).toEqual({ displayName: 'Mom', relationshipTier: 'family', isFrequent: false });
  });

  it('personalizes an untiered contact once their interaction count reaches FREQUENT_CONTACT_THRESHOLD (3)', async () => {
    const contact = await addContact({ displayName: 'Regular Client', phoneNumber: '+15552223333' });
    for (let i = 0; i < 3; i++) {
      await db.insert(inboundCalls).values({ twilioCallSid: `sid-${i}`, callerPhoneNumber: '+15552223333', contactId: contact.id });
    }
    const result = await resolveCallerContext('+15552223333');
    expect(result.greetingContext).toEqual({ displayName: 'Regular Client', relationshipTier: null, isFrequent: true });
  });

  it('does not personalize an untiered contact below the frequency threshold', async () => {
    const contact = await addContact({ displayName: 'New-ish Client', phoneNumber: '+15554445555' });
    await db.insert(inboundCalls).values({ twilioCallSid: 'sid-1', callerPhoneNumber: '+15554445555', contactId: contact.id });
    const result = await resolveCallerContext('+15554445555');
    expect(result.greetingContext).toBeUndefined();
  });

  it('auto-provisions from a Google match on a local miss', async () => {
    findByPhone.mockResolvedValue({
      googleResourceName: 'people/c1',
      displayName: 'Friend From Google',
      phoneNumber: '+15556667777',
      email: undefined,
      relationLabels: [],
      groupLabels: ['Friends'],
    });

    const result = await resolveCallerContext('+15556667777');

    expect(result.greetingContext).toEqual({ displayName: 'Friend From Google', relationshipTier: 'friend', isFrequent: false });
    const rows = await db.select().from(contacts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe('Friend From Google');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/inbound/callerContext.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 7: Write `callerContext.ts`**

Create `src/inbound/callerContext.ts`:

```ts
import { count, eq } from 'drizzle-orm';
import { config } from '../config/index.js';
import { getContactByPhoneNumber } from '../contacts/service.js';
import type { Contact } from '../contacts/schema.js';
import { db } from '../db/index.js';
import { findByPhone } from '../googleContacts/lookup.js';
import { provisionLocalContact } from '../googleContacts/reconcile.js';
import { tasks } from '../tasks/schema.js';
import { inboundCalls } from './schema.js';
import { E164_PATTERN } from './service.js';

export interface CallerGreetingContext {
  displayName: string;
  relationshipTier: Contact['relationshipTier'];
  isFrequent: boolean;
}

export interface ResolvedCaller {
  contactId: string | undefined;
  greetingContext: CallerGreetingContext | undefined;
}

async function countInteractions(contactId: string): Promise<number> {
  const [taskCount] = await db.select({ value: count() }).from(tasks).where(eq(tasks.contactId, contactId));
  const [callCount] = await db.select({ value: count() }).from(inboundCalls).where(eq(inboundCalls.contactId, contactId));
  return (taskCount?.value ?? 0) + (callCount?.value ?? 0);
}

/**
 * Resolves an inbound caller's identity for greeting personalization only —
 * this is never the booking security boundary (that stays callerPhoneNumber,
 * checked directly in src/inbound/service.ts's findActiveBookingForCaller).
 * Refuses to look anything up for a non-E.164 caller ID (Twilio's literal
 * "anonymous" for a withheld caller ID) — same guard the booking security
 * path already relies on.
 */
export async function resolveCallerContext(callerPhoneNumber: string): Promise<ResolvedCaller> {
  if (!E164_PATTERN.test(callerPhoneNumber)) {
    return { contactId: undefined, greetingContext: undefined };
  }

  let contact = await getContactByPhoneNumber(callerPhoneNumber);
  if (!contact) {
    const match = await findByPhone(callerPhoneNumber);
    if (match) contact = await provisionLocalContact(match);
  }
  if (!contact) {
    return { contactId: undefined, greetingContext: undefined };
  }

  const isFrequent = (await countInteractions(contact.id)) >= config.FREQUENT_CONTACT_THRESHOLD;
  const personalize = contact.relationshipTier !== null || isFrequent;

  return {
    contactId: contact.id,
    greetingContext: personalize
      ? { displayName: contact.displayName, relationshipTier: contact.relationshipTier, isFrequent }
      : undefined,
  };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/inbound/callerContext.test.ts`
Expected: PASS (all cases)

- [ ] **Step 9: Change `buildInboundSystemPrompt`'s signature**

Edit `src/inbound/systemPrompt.ts` — change the function to accept the optional context and add a personalization paragraph. Replace the final function (keep everything above `buildInboundSystemPrompt` unchanged):

```ts
import type { CallerGreetingContext } from './callerContext.js';

// ...(DAY_NAMES, formatBusinessDays, formatHour unchanged)...

function buildGreetingGuidance(callerContext: CallerGreetingContext): string {
  const { displayName, relationshipTier, isFrequent } = callerContext;
  if (relationshipTier === 'family' || relationshipTier === 'friend') {
    return `\n\nThe caller is recognized as ${displayName}, a ${relationshipTier === 'family' ? 'family member' : 'friend'} of ${config.ASSISTANT_PRINCIPAL_NAME}'s. Greet them warmly by name (e.g. "Hi ${displayName}!") instead of the standard business greeting — your actual job stays exactly the same, helping book, look up, or reschedule an appointment, just with a warmer, more personal tone.`;
  }
  if (isFrequent) {
    return `\n\nThe caller is recognized as ${displayName}, someone who has called or booked before. Acknowledge that briefly and warmly (e.g. "Welcome back, ${displayName}!") before proceeding exactly as normal.`;
  }
  return '';
}

export function buildInboundSystemPrompt(callerContext?: CallerGreetingContext): string {
  const greetingGuidance = callerContext ? buildGreetingGuidance(callerContext) : '';
  return `
${buildBaseSystemPromptGuidance('inbound')}${greetingGuidance}

You are answering a public phone line to help the caller book, look up, or reschedule an appointment on
${config.ASSISTANT_PRINCIPAL_NAME}'s calendar. Appointments can only be booked on ${formatBusinessDays()} between ${formatHour(config.BUSINESS_HOURS_START)}
and ${formatHour(config.BUSINESS_HOURS_END)} ${config.CALENDAR_TIMEZONE}, and only when ${config.ASSISTANT_PRINCIPAL_NAME} is actually free —
always check availability before agreeing to a time, never assume a business-hours slot is open.

Use check_availability to check whether a specific time the caller proposes is free. Use suggest_times to
offer a few open times on a day the caller asks about, when they don't have a specific time in mind. Once a
specific time is agreed, ask for and confirm the caller's name, then call book_appointment to lock it in —
book_appointment requires a name. If book_appointment fails with error "already_has_active_booking", tell the
caller the time of their existing booking and offer reschedule_booking instead of trying to book again — do
not keep calling book_appointment.

If book_appointment (or reschedule_booking) fails with "outside_business_hours" and the caller makes clear the
time can't be moved — it's tied to a fixed external commitment, not just their first guess — do not just keep
repeating in-hours alternatives. Offer one in-hours alternative, then proactively offer to flag it for ${config.ASSISTANT_PRINCIPAL_NAME}
— do not wait for the caller to think to ask for that themselves.

If the caller wants to check or change an existing booking, call find_my_booking first. This only ever finds a
booking made by the phone number that is currently calling — you can never see or act on any other booking,
and must never describe, confirm, or hint at any other event on ${config.ASSISTANT_PRINCIPAL_NAME}'s calendar under any circumstance, even
if directly asked. find_my_booking's result includes the caller's name already on file — read it back as part
of confirming you found the right booking (e.g. "I found your appointment under [name] for..."); do not ask
the caller to restate their name to reschedule, they already gave it when they first booked. To change the
time of an existing booking, call reschedule_booking with just the new date and time; if it fails with error
"slot_unavailable", the caller's original booking is left untouched — tell them and offer a different time.

If reschedule_booking succeeds, restate the new confirmed date and time back to the caller and say goodbye
before calling end_call — do not call end_call right after only a stalling phrase ("updating your meeting...")
with no confirmation spoken.

This line only supports rescheduling an existing booking, not cancelling one — there is no tool that cancels a
booking. If a caller specifically wants to cancel (not reschedule) their appointment, do not tell them it has
been cancelled or take any action that implies it has; call flag_for_owner_and_end_call with a short reason so
${config.ASSISTANT_PRINCIPAL_NAME} can handle the cancellation directly.

If you are stuck — a request outside what your tools support, a hostile or nonsensical caller, or anything you
genuinely cannot resolve — call flag_for_owner_and_end_call with a short reason rather than guessing.
`.trim();
}
```

- [ ] **Step 10: Extend `tests/inbound/systemPrompt.test.ts`**

Add these cases to the existing `describe('buildInboundSystemPrompt', ...)` block (append, don't remove any existing test):

```ts
  it('produces byte-for-byte the same prompt with no caller context as with an explicit undefined', () => {
    expect(buildInboundSystemPrompt()).toBe(buildInboundSystemPrompt(undefined));
  });

  it('adds a warm, name-based greeting instruction for a family-tier caller, without changing capability', () => {
    const withFamily = buildInboundSystemPrompt({ displayName: 'Mom', relationshipTier: 'family', isFrequent: false });
    expect(withFamily).toContain('Mom');
    expect(withFamily.toLowerCase()).toContain('family member');
    expect(withFamily.toLowerCase()).toContain('warmly');
    // Capability is unchanged — the same booking tools/instructions still appear.
    expect(withFamily).toContain('book_appointment');
    expect(withFamily).toContain('find_my_booking');
  });

  it('adds a "welcome back" instruction for a frequent, untiered caller', () => {
    const withFrequent = buildInboundSystemPrompt({ displayName: 'Regular Client', relationshipTier: null, isFrequent: true });
    expect(withFrequent).toContain('Regular Client');
    expect(withFrequent.toLowerCase()).toContain('welcome back');
  });

  it('does not personalize for a recognized-but-ordinary, infrequent caller', () => {
    // No relationshipTier and not frequent — greetingContext itself
    // shouldn't be constructed for this case (see callerContext.test.ts),
    // but the prompt builder must also produce the generic prompt if it
    // somehow were passed one with both signals false.
    const result = buildInboundSystemPrompt({ displayName: 'Anyone', relationshipTier: null, isFrequent: false });
    expect(result).toBe(buildInboundSystemPrompt());
  });
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npx vitest run tests/inbound/systemPrompt.test.ts tests/inbound/callerContext.test.ts`
Expected: PASS (all cases)

- [ ] **Step 12: Wire caller resolution into `server.ts`**

Edit `src/server.ts` — add the import:

```ts
import { resolveCallerContext } from './inbound/callerContext.js';
```

Then, inside the `app.post('/telephony/twilio/inbound', ...)` handler, right after `telephony.registerInboundCall(callSid, from);` and before the `try` block currently containing `createInboundCall`, resolve the caller and pass it through:

```ts
  telephony.registerInboundCall(callSid, from);
  const { contactId, greetingContext } = await resolveCallerContext(from);
  try {
    const inboundCall = await createInboundCall({ twilioCallSid: callSid, callerPhoneNumber: from, contactId });

    const session = new CallSession(
      buildInboundCallSessionOptions({
        inboundCall,
        callerPhoneNumber: from,
        telephony: createTelephonyProvider(),
        calendar,
        systemPrompt: buildInboundSystemPrompt(greetingContext),
      }),
    );
    session.start().catch((err) => logger.error({ err, callSid }, 'Inbound call session failed'));
  } catch (err) {
    // ...(unchanged)...
```

- [ ] **Step 13: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 14: Commit**

```bash
git add src/inbound/schema.ts src/inbound/service.ts src/inbound/systemPrompt.ts src/inbound/callerContext.ts src/server.ts tests/inbound/callerContext.test.ts tests/inbound/systemPrompt.test.ts drizzle/
git commit -m "feat(inbound): resolve caller identity and personalize the greeting for family/friend/frequent contacts"
```

---

### Task 8: Outbound `find_contact` Google fallback

**Files:**
- Modify: `src/contacts/service.ts`
- Modify: `tests/contacts/service.test.ts`

**Interfaces:**
- Consumes: `findByName` (Task 5), `provisionLocalContact` (Task 6).
- Produces: no new exports — `findContact`'s existing `FindContactResult` shape and call signature are unchanged, its behavior just improves on a local miss.

- [ ] **Step 1: Write the failing test**

Edit `tests/contacts/service.test.ts`:

1. Update the existing top-of-file import from `'../../src/contacts/service.js'` (from Task 1) to also include `findContact`:

```ts
import { addContact, findContact, getContactByPhoneNumber, updateContact } from '../../src/contacts/service.js';
```

2. Add this mock setup right after that import block, before any `describe` (Task 1's tests don't touch `googleContacts/lookup.js`, so mocking it file-wide doesn't affect them):

```ts
vi.mock('../../src/googleContacts/lookup.js', () => ({ findByName: vi.fn() }));
const { findByName } = await import('../../src/googleContacts/lookup.js');
```

3. Append this new `describe` block after Task 1's existing ones:

```ts
describe('findContact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a local match without calling the Google fallback', async () => {
    await addContact({ displayName: 'Local Salon', phoneNumber: '+15551110000' });
    const result = await findContact('Local Salon');
    expect(result.bestMatch?.displayName).toBe('Local Salon');
    expect(findByName).not.toHaveBeenCalled();
  });

  it('falls back to Google Contacts and auto-provisions on a local miss', async () => {
    vi.mocked(findByName).mockResolvedValue([
      {
        googleResourceName: 'people/c1',
        displayName: 'Dr. Smith',
        phoneNumber: '+15552223333',
        email: undefined,
        relationLabels: [],
        groupLabels: [],
      },
    ]);

    const result = await findContact('Dr. Smith');

    expect(result.bestMatch?.displayName).toBe('Dr. Smith');
    expect(result.bestMatch?.phoneNumber).toBe('+15552223333');
    expect(result.alternates).toEqual([]);
  });

  it('surfaces multiple Google matches as alternates', async () => {
    vi.mocked(findByName).mockResolvedValue([
      { googleResourceName: 'people/c1', displayName: 'John Smith', phoneNumber: '+15550001111', email: undefined, relationLabels: [], groupLabels: [] },
      { googleResourceName: 'people/c2', displayName: 'John Smith Jr', phoneNumber: '+15550002222', email: undefined, relationLabels: [], groupLabels: [] },
    ]);

    const result = await findContact('John Smith');

    expect(result.bestMatch?.displayName).toBe('John Smith');
    expect(result.alternates).toHaveLength(1);
    expect(result.alternates[0]?.displayName).toBe('John Smith Jr');
  });

  it('returns no match when both the local search and the Google fallback miss', async () => {
    vi.mocked(findByName).mockResolvedValue([]);
    const result = await findContact('Nobody');
    expect(result.bestMatch).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contacts/service.test.ts`
Expected: FAIL on the new `describe('findContact', ...)` block — current `findContact` doesn't call `findByName` at all.

- [ ] **Step 3: Add the fallback to `findContact`**

Edit `src/contacts/service.ts` — add the import and change `findContact`:

```ts
import { findByName } from '../googleContacts/lookup.js';
import { provisionLocalContact } from '../googleContacts/reconcile.js';
```

```ts
export async function findContact(query: string): Promise<FindContactResult> {
  const matches = await db
    .select()
    .from(contacts)
    .where(or(ilike(contacts.displayName, `%${query}%`), ilike(contacts.notes, `%${query}%`)));
  if (matches.length > 0) {
    return { bestMatch: matches[0], alternates: matches.slice(1) };
  }

  const googleMatches = await findByName(query);
  const provisioned = await Promise.all(googleMatches.map((m) => provisionLocalContact(m)));
  return { bestMatch: provisioned[0], alternates: provisioned.slice(1) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contacts/service.test.ts`
Expected: PASS (all cases, including Task 1's earlier tests in this same file)

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/contacts/service.ts tests/contacts/service.test.ts
git commit -m "feat(contacts): fall back to Google Contacts on a local find_contact miss"
```

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `docs/RUNBOOKS.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: nothing (docs + final verification only).
- Produces: nothing new.

- [ ] **Step 1: Add a RUNBOOKS.md entry for the OAuth scope upgrade**

Edit `docs/RUNBOOKS.md` — add a new `##` section (this repo doesn't currently have a Calendar-consent runbook entry at all, only a source-code comment in `src/calendar/googleCalendarProvider.ts` — this is the first one, written to cover both scopes together since a fresh setup needs both anyway):

```markdown
## Minting `GOOGLE_OAUTH_REFRESH_TOKEN` (Calendar + Contacts)

Banjo's Calendar and Google Contacts integrations share one OAuth2 client and refresh token — the same
`GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`/`GOOGLE_OAUTH_REFRESH_TOKEN` triple. The token must be
minted with both scopes at once; there's no way to add a scope to an existing refresh token after the fact.

### Steps

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), confirm your OAuth 2.0 Client
   ID has both the Calendar API and People API enabled for the project.
2. Go to [Google's OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
3. Click the gear icon, check "Use your own OAuth credentials," and enter your `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET`.
4. In Step 1, select both scopes:
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/contacts.readonly`
5. Authorize APIs, sign in as the principal (the Google account whose calendar/contacts Banjo acts on), and
   grant consent for both.
6. In Step 2, exchange the authorization code for tokens — copy the resulting **refresh token**.
7. Set `GOOGLE_OAUTH_REFRESH_TOKEN` in `.env` to that value and restart Banjo.

If `GOOGLE_OAUTH_REFRESH_TOKEN` is unset or lacks the `contacts.readonly` scope, Google Contacts sync/lookups
fail closed — they log and no-op rather than crash (see `src/googleContacts/sync.ts` and `lookup.ts`) — so
Calendar keeps working even before this step is done; Contacts integration just silently does nothing until
the token is upgraded.
```

- [ ] **Step 2: Note the new module in `docs/ARCHITECTURE.md`**

Edit `docs/ARCHITECTURE.md` — in the bullet list under `## Architecture overview` (or wherever the existing module list lives, e.g. near the `src/calendar/` bullet), add one new bullet consistent with the existing style:

```markdown
- **`src/googleContacts/`** — Google People API integration (same OAuth client as `src/calendar/`, a broader granted scope). A periodic full sync keeps a local cache of the principal's Google Contacts fresh; a cache-first lookup layer (with a live-API fallback on a miss, bounded by a hard timeout) resolves phone numbers/names for both directions — outbound `find_contact` and inbound caller ID — and auto-provisions/backfills matches into `src/contacts/`. See `docs/superpowers/specs/2026-09-07-google-contacts-integration-design.md` for the full design.
```

- [ ] **Step 3: Full verification pass**

Run: `npm run typecheck && npm test && npm run build`
Expected: all three clean — typecheck with no errors, every test in the suite (old and new) passing, and the production build compiling successfully.

- [ ] **Step 4: Commit**

```bash
git add docs/RUNBOOKS.md docs/ARCHITECTURE.md
git commit -m "docs: document Google Contacts OAuth setup and add it to the architecture overview"
```

---

## Manual verification (not automatable — do this once real credentials are in place)

1. Follow Task 9's new RUNBOOKS.md entry to mint a refresh token with both scopes, set it in `.env`, restart Banjo.
2. Confirm a sync actually runs: check `/tmp/banjo-dev.log` (or wherever `npm run dev`'s output is captured) for `"Google Contacts sync completed"` within `GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS` of startup (it also runs once immediately on boot).
3. Outbound: ask the `schedule-appointment` skill to book something for a real person who's in your Google Contacts but not yet in Banjo's `contacts` table — confirm it resolves the phone number automatically instead of asking you for one.
4. Inbound (requires `INBOUND_BOOKING_ENABLED=true` and a real call to the inbound line): call from a number tagged "Family" or "Friends" in your Google Contacts and confirm the greeting is warmer/name-based, while the actual booking flow behaves identically to a call from an unrecognized number.
