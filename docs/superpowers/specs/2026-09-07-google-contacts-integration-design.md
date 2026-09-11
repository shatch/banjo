# Google Contacts Integration — Design

## Context

Today, Banjo's own `contacts` table is the only source of contact identity, populated entirely by hand — the
`schedule-appointment` skill asks for a phone number and calls `add_contact` when `find_contact` misses, and
the inbound booking line (`src/inbound/`) has no concept of who's calling at all: `buildInboundSystemPrompt()`
takes no arguments, and its own doc comment states plainly that "every inbound call starts identically."

Two real gaps follow from that:

- **Outbound**, booking something for someone not already in Banjo's `contacts` table means manually supplying
  their phone number, even though it already exists in the principal's own Google Contacts (kept in sync with
  Apple/iCloud contacts).
- **Inbound**, a call or text from a known person — family, a friend, someone called many times before — is
  indistinguishable from a total stranger. There's no way to greet them differently.

This design adds Google Contacts (via the People API) as an identity-resolution and enrichment source for both
directions, and uses the result to personalize the inbound greeting for recognized personal/frequent contacts.
It does not add a new communication channel — the `contacts` schema is extended in a way that leaves room for
an email channel later, but no email sending/receiving is built here.

## Goal

- **Outbound:** `find_contact` resolves a real person from Google Contacts automatically on a local miss,
  instead of always falling through to "ask the principal for a phone number."
- **Inbound:** a recognized caller (by phone number, matched against Google Contacts or an already-known local
  contact) gets a warmer, name-based greeting when they're family/friends (per Google's own relation/group
  labels) or a frequent contact (per Banjo's own interaction history) — with **no change to capability**: the
  inbound line still only ever helps book, look up, or reschedule an appointment, for anyone.
- Every existing invariant stays intact: the inbound booking security boundary (a caller can only ever see/act
  on *their own* booking, matched strictly on E.164 phone number) is completely unaffected — this feature only
  ever adds personalization, never a new way to authorize access to someone else's data. An unresolved or
  anonymous caller gets the exact byte-for-byte prompt Banjo produces today.

## Architecture

One new module, `src/googleContacts/`, alongside `src/calendar/` — not a swappable `*Provider` interface like
`VoiceAIProvider`/`TelephonyProvider`/`CalendarProvider`, since there's only ever one real implementation here,
the same reasoning that keeps `GoogleCalendarProvider` a concrete class rather than an interface. It owns:

- A local sync cache of the principal's Google Contacts (kept fresh by a periodic job, not queried live on the
  hot path).
- A lookup layer (cache-first, live-API fallback on a miss) usable by both the inbound and outbound paths.
- A reconciliation step that auto-provisions/backfills rows in Banjo's own `contacts` table from a resolved
  Google match.

`src/contacts/schema.ts` and `src/inbound/systemPrompt.ts` get targeted extensions; no other subsystem changes
shape.

## Components

### 1. `contacts` schema changes (`src/contacts/schema.ts`)

```ts
export const relationshipTierEnum = pgEnum('relationship_tier', ['family', 'friend']);

export const contacts = pgTable('contacts', {
  // ...existing columns...
  email: text('email'), // nullable; enrichment only today, reserved for a future email channel
  googleResourceName: text('google_resource_name'), // e.g. "people/c1234567890"; nullable, unique when set
  relationshipTier: relationshipTierEnum('relationship_tier'), // null = ordinary/business contact
}, (table) => ({
  phoneNumberUnique: uniqueIndex('contacts_phone_number_unique').on(table.phoneNumber),
  googleResourceNameUnique: uniqueIndex('contacts_google_resource_name_unique').on(table.googleResourceName),
}));
```

The unique index on `phoneNumber` doesn't exist today and is a pre-existing gap this feature depends on — it's
the dedupe key reconciliation relies on to avoid double-provisioning the same person, and closing it now (while
already touching this table) is cheaper than leaving it for later.

### 2. `src/googleContacts/` — new module

- **`googlePeopleClient.ts`** — thin `googleapis` People API wrapper (`googleapis` is already a dependency, no
  new client library needed), constructed the same way `GoogleCalendarProvider` builds its OAuth2 client
  (`config.GOOGLE_OAUTH_CLIENT_ID`/`_CLIENT_SECRET`/`_REFRESH_TOKEN`).
