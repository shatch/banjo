import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// DB-backed (banjo_test — see vitest.config.ts): what these guarantee is what
// Postgres ends up saying under concurrent writers, which a mocked db can't show.
// tests/tasks/service.test.ts covers the same module with a mocked db.
let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let service: typeof import('../../src/tasks/service.js');

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  db = (await import('../../src/db/index.js')).db;
  contacts = (await import('../../src/contacts/schema.js')).contacts;
  ({ tasks, callAttempts } = await import('../../src/tasks/schema.js'));
  service = await import('../../src/tasks/service.js');
});

async function clearTables() {
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
}

beforeEach(clearTables);
afterAll(clearTables);

describe('cancelPendingTask', () => {
  it('cancels a task that has not started, and leaves one already on a call alone', async () => {
    const [contact] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber: '+15551230001' }).returning();
    const scheduled = await service.createTask({
      contactId: contact.id,
      channel: 'phone',
      goalDescription: 'Call later',
      constraints: {},
      scheduledFor: new Date('2099-01-01T14:00:00.000Z'),
    });
    const live = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Call now', constraints: {} });
    await service.transitionTask(live.id, 'calling');

    expect((await service.cancelPendingTask(scheduled.id))?.status).toBe('cancelled');
    expect((await service.cancelPendingTask(live.id))?.status).toBe('calling');
    expect(await service.cancelPendingTask('00000000-0000-0000-0000-000000000000')).toBeUndefined();

    // A cancelled task is terminal: the orchestrator's first transition can't revive it.
    expect((await service.transitionTask(scheduled.id, 'checking_availability')).status).toBe('cancelled');
    expect((await service.listNonTerminalTasks()).map((t) => t.id)).toEqual([live.id]);
  });
});

describe('claiming a pending task (transitionTask with from)', () => {
  it('lets exactly one of two concurrent claims win — two pollers must not both place a scheduled call', async () => {
    const [contact] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber: '+15551230002' }).returning();
    const task = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Call later', constraints: {} });

    const claims = await Promise.all([
      service.transitionTask(task.id, 'checking_availability', undefined, { from: ['pending'] }),
      service.transitionTask(task.id, 'checking_availability', undefined, { from: ['pending'] }),
    ]);

    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect((await service.getTask(task.id))?.status).toBe('checking_availability');
  });
});

describe('listStartableTasks (#3)', () => {
  // The poller used to load every non-terminal task each 15s tick and filter
  // in memory, including calls in progress and ones scheduled for next week.
  it('returns only tasks that can start now: pending or checking_availability, and due', async () => {
    const [contact] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber: '+15551230003' }).returning();
    const now = new Date('2026-09-24T15:00:00.000Z');
    const make = (goalDescription: string, scheduledFor?: Date) =>
      service.createTask({ contactId: contact.id, channel: 'phone', goalDescription, constraints: {}, scheduledFor });

    const asap = await make('now');
    const due = await make('due', new Date('2026-09-24T14:59:00.000Z'));
    await make('later', new Date('2026-09-24T16:00:00.000Z'));
    const resuming = await make('resume after restart');
    await service.transitionTask(resuming.id, 'checking_availability');
    const onCall = await make('on a call');
    await service.transitionTask(onCall.id, 'calling');

    const ids = (await service.listStartableTasks(now)).map((t) => t.id).sort();
    expect(ids).toEqual([asap.id, due.id, resuming.id].sort());
  });
});

describe('recordTransferResult (#7)', () => {
  it("records the dial result on the call attempt, and ignores ids that aren't call attempts", async () => {
    const [contact] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber: '+15551230004' }).returning();
    const task = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Call', constraints: {} });
    const attempt = await service.createCallAttempt(task.id);

    expect(await service.recordTransferResult(attempt.id, 'no_answer')).toBe(true);
    expect((await service.latestCallAttemptFor(task.id))?.transferResult).toBe('no_answer');

    // An inbound call's id is a Twilio CallSid, not a UUID: no query, no throw.
    expect(await service.recordTransferResult('CA0123456789abcdef', 'answered')).toBe(false);
    // A UUID that matches nothing.
    expect(await service.recordTransferResult('00000000-0000-0000-0000-000000000000', 'answered')).toBe(false);
  });

  it("'transferred' is a terminal status", async () => {
    expect(service.isTerminalStatus('transferred')).toBe(true);
  });
});
