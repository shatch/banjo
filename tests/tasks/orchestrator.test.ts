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
  expireApprovalRequests: vi.fn(async () => []),
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

    expect(transitionTask).toHaveBeenCalledWith('task-2', 'checking_availability', undefined, { from: ['pending'], notAwaitingApproval: true });
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
      expect.objectContaining({ from: ['checking_availability'] }),
    );
    expect(createCallAttempt).not.toHaveBeenCalled();
    expect(CallSession).not.toHaveBeenCalled();
  });
});

describe("an ask task's date windows (#148)", () => {
  // An ask call books nothing, so neither its date windows nor the calendar
  // apply. It used to fail as "every time requested had passed".
  it('dials without checking windows or the calendar, even when every window is over', async () => {
    getTask.mockResolvedValue({
      id: 'task-ask',
      channel: 'phone',
      status: 'pending',
      mode: 'ask',
      contactId: 'contact-1',
      constraints: { dateWindows: [{ start: '2020-01-01T09:00:00-05:00', end: '2020-01-01T17:00:00-05:00' }] },
    });
    getContact.mockResolvedValue({ id: 'contact-1' });
    transitionTask.mockImplementation(async (id: string, status: string) => ({ id, status }));

    triggerOrchestration('task-ask');
    await vi.waitFor(() => expect(createCallAttempt).toHaveBeenCalledWith('task-ask'));

    expect(transitionTask).not.toHaveBeenCalledWith('task-ask', 'failed', expect.anything(), expect.anything());
    expect(computeCandidateWindows).not.toHaveBeenCalled();
    expect(transitionTask).toHaveBeenCalledWith('task-ask', 'calling', { candidateWindows: [] }, expect.anything());
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

    expect(checkCallCap).toHaveBeenCalledWith('contact-1', expect.any(Date), { limit: 3 });
    expect(transitionTask).toHaveBeenCalledWith(
      'task-cap',
      'failed',
      expect.objectContaining({ outcome: expect.objectContaining({ kind: 'failed', reason: expect.stringMatching(/call limit/i) }) }),
      expect.objectContaining({ from: ['checking_availability'] }),
    );
    expect(createCallAttempt).not.toHaveBeenCalled();
    expect(CallSession).not.toHaveBeenCalled();
    // Refused before spending a calendar lookup on a call that won't be made.
    expect(computeCandidateWindows).not.toHaveBeenCalled();
    checkCallCap.mockReset();
    checkCallCap.mockResolvedValue({ allowed: true, placed: 0, queued: 0 });
  });

  it('checks a task the owner overrode against twice the cap, early and at dialing', async () => {
    getTask.mockResolvedValue({ id: 'task-over', channel: 'phone', status: 'pending', contactId: 'contact-1', constraints: {}, callCapOverride: true });
    getContact.mockResolvedValue({ id: 'contact-1' });
    transitionTask.mockImplementation(async (id: string, status: string) => ({ id, status }));
    checkCallCap.mockResolvedValue({ allowed: false, placed: 6, queued: 0 });

    triggerOrchestration('task-over');
    await vi.waitFor(() => expect(notifyTaskOutcome).toHaveBeenCalledWith('task-over'));

    expect(checkCallCap).toHaveBeenCalledWith('contact-1', expect.any(Date), { limit: 6 });
    expect(createCallAttempt).not.toHaveBeenCalled();
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
    expect(transitionTask).toHaveBeenCalledWith(expect.any(String), 'failed', expect.objectContaining({ outcome: expect.objectContaining({ reason: expect.stringMatching(/call limit/i) }) }), expect.objectContaining({ from: ['checking_availability'] }));
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

    expect(transitionTask).toHaveBeenCalledWith(
      'task-orphan',
      'failed',
      expect.objectContaining({ outcome: expect.objectContaining({ kind: 'failed' }) }),
      expect.objectContaining({ from: ['calling'] }),
    );
    expect(CallSession).not.toHaveBeenCalled();
  });
});