- **`schema.ts`** — two new tables:
  - `google_contacts` (the synced cache): `googleResourceName` (unique), `displayName`, `phoneNumbers` (jsonb
    array, each normalized to E.164), `email`, `relationLabels`/`groupLabels` (jsonb), `etag`, `lastSyncedAt`.
  - `google_contacts_sync_state`: single-row bookkeeping — `syncToken` (nullable), `lastFullSyncAt`.
- **`sync.ts`** — periodic sync job, same `setInterval`/per-tick-error-logged idiom as
  `src/tasks/orchestrator.ts`'s poller, on a new `GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS` config value (default
  `6`). First run does a full `people.connections.list`; subsequent runs pass the stored `syncToken` for
  Google's incremental-sync mode. A `410 Gone` response (expired token, Google's documented behavior for this)
  is caught specifically and triggers a full resync with the token cleared.
- **`phoneNormalization.ts`** — normalizes raw Google phone strings to E.164 via a new `libphonenumber-js`
  dependency, using a new `DEFAULT_PHONE_REGION` config value as the fallback region for numbers stored without
  a country code. A number that fails to parse is skipped for matching purposes but the contact's other data is
  kept.
- **`lookup.ts`** — `findByPhone(e164)` and `findByName(query)`: check the local `google_contacts` cache first;
  on a miss, issue one live People API search (`searchContacts`/`otherContacts.search`) as a fallback, and
  cache the result if it hits. Both call sites get a hard timeout (Section "Error handling" below) so a slow
  or failed live lookup never blocks the caller.
- **`reconcile.ts`** — `provisionLocalContact(match)`: finds an existing `contacts` row by the matched phone
  number; if found, backfills only null fields (`googleResourceName`, `email`, `relationshipTier`) and never
  touches `displayName`, `category`, `preferredChannel`, `bookingUrl`, or `notes` — those are curated by the
  principal or the `schedule-appointment` skill and Google must never overwrite them. If no row exists, creates
  one: `displayName`/`phoneNumber`/`email`/`googleResourceName`/`relationshipTier` from the match, `category:
  'other'` (Google has no equivalent concept), `preferredChannel: null` (unchanged existing behavior — the
  skill still asks once on first real booking decision).

**Deriving `relationshipTier`** is a heuristic, not a guarantee: an explicit People API `relations` entry
(spouse/child/parent/etc.) or membership in a Google contact group literally named "Family" or "Friends" maps
to that tier. No match on either leaves the tier null — the contact behaves exactly like any other business
contact for greeting purposes. This depends entirely on how the principal has organized their own Google
Contacts; an unlabeled contact simply doesn't get the personal treatment, which is an acceptable, low-stakes
default rather than a failure mode.

### 3. Inbound greeting personalization

