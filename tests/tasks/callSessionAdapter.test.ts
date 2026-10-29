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

const { sendOwnerMessage } = vi.hoisted(() => ({ sendOwnerMessage: vi.fn(async () => {}) }));
vi.mock('../../src/notifications/owner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/notifications/owner.js')>()),
  sendOwnerMessage,
}));

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

  it('gives the session the disclosure line as its opening line (#118)', async () => {
    const { disclosureLine } = await import('../../src/config/index.js');
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'conversation' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });
    expect(options.openingLine).toBe(disclosureLine());
    expect(options.openingLine).toMatch(/\bAI\b/);
  });

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

  it("gives an ask task report_answers_and_end_call and none of the booking tools (#148)", () => {
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'ask' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });
    const names = options.tools.map((t) => t.name);
    expect(names).toContain('report_answers_and_end_call');
    for (const kept of ['press_digits', 'leave_voicemail_and_end_call', 'escalate_and_end_call', 'end_call']) expect(names).toContain(kept);
    for (const dropped of ['check_my_availability', 'confirm_appointment', 'undo_confirmed_appointment', 'report_negotiation_failed', 'end_conversation_call']) {
      expect(names).not.toContain(dropped);
    }
  });

  it('leaves every booking tool off an ask task, by identity rather than name (#148 review)', async () => {
    // Filtering by a list of name strings let a renamed or new booking tool
    // back onto ask calls silently.
    const { bookingCallTools } = await import('../../src/voice/tools/callTools.js');
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'ask' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });
    expect(bookingCallTools.length).toBeGreaterThan(0);
    for (const tool of bookingCallTools) expect(options.tools).not.toContain(tool);
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

  // #179: a live conversation call ended with her hanging up after a real
  // exchange, and was recorded failed, with no summary.
  for (const [theirReplies, stopped, status] of [
    [2, false, 'conversation_completed'],
    [0, false, 'failed'],
    [2, true, 'failed'],
  ] as const) {
    it(`records a conversation call that ended with ${theirReplies} replies from them${stopped ? ', stopped by the owner,' : ''} as ${status} (#179)`, async () => {
      getTask.mockResolvedValueOnce({ id: 'task-1', mode: 'conversation', status: 'negotiating' } as unknown as Task);
      const options = buildOutboundCallSessionOptions({
        task: { ...fakeTask, mode: 'conversation' } as Task,
        callAttempt: fakeCallAttempt,
        contact: fakeContact,
        telephony: fakeTelephony,
        calendar: fakeCalendar,
        systemPrompt: 'irrelevant for this test',
      });

      await options.onStatusChange({ kind: 'ended', reason: 'stop', disclosure: 'disclosed', theirReplies, ...(stopped ? { stopped: true } : {}) });

      if (status === 'failed') {
        expect(transitionTask).toHaveBeenCalledWith('task-1', 'failed', { outcome: { kind: 'failed', reason: 'stop' } });
      } else {
        expect(transitionTask).toHaveBeenCalledWith('task-1', 'conversation_completed', {
          outcome: { kind: 'conversation_completed', summary: expect.stringContaining('ended before Banjo said goodbye') },
        });
      }
    });
  }

  it("gives an ask task record_answer, which doesn't end the call (#148 review)", () => {
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'ask' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });
    const recordAnswer = options.tools.find((t) => t.name === 'record_answer');
    expect(recordAnswer).toBeDefined();
    expect(recordAnswer?.endsCall).toBeFalsy();
    for (const mode of ['booking', 'conversation'] as const) {
      const other = buildOutboundCallSessionOptions({
        task: { ...fakeTask, mode } as Task,
        callAttempt: fakeCallAttempt,
        contact: fakeContact,
        telephony: fakeTelephony,
        calendar: fakeCalendar,
        systemPrompt: 'irrelevant for this test',
      });
      expect(other.tools.some((t) => t.name === 'record_answer')).toBe(false);
    }
  });

  type Options = ReturnType<typeof buildOutboundCallSessionOptions>;
  for (const [how, end] of [
    ['the other party hangs up', (o: Options) => o.onStatusChange({ kind: 'ended', reason: 'callee hung up', disclosure: 'disclosed' })],
  ] as const) {
    it(`records an ask call's saved answers as answered when ${how} before it ends itself (#148 review)`, async () => {
      getTask.mockResolvedValueOnce({
        id: 'task-1',
        mode: 'ask',
        status: 'negotiating',
        questions: ['Q1?', 'Q2?'],
        collectedAnswers: { '1': { question: 1, answered: true, answer: '6pm.' } },
      } as unknown as Task);
      const options = buildOutboundCallSessionOptions({
        task: { ...fakeTask, mode: 'ask', questions: ['Q1?', 'Q2?'] } as Task,
        callAttempt: fakeCallAttempt,
        contact: fakeContact,
        telephony: fakeTelephony,
        calendar: fakeCalendar,
        systemPrompt: 'irrelevant for this test',
      });

      await end(options);

      expect(transitionTask).toHaveBeenCalledWith('task-1', 'answered', {
        outcome: {
          kind: 'answered',
          answers: [
            { question: 'Q1?', answered: true, answer: '6pm.' },
            { question: 'Q2?', answered: false },
          ],
          summary: expect.stringContaining('The call ended before Banjo could wrap it up'),
        },
      });
    });
  }

  for (const [how, end, reason] of [
    ['the owner stops it', (o: Options) => o.onStatusChange({ kind: 'ended', reason: 'wrong business, stop', disclosure: 'disclosed', stopped: true }), 'wrong business, stop'],
    ['the session fails', (o: Options) => o.onFailure('voice ai died'), 'voice ai died'],
  ] as const) {
    it(`keeps the reason, recording it failed, when ${how} with answers saved (#148 review r2)`, async () => {
      // stop_call tells the agent the task "is recorded as failed with that
      // reason"; recording it answered dropped the reason. The saved answers
      // still reach the owner (get_task_status, withSavedAnswers).
      getTask.mockResolvedValueOnce({
        id: 'task-1',
        mode: 'ask',
        status: 'negotiating',
        questions: ['Q1?', 'Q2?'],
        collectedAnswers: { '1': { question: 1, answered: true, answer: '6pm.' } },
      } as unknown as Task);
      const options = buildOutboundCallSessionOptions({
        task: { ...fakeTask, mode: 'ask', questions: ['Q1?', 'Q2?'] } as Task,
        callAttempt: fakeCallAttempt,
        contact: fakeContact,
        telephony: fakeTelephony,
        calendar: fakeCalendar,
        systemPrompt: 'irrelevant for this test',
      });

      await end(options);

      expect(transitionTask).toHaveBeenCalledWith('task-1', 'failed', { outcome: { kind: 'failed', reason } });
    });
  }

  it('still fails an ask call that ends early with no answers saved (#148 review)', async () => {
    getTask.mockResolvedValueOnce({ id: 'task-1', mode: 'ask', status: 'negotiating', questions: ['Q1?'], collectedAnswers: null } as unknown as Task);
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'ask', questions: ['Q1?'] } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

    await options.onStatusChange({ kind: 'ended', reason: 'callee hung up', disclosure: 'disclosed' });

    expect(transitionTask).toHaveBeenCalledWith('task-1', 'failed', { outcome: { kind: 'failed', reason: 'callee hung up' } });
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

  it('retries recording the transfer once if the first write throws (#7 review)', async () => {
    const { transferToOwnerTool } = await import('../../src/tasks/callSessionAdapter.js');
    transitionTask.mockRejectedValueOnce(new Error('db blip'));
    const telephony = { ...fakeTelephony, transferCall: vi.fn(async () => {}) };
    const result = await transferToOwnerTool.handler(
      { reason: 'they need a card number' },
      { task: { id: 'task-1', status: 'negotiating' }, callId: 'call-attempt-1', telephony, estimatedAudioDoneAt: Date.now() } as never,
    );
    expect(result).toEqual({ ok: true });
    expect(transitionTask).toHaveBeenCalledTimes(2);
    expect(transitionTask).toHaveBeenLastCalledWith('task-1', 'transferred', {
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

describe('waiting on hold (#151)', () => {
  const build = (task: Partial<Task> = {}) =>
    buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking', constraints: {}, ...task } as Task,
      callAttempt: fakeCallAttempt,
      contact: { ...fakeContact, displayName: 'Main Street Pharmacy' } as Contact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

  it('offers wait_on_hold on OpenAI Realtime, the provider that can hold', () => {
    expect(build().tools.some((t) => t.name === 'wait_on_hold')).toBe(true);
  });

  it('offers wait_on_hold and ask_owner on openai-live too, and neither on a provider that can do neither', async () => {
    const { config } = await import('../../src/config/index.js');
    const names = () => build().tools.map((t) => t.name);
    try {
      config.ASK_OWNER_ENABLED = true;
      config.VOICE_AI_PROVIDER = 'openai-live';
      expect(names()).toEqual(expect.arrayContaining(['wait_on_hold', 'ask_owner']));
      config.VOICE_AI_PROVIDER = 'gemini';
      expect(names()).not.toContain('wait_on_hold');
      expect(names()).not.toContain('ask_owner');
    } finally {
      config.ASK_OWNER_ENABLED = false;
      config.VOICE_AI_PROVIDER = 'openai';
    }
  });

  it('offers ask_owner only when ASK_OWNER_ENABLED is on', async () => {
    const { config } = await import('../../src/config/index.js');
    expect(build().tools.some((t) => t.name === 'ask_owner')).toBe(false);
    try {
      config.ASK_OWNER_ENABLED = true;
      expect(build().tools.some((t) => t.name === 'ask_owner')).toBe(true);
    } finally {
      config.ASK_OWNER_ENABLED = false;
    }
  });

  it("uses the task's own hold limit when it sets one", () => {
    expect(build().maxHoldMs).toBeUndefined();
    expect(build({ constraints: { maxHoldMinutes: 30 } }).maxHoldMs).toBe(30 * 60_000);
  });

  it('tells the owner when a hold starts and when someone picks up', async () => {
    const options = build();
    await options.onHoldChange!({ kind: 'started', maxMs: 20 * 60_000 });
    await options.onHoldChange!({ kind: 'person', waitedMs: 7 * 60_000 + 10_000 });
    expect(sendOwnerMessage).toHaveBeenNthCalledWith(1, 'Banjo is on hold with Main Street Pharmacy and will wait up to 20 minutes.');
    expect(sendOwnerMessage).toHaveBeenNthCalledWith(2, 'Someone picked up at Main Street Pharmacy after 7 minutes on hold. Banjo is talking to them now.');
  });

  it('a phone menu stepping in and out of hold tells the owner once, until someone picks up', async () => {
    vi.mocked(sendOwnerMessage).mockClear();
    const options = build();
    await options.onHoldChange!({ kind: 'started', maxMs: 20 * 60_000 });
    await options.onHoldChange!({ kind: 'menu' });
    await options.onHoldChange!({ kind: 'started', maxMs: 19 * 60_000 });
    expect(sendOwnerMessage).toHaveBeenCalledTimes(1);
    await options.onHoldChange!({ kind: 'person', waitedMs: 60_000 });
    // A new hold after talking to someone (a transfer, say) is news again.
    await options.onHoldChange!({ kind: 'started', maxMs: 15 * 60_000 });
    expect(sendOwnerMessage).toHaveBeenCalledTimes(3);
    expect(sendOwnerMessage).toHaveBeenLastCalledWith('Banjo is on hold with Main Street Pharmacy and will wait up to 15 minutes.');
  });

  it("records a hold that ran out as escalated, stuck at the hold limit", async () => {
    await build().onHoldLimit!(20 * 60_000);
    expect(transitionTask).toHaveBeenCalledWith('task-1', 'escalated', {
      outcome: { kind: 'escalated', reason: 'Waited on hold for 20 minutes and nobody picked up, so Banjo hung up.', stuckAt: 'hold_limit' },
    });
  });
});
