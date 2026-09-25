import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProvider } from '../../src/calendar/types.js';
import type { Contact } from '../../src/contacts/schema.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';
import { getLiveCall, listLiveCalls, registerLiveCall, unregisterLiveCall } from '../../src/tasks/liveCalls.js';

// buildOutboundCallSessionOptions's onStatusChange/onFailure call through to
// tasks/service.js (getTask/transitionTask/updateCallAttempt) — stub the
// whole persistence layer so those closures can be exercised directly,
// matching the pattern used in tests/voice/callTools.test.ts.
const { getTask, transitionTask, updateCallAttempt } = vi.hoisted(() => ({
  getTask: vi.fn(async () => undefined as Task | undefined),
  transitionTask: vi.fn(async () => {}),
  updateCallAttempt: vi.fn(async () => {}),
}));
vi.mock('../../src/tasks/service.js', () => ({
  getTask,
  transitionTask,
  updateCallAttempt,
  isTerminalStatus: (status: string) => !['pending', 'checking_availability', 'calling', 'negotiating'].includes(status),
}));

const { saveTranscriptTurn } = vi.hoisted(() => ({ saveTranscriptTurn: vi.fn(async () => {}) }));
vi.mock('../../src/transcripts/service.js', () => ({ saveTranscriptTurn }));

const { buildOutboundCallSessionOptions } = await import('../../src/tasks/callSessionAdapter.js');

// Minimal fakes mirroring tests/session/callSession.test.ts's style — only
// the shape needed to construct buildOutboundCallSessionOptions's params;
// none of these fakes' methods are actually invoked by this test since we
// only inspect the returned options object, not any of its closures.
const fakeTask = { id: 'task-1' } as Task;
const fakeCallAttempt = { id: 'call-attempt-1' } as CallAttempt;
const fakeContact = { id: 'contact-1', phoneNumber: '+15555550100' } as Contact;

const fakeTelephony: TelephonyProvider = {
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

const fakeCalendar: CalendarProvider = {
  computeCandidateWindows: vi.fn(async () => []),
  isFree: vi.fn(async () => true),
  createEventIdempotent: vi.fn(async () => ({
    eventId: 'evt-1',
    confirmedStart: '2026-08-04T18:00:00.000Z',
    confirmedEnd: '2026-08-04T18:30:00.000Z',
  })),
  findEventByIdempotencyKey: vi.fn(async () => undefined),
  deleteEvent: vi.fn(async () => {}),
};

describe('buildOutboundCallSessionOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const [disclosure, disclosed] of [
    ['disclosed', true],
    ['missed', false],
    ['no_speech', null],
  ] as const) {
    it(`records disclosure=${disclosure} on the call attempt as disclosed=${disclosed} (#8)`, async () => {
      const options = buildOutboundCallSessionOptions({
        task: { ...fakeTask, mode: 'booking' } as Task,
        callAttempt: fakeCallAttempt,
        contact: fakeContact,
        telephony: fakeTelephony,
        calendar: fakeCalendar,
        systemPrompt: 'irrelevant for this test',
      });
      await options.onStatusChange({ kind: 'ended', reason: 'callee hung up', disclosure });
      expect(updateCallAttempt).toHaveBeenCalledWith('call-attempt-1', expect.objectContaining({ disclosed }));
    });
  }

  it('stores the recording id on the call attempt when recording starts (#8)', async () => {
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });
    await options.onStatusChange({ kind: 'recording_started', recordingId: 'RE1' });
    expect(updateCallAttempt).toHaveBeenCalledWith('call-attempt-1', { recordingSid: 'RE1' });
  });

  it('onTranscript saves the line against this call attempt (#6)', async () => {
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });
    const turn = { seq: 1, role: 'user' as const, text: 'Hello?', quality: 'ok' as const, voiceProvider: 'openai', spokenAt: new Date() };
    await options.onTranscript(turn);
    expect(saveTranscriptTurn).toHaveBeenCalledWith({ callAttemptId: 'call-attempt-1' }, turn);
  });

  it('places the call without Twilio answering-machine detection (#32)', async () => {
    // AMD reported machine_start for a person answering "Claudia's Fabulous
    // Dog Grooming, this call may be recorded..." — businesses, most of what
    // Banjo calls, answer with exactly the long greeting it reads as
    // voicemail. Nothing acted on the verdict, and it was billed per call.
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

    await options.beginCall();

    expect(fakeTelephony.originateCall).toHaveBeenCalledTimes(1);
    const [opts] = vi.mocked(fakeTelephony.originateCall).mock.calls[0]!;
    expect(opts.answeringMachineDetection).toBeFalsy();
  });

  it('wires up the base outbound tool set (press_digits + callTools) for a booking-mode task', () => {
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

    expect(options.tools.some((t) => t.name === 'press_digits')).toBe(true);
    expect(options.tools.length).toBeGreaterThan(1);
    expect(options.tools.some((t) => t.name === 'end_conversation_call')).toBe(false);
  });

  it('adds end_conversation_call to the tool set for a conversation-mode task, without removing anything', () => {
    const bookingOptions = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });
    const conversationOptions = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'conversation' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

    expect(conversationOptions.tools.some((t) => t.name === 'end_conversation_call')).toBe(true);
    expect(conversationOptions.tools.length).toBe(bookingOptions.tools.length + 1);
    // Everything in the booking-mode list is still present in the conversation-mode list.
    for (const t of bookingOptions.tools) {
      expect(conversationOptions.tools.some((c) => c.name === t.name)).toBe(true);
    }
  });

  it("onStatusChange('ended'): marks a still-non-terminal task 'failed' instead of leaving it orphaned — a real call ended (far end hung up / socket closed) before the model ever called an outcome tool, and the task was left stuck at its in-progress status forever with no outcome recorded and no notification ever sent (notifyIfTerminal is a no-op without an outcome)", async () => {
    getTask.mockResolvedValueOnce({ id: 'task-1', status: 'negotiating' } as unknown as Task);
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'conversation' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

    await options.onStatusChange({ kind: 'ended', reason: 'stop', disclosure: 'disclosed' });

    expect(getTask).toHaveBeenCalledWith('task-1');
    expect(transitionTask).toHaveBeenCalledWith('task-1', 'failed', {
      outcome: { kind: 'failed', reason: 'stop' },
    });
  });

  it("onStatusChange('ended'): does not touch a task that already reached a terminal status (e.g. confirm_appointment already ran) before the call ended", async () => {
    getTask.mockResolvedValueOnce({ id: 'task-1', status: 'confirmed' } as unknown as Task);
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

    await options.onStatusChange({ kind: 'ended', reason: 'stop', disclosure: 'disclosed' });

    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('passes frontendSystemPrompt through, and puts a verbatim delivery report on the tool context for the voicemail handler', async () => {
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'full prompt',
      frontendSystemPrompt: 'voice prompt',
    });
    expect(options.frontendSystemPrompt).toBe('voice prompt');

    const report = { intended: 'call back at 555-1234', spoken: 'call back', matched: false };
    const ctx = await options.buildToolContext(123, report);
    expect(ctx.verbatimDelivery).toBe(report);
    expect(ctx.estimatedAudioDoneAt).toBe(123);
  });
});