`src/server.ts` already extracts the caller's E.164 number (`from`) from the Twilio webhook before calling
`buildInboundSystemPrompt()` — the natural, and only, injection point. A new `resolveCallerContext(from)`
(in `src/inbound/`, since it's specifically about shaping the greeting, not a general-purpose primitive):

1. Returns nothing immediately for a non-E.164 caller ID (the existing `"anonymous"` withheld-ID case,
   reusing `E164_PATTERN` from `src/inbound/service.ts` as-is) — no lookup is ever attempted for it.
2. Looks up the local `contacts` table by exact phone number.
3. On a miss, calls `googleContacts/lookup.ts`'s `findByPhone` + `reconcile.ts`'s `provisionLocalContact` to
   auto-provision from a Google match.
4. If still nothing (a genuine stranger), returns nothing.
5. Otherwise computes `isFrequent` — an interaction count (`tasks` + `inbound_bookings` rows tied to this
   `contactId`) at or above a new `FREQUENT_CONTACT_THRESHOLD` config value (default `3`), computed live (a
   cheap `COUNT` query, not cached, since it changes over time) — and reads `relationshipTier`.

```ts
interface CallerGreetingContext {
  displayName: string;
  relationshipTier: 'family' | 'friend' | null;
  isFrequent: boolean;
}
```

`buildInboundSystemPrompt(callerContext?: CallerGreetingContext)`:

- **Absent** (unknown/anonymous caller, or a resolved-but-untiered-and-infrequent contact) — the prompt is
  **byte-for-byte identical to today's output**. No regression risk for the common case of a stranger calling
  in, and a merely-recognized-but-ordinary contact doesn't get special treatment just for existing in the
  system.
- **Present** (`relationshipTier` set, or `isFrequent` true) — a short paragraph is added instructing a warmer,
  name-based greeting (family/friend) or a "welcome back" acknowledgment (frequent, no tier). **Capability is
  unchanged in every case** — the inbound line still only ever helps book, look up, or reschedule an
  appointment; personalization affects tone and the greeting only, never what the assistant is able to do.

### 4. Outbound `find_contact` integration

`src/contacts/service.ts`'s `findContact(query)` gains a fallback: on a local search miss, it calls
`googleContacts/lookup.ts`'s `findByName` (cache-first, live fallback with a more generous ~5s timeout, since
this isn't the call-answering hot path), auto-provisioning via the same `reconcile.ts` path as inbound. Multiple
plausible Google matches surface as `alternates`, reusing `FindContactResult`'s existing shape and the skill's
existing "ask which one" behavior for multiple matches.

**The `schedule-appointment` skill needs no changes.** It already calls `find_contact` once and branches on
`found`/`alternates`; the tool just quietly answers more often, with no new skill logic required.

## Error handling

Fail-closed on every hot path: a live-fallback lookup timing out, erroring, or hitting an insufficient-scope or
rate-limit response must never block answering an inbound call or delay the outbound `find_contact` response —
it resolves to "no match," falling through to existing behavior exactly as if this feature didn't exist. The
sync job follows the orchestrator poller's exact idiom: per-tick errors are logged, never thrown, never crash
the process — a failed sync just leaves the cache stale until the next tick.

Specific cases:

- **`syncToken` invalidation** (`410`) → caught specifically, falls back to a full re-list, resets the stored
  token.
- **Unparseable phone numbers** → skipped for matching, rest of the contact's data kept.
- **Concurrent auto-provision race** (inbound and outbound resolving the same new contact at once) — the new
  unique index on `contacts.phoneNumber` is the actual backstop, mirroring `inbound_bookings_one_active_per_caller`'s
  role in `src/inbound/schema.ts`. A unique-violation on insert is caught and resolved by re-selecting the
  now-existing row, same idiom as `ActiveBookingConflictError` in `src/inbound/service.ts` — silent here, since
  it's a benign race, not a business-rule conflict.
- **Reconciliation is an explicit whitelist of backfill-only fields, never a blanket update** — a bug here
  can't silently overwrite curated data.
- **Live-lookup timeouts**: inbound uses a hard ~1.5–2s budget (protecting call-answering latency); outbound
  uses a more generous ~5s budget (a normal MCP tool call, not latency-critical in the same way).
- **OAuth re-consent** for the new `contacts.readonly` scope is an operational step — the existing Calendar
  refresh token doesn't carry it — documented as a new `RUNBOOKS.md` entry mirroring the existing Calendar
  consent note, not a code path.

## Testing

Following the repo's existing conventions — tests mirror `src/`, mocking at the interface boundary rather than
the `googleapis` SDK's wire format directly:

- `tests/googleContacts/`: client request-shape (fields requested, `syncToken` usage); sync (full vs.
  incremental branching, `410` → full-resync fallback, per-tick error containment doesn't stop future ticks);
  lookup (cache-hit skips the live call; cache-miss-then-hit caches the result; miss/timeout returns `undefined`
  without throwing); reconcile (new-contact creation, backfill-only-nulls — asserting `displayName`/`category`/
  `preferredChannel`/`bookingUrl`/`notes` are never overwritten on an existing row —, and the unique-violation
  race resolving to the existing row instead of throwing).
- Extend `tests/inbound/systemPrompt.test.ts`: prompt is byte-identical when no caller context is passed;
  personalization text appears only when `relationshipTier` is set or `isFrequent` is true, not merely when a
  contact resolves.
- Extend `tests/contacts/service.test.ts`: Google fallback only fires on a local miss; multiple Google matches
  surface as `alternates`.
- Inbound webhook route test: an `"anonymous"` caller never triggers a lookup; a lookup failure/timeout still
  returns a normal (generic-prompt) response rather than failing the webhook.

## Out of scope

- An actual email communication channel — this design only reserves a nullable `email` field on `contacts` so
  one can be added later without a schema rewrite. No sending/receiving is built here.
- Any change to inbound call *capability* for recognized personal contacts — tone/greeting only, per explicit
  decision during design; the booking-only toolset is unchanged for everyone.
- Two-way SMS (tracked separately in `docs/COMPETITIVE_LANDSCAPE.md`'s feature roadmap) — independent of this
  work, though the phone-number-based lookup primitive built here (`googleContacts/lookup.ts`) is directly
  reusable by that feature's inbound SMS webhook when it's built.
