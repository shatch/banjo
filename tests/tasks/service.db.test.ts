import { eq } from 'drizzle-orm';
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

describe('resuming a checking_availability task from two processes (#64)', () => {
  // A task left in checking_availability is resumed by any process that polls
  // it. Status alone can't tell two resumers apart, so each step is also
  // conditioned on the row being unchanged since the step before it wrote.
  async function checkingTask(phoneNumber: string) {
    const [contact] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber }).returning();
    const task = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Call', constraints: {} });
    return (await service.transitionTask(task.id, 'checking_availability', undefined, { from: ['pending'] }))!;
  }

  it('applies ifUpdatedAt only while the row is unchanged, including a row created with defaultNow()', async () => {
    const [contact] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber: '+15551230010' }).returning();
    // createTask's updatedAt comes from defaultNow(), stored to the microsecond.
    const fresh = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Call', constraints: {} });
    const claimed = await service.transitionTask(fresh.id, 'checking_availability', undefined, {
      from: ['pending'],
      ifUpdatedAt: fresh.updatedAt,
    });
    expect(claimed?.status).toBe('checking_availability');

    // The row has moved on since `fresh` was read, so the same guard now fails.
    const stale = await service.transitionTask(fresh.id, 'calling', undefined, {
      from: ['checking_availability'],
      ifUpdatedAt: fresh.updatedAt,
    });
    expect(stale).toBeUndefined();
    expect((await service.getTask(fresh.id))?.status).toBe('checking_availability');
  });

  it('advances updatedAt on every transition, even when the clock has not moved past the last write', async () => {
    // Deterministic version of the race below: a resume landing in the same
    // millisecond as the claim used to leave updatedAt unchanged, so a
    // second resume from the same read still matched.
    const task = await checkingTask('+15551230013');
    const ahead = new Date(Date.now() + 60 * 60 * 1000);
    await db.update(tasks).set({ updatedAt: ahead }).where(eq(tasks.id, task.id));
    const guard = { from: ['checking_availability' as const], ifUpdatedAt: ahead };

    const first = await service.transitionTask(task.id, 'checking_availability', undefined, guard);
    const second = await service.transitionTask(task.id, 'checking_availability', undefined, guard);

    expect(first!.updatedAt.getTime()).toBeGreaterThan(ahead.getTime());
    expect(second).toBeUndefined();
  });

  it('lets exactly one of two concurrent resumes win', async () => {
    const task = await checkingTask('+15551230011');
    const resume = () =>
      service.transitionTask(task.id, 'checking_availability', undefined, {
        from: ['checking_availability'],
        ifUpdatedAt: task.updatedAt,
      });

    const results = await Promise.all([resume(), resume()]);

    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });

  it('stops a process that was still working on the task once another resumes it, so only one dials', async () => {
    // Process A claimed the task and is still checking the calendar (no write
    // yet). Process B's poller resumes it. A must then fail to reach calling.
    const claimedByA = await checkingTask('+15551230012');
    await new Promise((r) => setTimeout(r, 5)); // so B's write gets a later timestamp
    const resumedByB = await service.transitionTask(claimedByA.id, 'checking_availability', undefined, {
      from: ['checking_availability'],
      ifUpdatedAt: claimedByA.updatedAt,
    });
    expect(resumedByB).toBeDefined();

    const aDials = await service.transitionTask(claimedByA.id, 'calling', undefined, {
      from: ['checking_availability'],
      ifUpdatedAt: claimedByA.updatedAt,
    });
    const bDials = await service.transitionTask(claimedByA.id, 'calling', undefined, {
      from: ['checking_availability'],
      ifUpdatedAt: resumedByB!.updatedAt,
    });

    expect(aDials).toBeUndefined();
    expect(bDials?.status).toBe('calling');
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

describe('counting calls to a contact, for the per-number call cap', () => {
  const now = new Date('2026-09-26T20:00:00.000Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

  it('lists the start times of call attempts to that contact since a time, oldest first', async () => {
    const [jess] = await db.insert(contacts).values({ displayName: 'Jess', phoneNumber: '+15551230010' }).returning();
    const [other] = await db.insert(contacts).values({ displayName: 'Other', phoneNumber: '+15551230011' }).returning();
    const call = async (contactId: string, startedAt: Date) => {
      const task = await service.createTask({ contactId, channel: 'phone', goalDescription: 'Call', constraints: {} });
      await db.insert(callAttempts).values({ taskId: task.id, startedAt });
    };
    await call(jess.id, hoursAgo(30)); // outside the 24h window
    await call(jess.id, hoursAgo(20));
    await call(jess.id, hoursAgo(2));
    await call(other.id, hoursAgo(1)); // someone else

    const recent = await service.callsPlacedToContactSince(jess.id, hoursAgo(24));
    expect(recent.map((d) => d.toISOString())).toEqual([hoursAgo(20).toISOString(), hoursAgo(2).toISOString()]); // oldest first
    expect(await service.callsPlacedToContactSince(other.id, hoursAgo(24))).toHaveLength(1);
  });

  it('counts queued calls that are due now and not yet dialed, but not future or finished ones', async () => {
    const [jess] = await db.insert(contacts).values({ displayName: 'Jess', phoneNumber: '+15551230012' }).returning();
    const make = (scheduledFor?: Date) =>
      service.createTask({ contactId: jess.id, channel: 'phone', goalDescription: 'Call', constraints: {}, scheduledFor });
    await make(); // pending, call now
    const claimed = await make();
    await service.transitionTask(claimed.id, 'checking_availability');
    await make(new Date(now.getTime() + 60 * 60 * 1000)); // scheduled later
    const done = await make();
    await service.transitionTask(done.id, 'failed', { outcome: { kind: 'failed', reason: 'x' } });

    expect(await service.dueQueuedCallsForContact(jess.id, now)).toBe(2);
  });
});

describe('withContactAdvisoryLock (per-number call cap across processes)', () => {
  it('lets only one holder per contact run at a time, even from separate connections', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = service.withContactAdvisoryLock('contact-a', async () => {
      order.push('first start');
      await new Promise<void>((r) => (release = r));
      order.push('first end');
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = service.withContactAdvisoryLock('contact-a', async () => {
      order.push('second');
    });
    const otherContact = service.withContactAdvisoryLock('contact-b', async () => {
      order.push('other contact');
    });
    await otherContact;
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(['first start', 'other contact']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'other contact', 'first end', 'second']);
  });
});

describe('saveCollectedAnswer (#148 review)', () => {
  async function askTask(phoneNumber: string) {
    const [contact] = await db.insert(contacts).values({ displayName: 'Groomer', phoneNumber }).returning();
    const task = await service.createTask({
      contactId: contact.id,
      channel: 'phone',
      goalDescription: 'Ask about Saturday',
      constraints: {},
      mode: 'ask',
      questions: ['Q1?', 'Q2?', 'Q3?'],
    });
    return service.transitionTask(task.id, 'negotiating');
  }

  it('saves answers by question number, a later one for the same number replacing the first, without touching status or outcome', async () => {
    const task = await askTask('+15551230101');

    expect(await service.saveCollectedAnswer(task.id, { question: 1, answered: true, answer: '5pm.' })).toBe(true);
    expect(await service.saveCollectedAnswer(task.id, { question: 2, answered: false })).toBe(true);
    expect(await service.saveCollectedAnswer(task.id, { question: 1, answered: true, answer: '6pm, sorry.' })).toBe(true);

    const row = await service.getTask(task.id);
    expect(row?.collectedAnswers).toEqual({
      '1': { question: 1, answered: true, answer: '6pm, sorry.' },
      '2': { question: 2, answered: false },
    });
    expect(row?.status).toBe('negotiating');
    expect(row?.outcome).toBeNull();
    // Not a transition: a resume's ifUpdatedAt compare-and-set (#64) must not see it as one.
    expect(row?.updatedAt.getTime()).toBe(task.updatedAt.getTime());
  });

  it('keeps every answer when several are saved at once', async () => {
    const task = await askTask('+15551230102');

    await Promise.all([
      service.saveCollectedAnswer(task.id, { question: 1, answered: true, answer: 'A.' }),
      service.saveCollectedAnswer(task.id, { question: 2, answered: true, answer: 'B.' }),
      service.saveCollectedAnswer(task.id, { question: 3, answered: false }),
    ]);

    expect(Object.keys((await service.getTask(task.id))?.collectedAnswers ?? {}).sort()).toEqual(['1', '2', '3']);
  });

  it("refuses a save once the task is answered, so its outcome and saved answers can't disagree (#148 review r2)", async () => {
    const task = await askTask('+15551230104');
    await service.transitionTask(task.id, 'answered', { outcome: { kind: 'answered', answers: [] } });

    expect(await service.saveCollectedAnswer(task.id, { question: 2, answered: true, answer: 'Late.' })).toBe(false);
    expect((await service.getTask(task.id))?.collectedAnswers).toBeNull();
  });

  it('still saves once the task has a terminal status, and reports a missing task', async () => {
    const task = await askTask('+15551230103');
    await service.transitionTask(task.id, 'escalated', { outcome: { kind: 'escalated', reason: 'x' } });

    expect(await service.saveCollectedAnswer(task.id, { question: 3, answered: true, answer: 'C.' })).toBe(true);
    expect((await service.getTask(task.id))?.collectedAnswers).toEqual({ '3': { question: 3, answered: true, answer: 'C.' } });
    expect(await service.saveCollectedAnswer('00000000-0000-0000-0000-000000000000', { question: 1, answered: false })).toBe(false);
  });
});

describe('call screening (#150)', () => {
  async function contactWith(phoneNumber: string) {
    const [contact] = await db.insert(contacts).values({ displayName: 'Robin', phoneNumber }).returning();
    return contact;
  }

  it('recentTasksForContact lists phone tasks to that contact since a time, newest first', async () => {
    const contact = await contactWith('+15551230301');
    const other = await contactWith('+15551230302');
    const old = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Old', constraints: {} });
    await db.update(tasks).set({ updatedAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(tasks.id, old.id));
    await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'First', constraints: {} });
    await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Second', constraints: {} });
    await service.createTask({ contactId: other.id, channel: 'phone', goalDescription: 'Elsewhere', constraints: {} });

    const recent = await service.recentTasksForContact(contact.id, new Date(Date.now() - 30 * 86_400_000));
    expect(recent.map((t: { goalDescription: string }) => t.goalDescription)).toEqual(['Second', 'First']);
  });

  it('holdForScreening makes a pending task wait for approval again, clearing an earlier approval', async () => {
    const contact = await contactWith('+15551230303');
    const task = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Later', constraints: {} });
    await db.update(tasks).set({ approvedAt: new Date() }).where(eq(tasks.id, task.id));
    const expiresAt = new Date(Date.now() + 30 * 60_000);

    const held = await service.holdForScreening(task.id, 'They asked not to be called again.', expiresAt);

    expect(held).toMatchObject({ status: 'pending', approvedAt: null, screenFlag: 'They asked not to be called again.', requestedByAgent: false });
    expect(held?.approvalExpiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it('holdForScreening leaves a task that is no longer pending alone', async () => {
    const contact = await contactWith('+15551230304');
    const task = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Gone', constraints: {} });
    await service.transitionTask(task.id, 'cancelled');

    expect(await service.holdForScreening(task.id, 'x', new Date())).toBeUndefined();
    expect((await service.getTask(task.id))?.screenFlag).toBeNull();
  });
});
