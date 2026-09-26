import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTask, transitionTask, createCallAttempt, getContact, CallSession, logger, notifyTaskOutcome } = vi.hoisted(() => ({
  notifyTaskOutcome: vi.fn(async () => {}),
  getTask: vi.fn(),
  transitionTask: vi.fn(),
  createCallAttempt: vi.fn(),
  getContact: vi.fn(),
  CallSession: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/tasks/service.js', () => ({
  getTask,
  transitionTask,
  createCallAttempt,
  isTaskDue: () => true,
  listNonTerminalTasks: vi.fn(async () => []),
  listStartableTasks: vi.fn(async () => []),
  withContactAdvisoryLock: <T,>(_contactId: string, work: () => Promise<T>) => work(),
}));
vi.mock('../../src/contacts/service.js', () => ({ getContact }));
vi.mock('../../src/session/callSession.js', () => ({ CallSession }));
vi.mock('../../src/lib/logger.js', () => ({ logger }));
const { computeCandidateWindows } = vi.hoisted(() => ({ computeCandidateWindows: vi.fn(async () => []) }));
vi.mock('../../src/calendar/googleCalendarProvider.js', () => ({
  GoogleCalendarProvider: class {
    computeCandidateWindows = computeCandidateWindows;
  },
}));
vi.mock('../../src/telephony/factory.js', () => ({ createTelephonyProvider: vi.fn() }));
vi.mock('../../src/tasks/callSessionAdapter.js', () => ({ buildOutboundCallSessionOptions: vi.fn(), notifyTaskOutcome }));
vi.mock('../../src/tasks/promptBuilder.js', () => ({ buildCallSystemPrompt: vi.fn(), buildCallFrontendPrompt: vi.fn() }));
type CapResult = { allowed: boolean; placed: number; queued: number; nextAllowedAt?: Date };
const { checkCallCap } = vi.hoisted(() => ({
  checkCallCap: vi.fn(async (): Promise<CapResult> => ({ allowed: true, placed: 0, queued: 0 })),
}));
// The real per-contact lock; only the count is faked.
vi.mock('../../src/tasks/callCap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tasks/callCap.js')>()),
  checkCallCap,
}));

const { clipWindowsToFuture, triggerOrchestration } = await import('../../src/tasks/orchestrator.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('clipWindowsToFuture', () => {
  const now = new Date('2026-09-20T13:00:00.000Z');

  it('drops windows that are entirely over and starts a partly-past window at now', () => {
    expect(
      clipWindowsToFuture(
        [
          { start: '2026-09-13T13:00:00.000Z', end: '2026-09-16T13:00:00.000Z' },
          { start: '2026-09-19T13:00:00.000Z', end: '2026-09-21T13:00:00.000Z' },
          { start: '2026-09-22T13:00:00.000Z', end: '2026-09-23T13:00:00.000Z' },
        ],
        now,
      ),
    ).toEqual([
      { start: '2026-09-20T13:00:00.000Z', end: '2026-09-21T13:00:00.000Z' },
      { start: '2026-09-22T13:00:00.000Z', end: '2026-09-23T13:00:00.000Z' },
    ]);
  });
});

describe('triggerOrchestration: a cancel racing the start of a run', () => {
  it('does not place the call when the task was cancelled between the read and the first transition', async () => {
    getTask.mockResolvedValue({ id: 'task-1', channel: 'phone', status: 'pending', contactId: 'contact-1', constraints: {} });
    getContact.mockResolvedValue({ id: 'contact-1' });
    transitionTask.mockResolvedValue({ id: 'task-1', status: 'cancelled' });

    triggerOrchestration('task-1');
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }), expect.any(String)));

    expect(transitionTask).toHaveBeenCalledTimes(1);
    expect(createCallAttempt).not.toHaveBeenCalled();
    expect(CallSession).not.toHaveBeenCalled();
  });

  it('claims a pending task only from pending, and does not place the call when another process claimed it first', async () => {
    getTask.mockResolvedValue({ id: 'task-2', channel: 'phone', status: 'pending', contactId: 'contact-1', constraints: {} });
    getContact.mockResolvedValue({ id: 'contact-1' });
    transitionTask.mockResolvedValue(undefined); // the compare-and-set matched nothing

    triggerOrchestration('task-2');
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());

    expect(transitionTask).toHaveBeenCalledWith('task-2', 'checking_availability', undefined, { from: ['pending'] });
    expect(createCallAttempt).not.toHaveBeenCalled();
    expect(CallSession).not.toHaveBeenCalled();
  });
});