describe('resuming a checking_availability task (#64)', () => {
  const readAt = new Date('2026-09-29T12:00:00.000Z');
  const resumedAt = new Date('2026-09-29T12:00:15.000Z');

  it('claims the resume only if the row is unchanged since it was read, and chains the dial off that claim', async () => {
    getTask.mockResolvedValue({ id: 'task-r', channel: 'phone', status: 'checking_availability', contactId: 'contact-3', constraints: {}, updatedAt: readAt });
    getContact.mockResolvedValue({ id: 'contact-3' });
    transitionTask.mockImplementation(async (id: string, status: string) => ({ id, status, updatedAt: resumedAt }));
    createCallAttempt.mockRejectedValueOnce(new Error('stop after the dial transition'));

    triggerOrchestration('task-r');
    await vi.waitFor(() => expect(createCallAttempt).toHaveBeenCalled());

    expect(transitionTask).toHaveBeenNthCalledWith(1, 'task-r', 'checking_availability', undefined, {
      from: ['checking_availability'],
      ifUpdatedAt: readAt,
      notAwaitingApproval: true,
    });
    expect(transitionTask).toHaveBeenNthCalledWith(2, 'task-r', 'calling', expect.anything(), {
      from: ['checking_availability'],
      ifUpdatedAt: resumedAt,
    });
  });

  it('does not dial when another process took the task over before this run reached calling', async () => {
    getTask.mockResolvedValue({ id: 'task-s', channel: 'phone', status: 'pending', contactId: 'contact-4', constraints: {} });
    getContact.mockResolvedValue({ id: 'contact-4' });
    transitionTask.mockImplementation(async (id: string, status: string) =>
      status === 'calling' ? undefined : { id, status, updatedAt: readAt },
    );

    triggerOrchestration('task-s');
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith({ taskId: 'task-s' }, expect.stringMatching(/taken over/)));

    expect(createCallAttempt).not.toHaveBeenCalled();
    expect(CallSession).not.toHaveBeenCalled();
    expect(notifyTaskOutcome).not.toHaveBeenCalled();
  });
});

describe("an 'ask' task (#148)", () => {
  it('dials without looking up free time: it books nothing', async () => {
    getTask.mockResolvedValue({ id: 'task-ask', channel: 'phone', status: 'pending', mode: 'ask', contactId: 'contact-3', constraints: {} });
    getContact.mockResolvedValue({ id: 'contact-3' });
    transitionTask.mockImplementation(async (id: string, status: string) => ({ id, status }));
    createCallAttempt.mockResolvedValueOnce({ id: 'attempt-ask' });
    CallSession.mockImplementation(function () {
      return { start: async () => { throw new Error('stop here'); } };
    });

    triggerOrchestration('task-ask');
    await vi.waitFor(() => expect(CallSession).toHaveBeenCalled());

    expect(computeCandidateWindows).not.toHaveBeenCalled();
    expect(transitionTask).toHaveBeenCalledWith('task-ask', 'calling', { candidateWindows: [] }, expect.objectContaining({ from: ['checking_availability'] }));
  });
});

describe('a call waiting for the owner to approve it', () => {
  it('is not claimed or dialed while unapproved', async () => {
    getTask.mockResolvedValue({
      id: 'waiting', channel: 'phone', status: 'pending', contactId: 'contact-1', constraints: {}, mode: 'booking',
      approvalExpiresAt: new Date(Date.now() + 60_000), approvedAt: null,
    });
    getContact.mockResolvedValue({ id: 'contact-1' });
    transitionTask.mockImplementation(async (id: string, status: string) => ({ id, status }));

    triggerOrchestration('waiting');
    await vi.waitFor(() => expect(getTask).toHaveBeenCalledWith('waiting'));
    await new Promise((r) => setTimeout(r, 10));

    expect(transitionTask).not.toHaveBeenCalled();
    expect(createCallAttempt).not.toHaveBeenCalled();
  });

  it('is claimed once approved', async () => {
    getTask.mockResolvedValue({
      id: 'approved', channel: 'phone', status: 'pending', contactId: 'contact-1', constraints: {}, mode: 'booking',
      approvalExpiresAt: new Date(Date.now() + 60_000), approvedAt: new Date(),
    });
    getContact.mockResolvedValue({ id: 'contact-1' });
    transitionTask.mockImplementation(async (id: string, status: string) => ({ id, status }));

    triggerOrchestration('approved');
    await vi.waitFor(() =>
      expect(transitionTask).toHaveBeenCalledWith('approved', 'checking_availability', undefined, { from: ['pending'], notAwaitingApproval: true }),
    );
  });
});

describe('call screening when a scheduled call comes due (#150)', () => {
  it('does not claim or dial a due call that screening holds', async () => {
    const { config } = await import('../../src/config/index.js');
    const due = await import('../../src/screening/due.js');
    const screen = vi.spyOn(due, 'screenWhenDue').mockResolvedValue(true);
    config.SCREEN_CALLS = true;
    try {
      getTask.mockResolvedValue({ id: 'task-9', channel: 'phone', status: 'pending', contactId: 'contact-1', constraints: {}, scheduledFor: new Date(), approvedAt: null, approvalExpiresAt: null });
      getContact.mockResolvedValue({ id: 'contact-1', doNotCallAt: null });

      triggerOrchestration('task-9');
      await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith({ taskId: 'task-9' }, 'call screening held a call before it was dialed'));

      expect(screen).toHaveBeenCalledTimes(1);
      expect(transitionTask).not.toHaveBeenCalled();
      expect(CallSession).not.toHaveBeenCalled();
    } finally {
      config.SCREEN_CALLS = false;
      screen.mockRestore();
    }
  });
});
