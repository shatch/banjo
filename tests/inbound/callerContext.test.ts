import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const findByPhone = vi.fn();
vi.mock('../../src/googleContacts/lookup.js', () => ({ findByPhone }));

let db: any;
let contacts: any;
let tasks: any;
let inboundCalls: any;
let inboundBookings: any;
let addContact: any;
let resolveCallerContext: any;

// Set the real database URL and reload modules before any tests run — same
// convention as tests/contacts/service.test.ts and
// tests/googleContacts/reconcile.test.ts.
beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo';
  vi.resetModules();

  const dbModule = await import('../../src/db/index.js');
  const contactsSchemaModule = await import('../../src/contacts/schema.js');
  const tasksSchemaModule = await import('../../src/tasks/schema.js');
  const inboundSchemaModule = await import('../../src/inbound/schema.js');
  const contactsServiceModule = await import('../../src/contacts/service.js');
  const callerContextModule = await import('../../src/inbound/callerContext.js');

  db = dbModule.db;
  contacts = contactsSchemaModule.contacts;
  tasks = tasksSchemaModule.tasks;
  inboundCalls = inboundSchemaModule.inboundCalls;
  inboundBookings = inboundSchemaModule.inboundBookings;
  addContact = contactsServiceModule.addContact;
  resolveCallerContext = callerContextModule.resolveCallerContext;
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Delete in reverse dependency order (inboundBookings -> inboundCalls ->
  // tasks -> contacts) to satisfy FK constraints — same convention as
  // tests/contacts/service.test.ts. inboundBookings isn't touched by this
  // test's assertions, but the real dev DATABASE_URL this suite runs
  // against can carry leftover rows from manual/dev runs that FK-reference
  // inboundCalls, so it must be cleared first for `db.delete(inboundCalls)`
  // to succeed at all.
  await db.delete(inboundBookings);
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
