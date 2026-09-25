import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProvider, CreateEventResult } from '../../src/calendar/types.js';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';

// DB-backed (banjo_test — see vitest.config.ts): the race below is about what
// Postgres ends up saying, so it runs the real transitionTask guard, the real
// end-of-call adapter, and the real confirm_appointment handler together.
const { sendOwnerMessage } = vi.hoisted(() => ({ sendOwnerMessage: vi.fn(async () => {}) }));
vi.mock('../../src/notifications/owner.js', () => ({ sendOwnerMessage }));

let db: any;
let contacts: any;
let tasks: any;
let callAttempts: any;
let service: typeof import('../../src/tasks/service.js');
let buildOutboundCallSessionOptions: typeof import('../../src/tasks/callSessionAdapter.js').buildOutboundCallSessionOptions;
let confirmAppointmentTool: typeof import('../../src/voice/tools/callTools.js').confirmAppointmentTool;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
  db = (await import('../../src/db/index.js')).db;
  contacts = (await import('../../src/contacts/schema.js')).contacts;
  ({ tasks, callAttempts } = await import('../../src/tasks/schema.js'));
  service = await import('../../src/tasks/service.js');
  ({ buildOutboundCallSessionOptions } = await import('../../src/tasks/callSessionAdapter.js'));
  ({ confirmAppointmentTool } = await import('../../src/voice/tools/callTools.js'));
});

async function clearTables() {
  await db.delete(callAttempts);
  await db.delete(tasks);
  await db.delete(contacts);
}

beforeEach(clearTables);
// Leave the shared banjo_test database as this file found it: other suites
// (e.g. tests/googleContacts/reconcile.test.ts) only clear `contacts` in their
// own setup, and a task left behind here makes that delete fail on its
// foreign key — failing every test in whichever file runs next.
afterAll(clearTables);

const telephony: TelephonyProvider = {
  name: 'fake-telephony',
  nativeAudioFormat: 'g711_ulaw_8k',
  originateCall: vi.fn(async () => ({ providerCallId: 'CA-fake-sid' })),
  sendAudio: vi.fn(),
  sendDigits: vi.fn(async () => {}),
  interrupt: vi.fn(),
  hangUp: vi.fn(async () => {}),
  on: vi.fn(),
  off: vi.fn(),
};

/** A calendar whose event write stays in flight until the test finishes it. */
function calendarWithPendingWrite() {
  let finishWrite!: () => void;
  const calendar: CalendarProvider = {
    computeCandidateWindows: vi.fn(async () => []),
    isFree: vi.fn(async () => true),
    createEventIdempotent: vi.fn(
      () =>
        new Promise<CreateEventResult>((resolve) => {
          finishWrite = () =>
            resolve({ eventId: 'evt-race', confirmedStart: '2026-09-15T18:00:00.000Z', confirmedEnd: '2026-09-15T18:30:00.000Z' });
        }),
    ),
    findEventByIdempotencyKey: vi.fn(async () => undefined),
    deleteEvent: vi.fn(async () => {}),
  };
  return { calendar, finishWrite: () => finishWrite() };
}

async function startNegotiatingCall(calendar: CalendarProvider) {
  const [contact] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber: '+15551230000' }).returning();
  const created = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Book a haircut', constraints: {} });
  const task = await service.transitionTask(created.id, 'negotiating');
  const callAttempt = await service.createCallAttempt(task.id);
  const options = buildOutboundCallSessionOptions({ task, callAttempt, contact, telephony, calendar, systemPrompt: 'irrelevant' });
  return { task, options };
}

describe('booking vs. hang-up race', () => {
  it('a booking that finishes after the call was already recorded as failed leaves the record alone and texts a correction (#3)', async () => {
    // CallSession's end()/fail() wait for a running confirm_appointment within
    // its budget (tests/session/callSession.test.ts), so this only happens if
    // the write outlasts that. The task used to flip failed -> confirmed after
    // the failure had been texted; now the record stays as notified and the
    // owner is told the booking may be real.
    const { calendar, finishWrite } = calendarWithPendingWrite();
    const { task, options } = await startNegotiatingCall(calendar);

    const confirming = confirmAppointmentTool.handler(
      { confirmedStart: '2026-09-15T14:00:00', durationMinutes: 30, summary: 'Haircut with Clauda' },
      await options.buildToolContext(Date.now()),
    );
    await vi.waitFor(() => expect(calendar.createEventIdempotent).toHaveBeenCalled());

    await options.onStatusChange({ kind: 'ended', reason: 'callee hung up', disclosure: 'disclosed' });
    expect((await service.getTask(task.id))?.status).toBe('failed');

    finishWrite();
    await confirming;
    expect((await service.getTask(task.id))?.status).toBe('failed');
    expect(sendOwnerMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^Correction: Banjo put "Haircut with Clauda" on your calendar for Tuesday, September 15 at 2:00 PM/),
      { urgent: true },
    );
  });

  it("refuses to book on a task that's already over, without writing a calendar event (#3)", async () => {
    // The event used to be written first and the refusal only discovered at
    // the status write — an orphaned event, recorded nowhere but a log line.
    const { calendar } = calendarWithPendingWrite();
    const { task, options } = await startNegotiatingCall(calendar);
    await service.transitionTask(task.id, 'failed', { outcome: { kind: 'failed', reason: 'callee hung up' } });

    const result = await confirmAppointmentTool.handler(
      { confirmedStart: '2026-09-15T14:00:00', durationMinutes: 30 },
      await options.buildToolContext(Date.now()),
    );
    expect(result).toMatchObject({ ok: false, error: 'call_already_ended' });
    expect(calendar.createEventIdempotent).not.toHaveBeenCalled();
  });

  it('once confirmed, a later call end or conversation outcome leaves the booking untouched', async () => {
    const { calendar, finishWrite } = calendarWithPendingWrite();
    const { task, options } = await startNegotiatingCall(calendar);
    const confirming = confirmAppointmentTool.handler(
      { confirmedStart: '2026-09-15T14:00:00', durationMinutes: 30 },
      await options.buildToolContext(Date.now()),
    );
    await vi.waitFor(() => expect(calendar.createEventIdempotent).toHaveBeenCalled());
    finishWrite();
    await confirming;

    await options.onStatusChange({ kind: 'ended', reason: 'callee hung up', disclosure: 'disclosed' });
    await service.transitionTask(task.id, 'conversation_completed', { outcome: { kind: 'conversation_completed', summary: 'late' } });
    await service.transitionTask(task.id, 'failed', { outcome: { kind: 'failed', reason: 'late' } });

    expect(await service.getTask(task.id)).toMatchObject({ status: 'confirmed', outcome: { kind: 'confirmed' } });
  });
});
