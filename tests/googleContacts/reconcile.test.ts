import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleContactMatch } from '../../src/googleContacts/lookup.js';

let db: any;
let contacts: any;
let addContact: any;
let provisionLocalContact: any;

// Set the real database URL and reload modules before any tests run — same
// convention as tests/contacts/service.test.ts and
// tests/googleContacts/lookup.test.ts.
beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  vi.resetModules();

  const dbModule = await import('../../src/db/index.js');
  const schemaModule = await import('../../src/contacts/schema.js');
  const serviceModule = await import('../../src/contacts/service.js');
  const reconcileModule = await import('../../src/googleContacts/reconcile.js');

  db = dbModule.db;
  contacts = schemaModule.contacts;
  addContact = serviceModule.addContact;
  provisionLocalContact = reconcileModule.provisionLocalContact;
});

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
    //
    // A naive Promise.all of two cold calls is NOT reliable here: postgres.js
    // lazily opens pool connections, and opening the second connection can
    // take longer than the first call's entire select-then-insert round
    // trip — so the second call's initial lookup would simply find the row
    // the first call already committed, taking the ordinary
    // already-exists/update path instead of ever hitting the unique-index
    // violation this test is meant to exercise. Pre-warming N pool
    // connections with real queries first (same table, same driver) removes
    // that connection-establishment skew so both calls' initial lookups are
    // genuinely racing against each other, not against a cold connection.
    const WARMUP_CONCURRENCY = 8;
    await Promise.all(Array.from({ length: WARMUP_CONCURRENCY }, () => db.select().from(contacts)));

    const results = await Promise.all(Array.from({ length: WARMUP_CONCURRENCY }, () => provisionLocalContact(match())));

    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1); // every call converged on the same row

    const rows = await db.select().from(contacts);
    expect(rows).toHaveLength(1);
  });

  it("resolves to the already-provisioned row instead of throwing when a Google contact's phone number changed", async () => {
    // The Google contact's number moved from +15551110000 to +15559990000, so
    // the google_contacts cache row now carries the new number while the local
    // contacts row still holds the old one plus this googleResourceName.
    // getContactByPhoneNumber(newNumber) misses, so this goes down the INSERT
    // branch, where addContact violates contacts_google_resource_name_unique —
    // which must resolve to the existing row, not propagate.
    const existing = await addContact({
      displayName: 'Mom',
      phoneNumber: '+15551110000',
      googleResourceName: 'people/c1',
      relationshipTier: 'family',
    });

    const result = await provisionLocalContact(match({ googleResourceName: 'people/c1', phoneNumber: '+15559990000' }));

    expect(result.id).toBe(existing.id);
    expect(result.phoneNumber).toBe('+15551110000'); // additive-only: never rewritten from Google
    const rows = await db.select().from(contacts);
    expect(rows).toHaveLength(1); // no duplicate row created
  });

  it("resolves to the already-linked row (not the stale one) when a phone-matched existing row's googleResourceName backfill races the same constraint", async () => {
    // Row B already holds this Google person's link under their OLD phone
    // number. Row A is a distinct local contact that happens to hold the
    // Google contact's NEW phone number (e.g. Steve added it manually
    // before the Google-side number change synced). getContactByPhoneNumber
    // finds row A (not B) via the new number, so this goes down the UPDATE
    // branch, where backfilling row A's googleResourceName collides with
    // row B's contacts_google_resource_name_unique — which must resolve to
    // B, the row actually linked to this Google person, not silently return
    // the unpatched row A.
    const rowB = await addContact({
      displayName: 'Mom (old number)',
      phoneNumber: '+15551110000',
      googleResourceName: 'people/c1',
      relationshipTier: 'family',
    });
    const rowA = await addContact({ displayName: 'Mom (new number)', phoneNumber: '+15559990000' });

    const result = await provisionLocalContact(match({ googleResourceName: 'people/c1', phoneNumber: '+15559990000' }));

    expect(result.id).toBe(rowB.id);
    expect(result.id).not.toBe(rowA.id);
  });

  it('backfills a genuinely empty-string email, not just a present one', async () => {
    const existing = await addContact({ displayName: 'Custom Name', phoneNumber: '+15559990000' });

    const result = await provisionLocalContact(match({ email: '' }));

    expect(result.id).toBe(existing.id);
    expect(result.email).toBe('');
  });
});
