import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// DB-backed (banjo_test — see vitest.config.ts): which outbound calls a
// returning caller is told about (#129) is a query over tasks and call_attempts.
let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let recentOutboundCalls: typeof import('../../src/inbound/recentCalls.js').recentOutboundCalls;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  db = (await import('../../src/db/index.js')).db;
  contacts = (await import('../../src/contacts/schema.js')).contacts;
  ({ tasks, callAttempts } = await import('../../src/tasks/schema.js'));
  ({ recentOutboundCalls } = await import('../../src/inbound/recentCalls.js'));
});

async function clearTables() {
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
}

beforeEach(clearTables);
afterAll(clearTables);

const HOUR = 3_600_000;
const NOW = new Date('2026-10-24T18:00:00Z');

async function contactRow(phoneNumber = '+12025550101') {
  const [c] = await db.insert(contacts).values({ displayName: 'Gemma', phoneNumber }).returning();
  return c;
}

async function calledTask(contactId: string, hoursAgo: number, values: Record<string, unknown> = {}) {
  const [t] = await db
    .insert(tasks)
    .values({ contactId, channel: 'phone', mode: 'conversation', goalDescription: 'Tell Gemma about the show.', constraints: {}, status: 'voicemail_left', ...values })
    .returning();
  await db.insert(callAttempts).values({ taskId: t.id, status: 'ended', startedAt: new Date(NOW.getTime() - hoursAgo * HOUR) });
  return t;
}

describe('recentOutboundCalls (#129)', () => {
  it("returns that contact's calls dialed in the last 48 hours, newest first", async () => {
    const c = await contactRow();
    await calledTask(c.id, 30, { goalDescription: 'Older one.' });
    await calledTask(c.id, 2, { outcome: { kind: 'voicemail_left', message: 'Call me back!' } });
    await calledTask(c.id, 49, { goalDescription: 'Too old.' });

    const calls = await recentOutboundCalls(c.id, NOW);
    expect(calls.map((x) => x.goal)).toEqual(['Tell Gemma about the show.', 'Older one.']);
    expect(calls[0]).toMatchObject({ mode: 'conversation', status: 'voicemail_left', outcome: { kind: 'voicemail_left', message: 'Call me back!' } });
    expect(calls[0]!.calledAt).toEqual(new Date(NOW.getTime() - 2 * HOUR));
  });

  it("never returns another contact's calls, or a task that was never dialed", async () => {
    const c = await contactRow();
    const other = await contactRow('+12025550102');
    await calledTask(other.id, 1);
    await db.insert(tasks).values({ contactId: c.id, channel: 'phone', goalDescription: 'Not dialed yet.', constraints: {}, status: 'pending' });

    expect(await recentOutboundCalls(c.id, NOW)).toEqual([]);
  });

  it('returns at most 3, and one entry per task however many times it was dialed', async () => {
    const c = await contactRow();
    const t = await calledTask(c.id, 1);
    await db.insert(callAttempts).values({ taskId: t.id, status: 'ended', startedAt: new Date(NOW.getTime() - 3 * HOUR) });
    for (const h of [5, 6, 7]) await calledTask(c.id, h);

    const calls = await recentOutboundCalls(c.id, NOW);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((x) => x.taskId)).size).toBe(3);
    expect(calls[0]!.taskId).toBe(t.id);
  });
});
