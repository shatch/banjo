import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLiveCall, listLiveCalls, registerLiveCall, unregisterLiveCall } from '../../src/tasks/liveCalls.js';

// CallSession.start() returns once the call is SET UP — origination plus the
// voice-AI connect. The conversation itself then runs on event handlers for
// however many minutes it lasts. The first cut of this registry unregistered
// in a `finally` around start(), so the entry vanished the moment the phone
// began ringing and stop_call could never find a live call. Caught on a real
// call: status was 'calling', the callee had answered, and stop_call still
// reported "no live call for this task on this instance".
const startResolvesAfterSetup = vi.fn(async () => {});
class FakeCallSession {
  start = startResolvesAfterSetup;
  stop = vi.fn(async () => {});
}
vi.mock('../../src/session/callSession.js', () => ({ CallSession: FakeCallSession }));

const getTask = vi.fn();
const transitionTask = vi.fn();
const createCallAttempt = vi.fn(async () => ({ id: 'attempt-1' }));
vi.mock('../../src/tasks/service.js', () => ({
  getTask,
  transitionTask,
  createCallAttempt,
  isTaskDue: () => true,
  listNonTerminalTasks: vi.fn(async () => []),
  latestCallAttemptFor: vi.fn(async () => undefined),
  // Under the per-number call cap, so the run gets as far as dialing.
  callsPlacedToContactSince: vi.fn(async () => ({ count: 0 })),
  dueQueuedCallsForContact: vi.fn(async () => 0),
  isTerminalStatus: (status: string) => !['pending', 'checking_availability', 'calling', 'negotiating'].includes(status),
}));
vi.mock('../../src/contacts/service.js', () => ({ getContact: vi.fn(async () => ({ id: 'c1', phoneNumber: '+15551234567' })) }));
vi.mock('../../src/telephony/factory.js', () => ({ createTelephonyProvider: () => ({}) }));
vi.mock('../../src/calendar/googleCalendarProvider.js', () => ({
  GoogleCalendarProvider: class {
    computeCandidateWindows = vi.fn(async () => []);
    findEventByIdempotencyKey = vi.fn(async () => undefined);
  },
}));
vi.mock('../../src/tasks/callSessionAdapter.js', () => ({
  buildOutboundCallSessionOptions: vi.fn(() => ({})),
  notifyTaskOutcome: vi.fn(async () => {}),
}));
vi.mock('../../src/tasks/promptBuilder.js', () => ({
  buildCallSystemPrompt: () => 'prompt',
  buildCallFrontendPrompt: () => 'frontend',
}));

const { triggerOrchestration } = await import('../../src/tasks/orchestrator.js');

beforeEach(() => {
  vi.clearAllMocks();
  for (const c of listLiveCalls()) unregisterLiveCall(c.taskId);
});

describe('live call registry lifetime', () => {
  it('keeps the call registered after start() returns, for as long as the call is up', async () => {
    getTask.mockResolvedValue({ id: 'task-1', channel: 'phone', status: 'pending', constraints: {}, contactId: 'c1', mode: 'booking' });
    transitionTask.mockImplementation(async (_id: string, status: string) => ({ id: 'task-1', status }));

    triggerOrchestration('task-1');
    await vi.waitFor(() => expect(startResolvesAfterSetup).toHaveBeenCalled());
    // Let every microtask after start() settle — the buggy version cleared the
    // entry here, in a finally.
    await new Promise((r) => setTimeout(r, 20));

    expect(getLiveCall('task-1')).toMatchObject({ taskId: 'task-1', callAttemptId: 'attempt-1' });
  });

  it('drops the registration if the call never got off the ground', async () => {
    getTask.mockResolvedValue({ id: 'task-1', channel: 'phone', status: 'pending', constraints: {}, contactId: 'c1', mode: 'booking' });
    transitionTask.mockImplementation(async (_id: string, status: string) => ({ id: 'task-1', status }));
    startResolvesAfterSetup.mockRejectedValueOnce(new Error('originate blew up'));

    triggerOrchestration('task-1');
    await vi.waitFor(() => expect(startResolvesAfterSetup).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    // Nothing will ever emit an end-of-call signal for a session that never
    // started, so this one must not leak.
    expect(getLiveCall('task-1')).toBeUndefined();
  });
});