describe('transfer_to_owner on outbound calls (#7)', () => {
  let config: typeof import('../../src/config/index.js').config;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ config } = await import('../../src/config/index.js'));
    config.TRANSFER_TO_PHONE_NUMBER = '+15557654321';
  });
  afterEach(() => {
    config.TRANSFER_ENABLED = false;
  });

  const build = () =>
    buildOutboundCallSessionOptions({
      task: fakeTask, callAttempt: fakeCallAttempt, contact: fakeContact,
      telephony: fakeTelephony, calendar: fakeCalendar, systemPrompt: 'irrelevant',
    });

  it('is offered only when TRANSFER_ENABLED is on', () => {
    config.TRANSFER_ENABLED = false;
    expect(build().tools.map((t) => t.name)).not.toContain('transfer_to_owner');
    config.TRANSFER_ENABLED = true;
    expect(build().tools.map((t) => t.name)).toContain('transfer_to_owner');
  });

  it('records the task as transferred after the redirect succeeds', async () => {
    const { transferToOwnerTool } = await import('../../src/tasks/callSessionAdapter.js');
    const telephony = { ...fakeTelephony, transferCall: vi.fn(async () => {}) };
    const result = await transferToOwnerTool.handler(
      { reason: 'they need a card number' },
      { task: { id: 'task-1', status: 'negotiating' }, callId: 'call-attempt-1', telephony, estimatedAudioDoneAt: Date.now() } as never,
    );
    expect(result).toEqual({ ok: true });
    expect(transitionTask).toHaveBeenCalledWith('task-1', 'transferred', {
      outcome: { kind: 'transferred', reason: 'they need a card number' },
    });
  });

  it('leaves the task alone when the redirect fails', async () => {
    const { transferToOwnerTool } = await import('../../src/tasks/callSessionAdapter.js');
    const telephony = { ...fakeTelephony, transferCall: vi.fn(async () => { throw new Error('twilio 500'); }) };
    const result = await transferToOwnerTool.handler(
      { reason: 'x' },
      { task: { id: 'task-1', status: 'negotiating' }, callId: 'call-attempt-1', telephony, estimatedAudioDoneAt: Date.now() } as never,
    );
    expect(result).toMatchObject({ ok: false, error: 'transfer_failed' });
    expect(transitionTask).not.toHaveBeenCalled();
  });
});

describe('clearing the live-call registration when a call really ends', () => {
  // The registration has to outlive CallSession.start(), which returns as soon
  // as the call is set up — so the adapter's end-of-call signals are what
  // clear it. Each one, because a call reaches exactly one of them.
  function optionsForLiveTask() {
    registerLiveCall({ taskId: 'task-1', callAttemptId: 'call-attempt-1', session: { stop: vi.fn() } });
    return buildOutboundCallSessionOptions({
      task: fakeTask,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });
  }

  beforeEach(() => {
    for (const c of listLiveCalls()) unregisterLiveCall(c.taskId);
  });

  it("clears it when the call ends normally", async () => {
    const options = optionsForLiveTask();
    await options.onStatusChange({ kind: 'ended', reason: 'callee hung up', disclosure: 'disclosed' });
    expect(getLiveCall('task-1')).toBeUndefined();
  });

  it('clears it when the call ends in a status failure', async () => {
    const options = optionsForLiveTask();
    await options.onStatusChange({ kind: 'failed', reason: 'telephony blew up', disclosure: 'disclosed' });
    expect(getLiveCall('task-1')).toBeUndefined();
  });

  it('clears it when the session reports a failure', async () => {
    const options = optionsForLiveTask();
    await options.onFailure('voice ai died');
    expect(getLiveCall('task-1')).toBeUndefined();
  });
});