describe('a task whose requested times have all passed (#3)', () => {
  // clipWindowsToFuture returned [] and the call went ahead with no
  // pre-checked windows — so the model could book any free time at all.
  it('fails the task and notifies instead of placing an unconstrained call', async () => {
    getTask.mockResolvedValue({
      id: 'task-3',
      channel: 'phone',
      status: 'pending',
      contactId: 'contact-1',
      constraints: { dateWindows: [{ start: '2020-01-01T09:00:00-05:00', end: '2020-01-01T17:00:00-05:00' }] },
    });
    getContact.mockResolvedValue({ id: 'contact-1' });
    transitionTask.mockImplementation(async (id: string, status: string) => ({ id, status }));

    triggerOrchestration('task-3');
    await vi.waitFor(() => expect(notifyTaskOutcome).toHaveBeenCalledWith('task-3'));

    expect(transitionTask).toHaveBeenCalledWith(
      'task-3',
      'failed',
      expect.objectContaining({ outcome: expect.objectContaining({ kind: 'failed', reason: expect.stringMatching(/already passed/) }) }),
    );
    expect(createCallAttempt).not.toHaveBeenCalled();
    expect(CallSession).not.toHaveBeenCalled();
  });
});

describe('per-number call cap at dial time', () => {
  // place_call checks the cap when a call is requested; a call scheduled for
  // later is checked again here, right before it would dial.
  it('fails the task and notifies instead of dialing when the number is already at the cap', async () => {
    getTask.mockResolvedValue({ id: 'task-cap', channel: 'phone', status: 'pending', contactId: 'contact-1', constraints: {} });
    getContact.mockResolvedValue({ id: 'contact-1' });
    transitionTask.mockImplementation(async (id: string, status: string) => ({ id, status }));
    checkCallCap.mockResolvedValue({ allowed: false, placed: 3, queued: 0, nextAllowedAt: new Date('2026-09-27T01:23:44.000Z') });

    triggerOrchestration('task-cap');
    await vi.waitFor(() => expect(notifyTaskOutcome).toHaveBeenCalledWith('task-cap'));

    expect(checkCallCap).toHaveBeenCalledWith('contact-1', expect.any(Date));
    expect(transitionTask).toHaveBeenCalledWith(
      'task-cap',
      'failed',
      expect.objectContaining({ outcome: expect.objectContaining({ kind: 'failed', reason: expect.stringMatching(/call limit/i) }) }),
    );
    expect(createCallAttempt).not.toHaveBeenCalled();
    expect(CallSession).not.toHaveBeenCalled();
    // Refused before spending a calendar lookup on a call that won't be made.
    expect(computeCandidateWindows).not.toHaveBeenCalled();
    checkCallCap.mockReset();
    checkCallCap.mockResolvedValue({ allowed: true, placed: 0, queued: 0 });
  });

  it('lets only one of two due calls to the same number through when one slot is left', async () => {
    // Stateful: the count is what has been dialed so far, and dialing takes a
    // moment — without the per-contact lock both runs would see 2 and dial.
    let placed = 2;
    checkCallCap.mockImplementation(async () => ({ allowed: placed < 3, placed, queued: 0 }));
    createCallAttempt.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      placed += 1;
      return { id: `attempt-${placed}` };
    });
    getTask.mockImplementation(async (id: string) => ({ id, channel: 'phone', status: 'pending', contactId: 'contact-1', constraints: {} }));
    getContact.mockResolvedValue({ id: 'contact-1' });
    transitionTask.mockImplementation(async (id: string, status: string) => ({ id, status }));
    CallSession.mockImplementation(function () {
      return { start: async () => { throw new Error('stop here'); } };
    });

    triggerOrchestration('due-a');
    triggerOrchestration('due-b');
    await vi.waitFor(() => expect(notifyTaskOutcome).toHaveBeenCalledTimes(1));

    expect(createCallAttempt).toHaveBeenCalledTimes(1);
    expect(transitionTask).toHaveBeenCalledWith(expect.any(String), 'failed', expect.objectContaining({ outcome: expect.objectContaining({ reason: expect.stringMatching(/call limit/i) }) }));
    checkCallCap.mockReset();
    checkCallCap.mockResolvedValue({ allowed: true, placed: 0, queued: 0 });
    createCallAttempt.mockReset();
  });
});

describe('recording the call attempt fails after the task moved to calling', () => {
  it('fails the task instead of leaving it stuck in calling with no attempt', async () => {
    getTask.mockResolvedValue({ id: 'task-orphan', channel: 'phone', status: 'pending', contactId: 'contact-2', constraints: {} });
    getContact.mockResolvedValue({ id: 'contact-2' });
    transitionTask.mockImplementation(async (id: string, status: string) => ({ id, status }));
    createCallAttempt.mockRejectedValueOnce(new Error('db blip'));

    triggerOrchestration('task-orphan');
    await vi.waitFor(() => expect(notifyTaskOutcome).toHaveBeenCalledWith('task-orphan'));

    expect(transitionTask).toHaveBeenCalledWith('task-orphan', 'failed', expect.objectContaining({ outcome: expect.objectContaining({ kind: 'failed' }) }));
    expect(CallSession).not.toHaveBeenCalled();
  });
});
