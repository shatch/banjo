import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CalendarProvider } from '../../src/calendar/types.js';
import type { CallSessionOptions } from '../../src/session/callSession.js';
import type { CallContext } from '../../src/session/types.js';
import type { CallAttempt } from '../../src/tasks/schema.js';
import type { TelephonyEvent, TelephonyProvider } from '../../src/telephony/providers/types.js';
import { VoiceAIError, type VoiceAIEvent, type VoiceAIProvider } from '../../src/voice/types.js';

// CallSession constructs its own VoiceAIProvider internally via
// createVoiceAIProvider() (see src/voice/factory.ts) rather than accepting
// one through CallSessionOptions — mock the factory so tests can control
// (and spy on) the voice leg.
const fakeVoiceAI = {
  name: 'fake-voice',
  connect: vi.fn(async () => {}),
  sendAudioChunk: vi.fn(),
  sendToolResult: vi.fn(),
  interrupt: vi.fn(),
  triggerResponse: vi.fn(),
  sayVerbatim: vi.fn(),
  disconnect: vi.fn(async () => {}),
  on: vi.fn((_event: 'event', listener: (e: VoiceAIEvent) => void) => voiceAIEmitter.on('event', listener)),
  off: vi.fn((_event: 'event', listener: (e: VoiceAIEvent) => void) => voiceAIEmitter.off('event', listener)),
} satisfies VoiceAIProvider;
const voiceAIEmitter = new EventEmitter();

vi.mock('../../src/voice/factory.js', () => ({
  createVoiceAIProvider: () => fakeVoiceAI,
}));

const { CallSession } = await import('../../src/session/callSession.js');

function makeFakeTelephony() {
  const emitter = new EventEmitter();
  const provider: TelephonyProvider = {
    name: 'fake-telephony',
    nativeAudioFormat: 'g711_ulaw_8k',
    originateCall: vi.fn(async () => ({ providerCallId: 'CA-fake-sid' })),
    sendAudio: vi.fn(),
    sendDigits: vi.fn(async () => {}),
    interrupt: vi.fn(),
    hangUp: vi.fn(async () => {}),
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
  };
  return { provider, emit: (e: TelephonyEvent) => emitter.emit('event', e) };
}

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

const callAttempt = { id: 'call-attempt-1' } as CallAttempt;

/** Builds a fake CallSessionOptions for a test — every persistence callback
 *  is a no-op spy, matching how the removed tasks/service.js mock used to
 *  behave, since none of these tests assert on persistence, only on the
 *  telephony/voice-AI side effects (hangUp, disconnect, sendAudioChunk). */
function makeFakeCallSessionOptions(telephony: TelephonyProvider): CallSessionOptions {
  return {
    callId: callAttempt.id,
    telephony,
    systemPrompt: 'irrelevant for this test',
    tools: [],
    beginCall: vi.fn(async () => ({ providerCallId: 'CA-fake-sid' })),
    buildToolContext: vi.fn(async () => ({}) as CallContext),
    onStatusChange: vi.fn(async () => {}),
    onFailure: vi.fn(async () => {}),
    notifyIfTerminal: vi.fn(async () => {}),
    onTranscript: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CallSession: frontendSystemPrompt', () => {
  it('passes frontendSystemPrompt through to voiceAI.connect as frontendInstructions, alongside the full systemPrompt', async () => {
    const telephony = makeFakeTelephony();
    const options = { ...makeFakeCallSessionOptions(telephony.provider), frontendSystemPrompt: 'voice-only prompt' };
    await new CallSession(options).start();

    expect(fakeVoiceAI.connect).toHaveBeenCalledWith(
      expect.objectContaining({ instructions: 'irrelevant for this test', frontendInstructions: 'voice-only prompt' }),
    );
  });

  it('sends no frontendInstructions when no frontendSystemPrompt is given', async () => {
    const telephony = makeFakeTelephony();
    await new CallSession(makeFakeCallSessionOptions(telephony.provider)).start();

    expect(fakeVoiceAI.connect).toHaveBeenCalledWith(expect.not.objectContaining({ frontendInstructions: expect.anything() }));
  });
});

describe('CallSession: telephony leg is always explicitly hung up', () => {
  // Regression test for a real bug: a live call cut off abruptly (dead
  // silence, no goodbye) right as the model was heading into
  // confirm_appointment. Root cause — this architecture bridges the call to
  // Twilio via <Connect><Stream> (TwilioProvider.buildTwiml), so the media
  // WebSocket IS the live call; disconnecting only the Voice AI leg leaves
  // Twilio still bridged and silent. fail() and end() previously never
  // called telephony.hangUp(), unlike the graceful tool-driven paths in
  // callTools.ts (hangUpAfterSpeaking). This test would have failed against
  // the pre-fix version of callSession.ts.

  it('fail() hangs up the telephony leg, not just the voice AI leg', async () => {
    const telephony = makeFakeTelephony();
    const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));

    // fail() is private — invoked directly to isolate the cleanup behavior
    // itself from the full connect/negotiate handshake.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (session as any).fail('tool_pending_watchdog', new Error('confirm_appointment did not resolve in time'));

    expect(fakeVoiceAI.disconnect).toHaveBeenCalledTimes(1);
    expect(telephony.provider.hangUp).toHaveBeenCalledTimes(1);
    expect(telephony.provider.hangUp).toHaveBeenCalledWith(callAttempt.id);
  });

  it('fail() persists the error status before hangup and transitions the task to failed after hangup — a regression test for an ordering bug caught in review', async () => {
    // fail() previously wrote its early persistence update AFTER hangUp()
    // instead of before, and called onFailure() before hangUp() instead of
    // after — inverted from what's required (the 'failed' status patch
    // needs to land before we tear down the legs; the task-failure
    // transition should only happen once both legs are actually down).
    // This was only caught by human review, not by a test — assert the
    // relative ordering directly so it can't silently regress again.
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const session = new CallSession(options);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (session as any).fail('tool_pending_watchdog', new Error('confirm_appointment did not resolve in time'));

    expect(options.onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }));
    expect(options.onFailure).toHaveBeenCalledTimes(1);
    expect(telephony.provider.hangUp).toHaveBeenCalledTimes(1);

    const onStatusChangeOrder = vi.mocked(options.onStatusChange).mock.invocationCallOrder[0]!;
    const hangUpOrder = vi.mocked(telephony.provider.hangUp).mock.invocationCallOrder[0]!;
    const onFailureOrder = vi.mocked(options.onFailure).mock.invocationCallOrder[0]!;

    expect(onStatusChangeOrder).toBeLessThan(hangUpOrder);
    expect(onFailureOrder).toBeGreaterThan(hangUpOrder);
  });

  it('end() triggered by an unprompted voice-AI disconnect still hangs up the still-live Twilio leg', async () => {
    // This is the exact live-call shape: the Voice AI provider's own
    // realtime connection drops (network blip, provider-side error, etc.)
    // with no telephony-layer signal that the PSTN call itself has ended —
    // Twilio doesn't know anything is wrong until we tell it.
    const telephony = makeFakeTelephony();
    const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));

    await session.start();
    voiceAIEmitter.emit('event', { type: 'disconnected', reason: 'provider_connection_lost' } satisfies VoiceAIEvent);
    // end() is async and fired from an event-listener callback (fire-and-forget
    // `void this.end(...)` in handleVoiceAIEvent) — flush the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telephony.provider.hangUp).toHaveBeenCalledWith(callAttempt.id);
  });

  it('end() reached via the telephony layer already reporting the call ended does not error even though the leg is already gone', async () => {
    // TwilioProvider.hangUp() no-ops (with a warning log) when it has no
    // known state for a callId — this covers that "already ended" call
    // stays harmless rather than throwing out of hangUpTelephony().
    const telephony = makeFakeTelephony();
    const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));

    await session.start();
    telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'stop' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telephony.provider.hangUp).toHaveBeenCalledWith(callAttempt.id);
  });

  it('end() is idempotent — a second termination event after the session already ended does not hang up twice', async () => {
    const telephony = makeFakeTelephony();
    const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));

    await session.start();
    telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'stop' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'stop' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telephony.provider.hangUp).toHaveBeenCalledTimes(1);
  });

  it('end() does not double-execute when telephony "ended" and voice-AI "disconnected" fire in the same tick', async () => {
    // Regression test for the exact race the logs showed: 'stop' (telephony)
    // and 'disconnected' (voice AI) arriving close together both call
    // end(); before this fix, the guard only rejected re-entry once state
    // was 'ended'/'error', not 'ending' — so both could slip past it and
    // run the full teardown twice.
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const session = new CallSession(options);

    await session.start();
    telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'stop' });
    voiceAIEmitter.emit('event', { type: 'disconnected', reason: 'provider_connection_lost' } satisfies VoiceAIEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const endedCalls = vi.mocked(options.onStatusChange).mock.calls.filter(([patch]) => patch.kind === 'ended');
    expect(endedCalls).toHaveLength(1);
    expect(telephony.provider.hangUp).toHaveBeenCalledTimes(1);
  });

  it('end() and fail() do not double-execute when telephony "ended" and voice-AI "error" fire in the same tick', async () => {
    // fail() previously had no re-entry guard at all — only end() was fixed
    // (the previous test above). A telephony 'stop' (-> end()) racing a
    // voice-AI 'error' (-> fail()) in the same tick could still double-run
    // teardown, and for inbound calls could persist status: 'error' on a
    // call that actually ended normally. Once end() has set state to
    // 'ending'/'ended', fail() must see that and no-op rather than also
    // running onStatusChange({ kind: 'failed' }).
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const session = new CallSession(options);

    await session.start();
    telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'stop' });
    telephony.emit({ callId: callAttempt.id, type: 'error', error: new Error('some error') });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // start() already fires one onStatusChange({ kind: 'started' }) call
    // before either event — filter to just the terminal-status calls (as
    // the existing "does not double-execute" test above does for kind:
    // 'ended') to assert exactly one terminal transition happened, and that
    // it was 'ended', never 'failed'.
    const terminalCalls = vi.mocked(options.onStatusChange).mock.calls.filter(([patch]) => patch.kind === 'ended' || patch.kind === 'failed');
    expect(terminalCalls).toHaveLength(1);
    expect(terminalCalls[0]![0]).toMatchObject({ kind: 'ended' });
    expect(telephony.provider.hangUp).toHaveBeenCalledTimes(1);
  });
});

describe('CallSession: ignores events for a different call', () => {
  // Regression test for the actual bug this fix closes: TwilioProvider is a
  // process-wide singleton (telephony/factory.ts) broadcasting every event
  // to every registered listener. That was safe only because exactly one
  // call was ever live — once a second call (e.g. an inbound caller) can be
  // live at the same time, a CallSession must ignore events carrying a
  // different callId rather than reacting to another call's hangup/audio.
  it('does not hang up when an "ended" event for a different callId arrives', async () => {
    const telephony = makeFakeTelephony();
    const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));

    await session.start();
    telephony.emit({ callId: 'some-other-call', type: 'ended', reason: 'stop' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telephony.provider.hangUp).not.toHaveBeenCalled();
  });

  it('does not feed audio to the voice AI when an "audio_chunk" event for a different callId arrives', async () => {
    const telephony = makeFakeTelephony();
    const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));

    await session.start();
    telephony.emit({
      callId: 'some-other-call',
      type: 'audio_chunk',
      chunk: { data: Buffer.from([1, 2, 3]), sampleRate: 8000 },
    });

    expect(fakeVoiceAI.sendAudioChunk).not.toHaveBeenCalled();
  });
});

describe('CallSession: greetOnConnect triggers the opening greeting', () => {
  it('triggerResponse() fires exactly once on the telephony "connected" event when greetOnConnect is true', async () => {
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const options = { ...makeFakeCallSessionOptions(telephony.provider), greetOnConnect: true };
      const session = new CallSession(options);

      await session.start();
      telephony.emit({
        callId: callAttempt.id,
        type: 'connected',
        meta: { callId: callAttempt.id, providerCallId: 'CA-fake-sid', toNumber: '' },
      });
      await vi.advanceTimersByTimeAsync(500); // GREETING_DELAY_MS

      expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never calls triggerResponse() when greetOnConnect is unset — outbound behavior stays unchanged', async () => {
    const telephony = makeFakeTelephony();
    const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));

    await session.start();
    telephony.emit({
      callId: callAttempt.id,
      type: 'connected',
      meta: { callId: callAttempt.id, providerCallId: 'CA-fake-sid', toNumber: '' },
    });

    expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
  });

  it('waits GREETING_DELAY_MS before triggering the greeting, not immediately on connect', async () => {
    // Regression test for live-call feedback: firing triggerResponse() the
    // instant the Media Stream connects felt abrupt — barely half a beat
    // between "call picked up" and ea already talking. A short delay gives
    // the line a moment to settle before the greeting starts.
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const options = { ...makeFakeCallSessionOptions(telephony.provider), greetOnConnect: true };
      const session = new CallSession(options);

      await session.start();
      telephony.emit({
        callId: callAttempt.id,
        type: 'connected',
        meta: { callId: callAttempt.id, providerCallId: 'CA-fake-sid', toNumber: '' },
      });

      expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(499); // GREETING_DELAY_MS - 1
      expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1); // GREETING_DELAY_MS
      expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallSession: audio-aware hang-up wiring', () => {
  it("passes audioPlaybackTracker.estimatedDoneAt() to buildToolContext on every tool call", async () => {
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    options.tools = [
      {
        name: 'noop_tool',
        description: 'test-only no-op tool',
        schema: z.object({}),
        handler: vi.fn(async () => ({ ok: true })),
      },
    ];
    const session = new CallSession(options);

    const before = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (session as any).handleToolCall('call-1', 'noop_tool', {});
    const after = Date.now();

    expect(options.buildToolContext).toHaveBeenCalledTimes(1);
    const passedArg = vi.mocked(options.buildToolContext).mock.calls[0]![0];
    expect(passedArg).toBeGreaterThanOrEqual(before);
    expect(passedArg).toBeLessThanOrEqual(after);
  });

  it('records the post-pipeline-conversion byte length when an audio_chunk event arrives, advancing the tracker\'s estimate', async () => {
    const telephony = makeFakeTelephony();
    const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));

    await session.start();
    const before = Date.now();
    voiceAIEmitter.emit('event', {
      type: 'audio_chunk',
      chunk: { data: Buffer.alloc(800), sampleRate: 8000 }, // 800 bytes @ mu-law = 100ms of audio
    } satisfies VoiceAIEvent);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const estimatedDoneAt = (session as any).audioPlaybackTracker.estimatedDoneAt();
    expect(estimatedDoneAt).toBeGreaterThanOrEqual(before + 100);
    expect(telephony.provider.sendAudio).toHaveBeenCalledTimes(1);
  });

  it("resets the audioPlaybackTracker's high-water mark when the voice AI reports a caller barge-in ('interrupted')", async () => {
    // Regression coverage: interrupt() flushes Twilio's buffered-but-unplayed
    // audio, but without resetting the tracker too, its high-water mark would
    // keep counting that discarded audio as "will play" — over-estimating
    // estimatedDoneAt() for the rest of the call and, combined with Finding 1,
    // making hangUpAfterSpeaking's wait balloon on every subsequent hang-up.
    const telephony = makeFakeTelephony();
    const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));

    await session.start();
    const before = Date.now();
    voiceAIEmitter.emit('event', {
      type: 'audio_chunk',
      chunk: { data: Buffer.alloc(80_000), sampleRate: 8000 }, // 80,000 bytes @ mu-law = 10s of audio buffered
    } satisfies VoiceAIEvent);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any).audioPlaybackTracker.estimatedDoneAt()).toBeGreaterThanOrEqual(before + 10_000);

    voiceAIEmitter.emit('event', { type: 'interrupted' } satisfies VoiceAIEvent);

    expect(telephony.provider.interrupt).toHaveBeenCalledWith(callAttempt.id);
    const after = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const estimatedDoneAtAfterReset = (session as any).audioPlaybackTracker.estimatedDoneAt();
    expect(estimatedDoneAtAfterReset).toBeGreaterThanOrEqual(before);
    expect(estimatedDoneAtAfterReset).toBeLessThanOrEqual(after);
  });

  it('for a tool marked endsCall, waits for the response to fully finish (turn_end) before snapshotting the audio estimate — so trailing audio in the same response as the tool call is not missed', async () => {
    // Regression test for a real live-call bug: the model said "let me
    // confirm the new time..." and called end_call in the same response.
    // OpenAI's Realtime API emits response.function_call_arguments.done
    // (-> tool_call) independently of response.audio.delta (-> audio_chunk)
    // for the same response — the tool-call JSON finishes fast while the
    // confirmation sentence's TTS audio is still streaming in. Snapshotting
    // estimatedDoneAt() synchronously at tool-call time missed that trailing
    // audio entirely, so hangUpAfterSpeaking computed a near-zero wait and
    // hung up mid-sentence.
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    options.tools = [
      {
        name: 'hangup_tool',
        description: 'test-only end-call tool',
        schema: z.object({}),
        handler: vi.fn(async () => ({ ok: true })),
        endsCall: true,
      },
    ];
    const session = new CallSession(options);
    await session.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleToolCallPromise = (session as any).handleToolCall('call-1', 'hangup_tool', {});

    // Trailing audio for the SAME response streams in AFTER the tool call
    // fires but BEFORE the response is actually done.
    voiceAIEmitter.emit('event', {
      type: 'audio_chunk',
      chunk: { data: Buffer.alloc(1600), sampleRate: 8000 }, // 1600 bytes @ mu-law = 200ms
    } satisfies VoiceAIEvent);
    voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);

    await handleToolCallPromise;

    expect(options.buildToolContext).toHaveBeenCalledTimes(1);
    const passedEstimate = vi.mocked(options.buildToolContext).mock.calls[0]![0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trackerEstimate = (session as any).audioPlaybackTracker.estimatedDoneAt();
    expect(passedEstimate).toBe(trackerEstimate);
    expect(passedEstimate).toBeGreaterThanOrEqual(Date.now() + 150); // reflects the trailing 200ms chunk, not a stale pre-tool-call snapshot
  });

  it("for a tool with verbatimMessage, forces the model to speak the extracted text (voiceAI.sayVerbatim) and waits for it to finish BEFORE building the tool context or running the handler", async () => {
    // Regression coverage for the voicemail-delivery bug: a message
    // recorded as delivered via a tool argument was never actually spoken —
    // the model said a short preamble and the callee heard only that. This
    // asserts the fix's actual mechanism: sayVerbatim is called with the
    // exact extracted text, and only resolves (letting buildToolContext /
    // the handler proceed) once that forced turn's turn_end fires.
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const handler = vi.fn(async () => ({ ok: true }));
    options.tools = [
      {
        name: 'leave_voicemail_and_end_call',
        description: 'test-only voicemail tool',
        schema: z.object({ message: z.string() }),
        handler,
        endsCall: true,
        verbatimMessage: (input: { message: string }) => input.message,
      },
    ];
    const session = new CallSession(options);
    await session.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleToolCallPromise = (session as any).handleToolCall('call-1', 'leave_voicemail_and_end_call', {
      message: 'Hi, please call back at 555-1234.',
    });

    // First turn_end satisfies the pre-existing endsCall wait (any preamble
    // the model already spoke); sayVerbatim must not have been called yet.
    voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeVoiceAI.sayVerbatim).toHaveBeenCalledTimes(1);
    expect(fakeVoiceAI.sayVerbatim).toHaveBeenCalledWith('Hi, please call back at 555-1234.');
    expect(handler).not.toHaveBeenCalled();
    expect(options.buildToolContext).not.toHaveBeenCalled();

    // Second turn_end satisfies the forced verbatim speech itself.
    voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
    await handleToolCallPromise;

    expect(options.buildToolContext).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const sayVerbatimOrder = vi.mocked(fakeVoiceAI.sayVerbatim).mock.invocationCallOrder[0]!;
    const buildToolContextOrder = vi.mocked(options.buildToolContext).mock.invocationCallOrder[0]!;
    expect(sayVerbatimOrder).toBeLessThan(buildToolContextOrder);
  });

  it("for a tool with verbatimMessage, reads the provider's verbatim delivery report only after the forced speech finishes, and hands it to buildToolContext", async () => {
    const report = { intended: 'Hi, please call back at 555-1234.', spoken: 'Hi, please call back.', matched: false };
    const verbatimDeliveryReport = vi.fn(() => report);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fakeVoiceAI as any).verbatimDeliveryReport = verbatimDeliveryReport;
    try {
      const telephony = makeFakeTelephony();
      const options = makeFakeCallSessionOptions(telephony.provider);
      options.tools = [
        {
          name: 'leave_voicemail_and_end_call',
          description: 'test-only voicemail tool',
          schema: z.object({ message: z.string() }),
          handler: vi.fn(async () => ({ ok: true })),
          endsCall: true,
          verbatimMessage: (input: { message: string }) => input.message,
        },
      ];
      const session = new CallSession(options);
      await session.start();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleToolCallPromise = (session as any).handleToolCall('call-1', 'leave_voicemail_and_end_call', { message: report.intended });
      voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent); // the pre-existing endsCall wait
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(verbatimDeliveryReport).not.toHaveBeenCalled(); // the forced speech hasn't finished yet

      voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent); // the forced speech itself
      await handleToolCallPromise;

      expect(verbatimDeliveryReport).toHaveBeenCalledTimes(1);
      expect(vi.mocked(options.buildToolContext).mock.calls[0]![1]).toBe(report);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (fakeVoiceAI as any).verbatimDeliveryReport;
    }
  });

  it('for a tool with verbatimMessage on a provider without verbatimDeliveryReport, passes no report — the handler keeps its trust-the-provider path', async () => {
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    options.tools = [
      {
        name: 'leave_voicemail_and_end_call',
        description: 'test-only voicemail tool',
        schema: z.object({ message: z.string() }),
        handler: vi.fn(async () => ({ ok: true })),
        endsCall: true,
        verbatimMessage: (input: { message: string }) => input.message,
      },
    ];
    const session = new CallSession(options);
    await session.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleToolCallPromise = (session as any).handleToolCall('call-1', 'leave_voicemail_and_end_call', { message: 'hi' });
    voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
    await handleToolCallPromise;

    expect(vi.mocked(options.buildToolContext).mock.calls[0]![1]).toBeUndefined();
  });

  it('for a tool without verbatimMessage, never reads a verbatim delivery report', async () => {
    const verbatimDeliveryReport = vi.fn(() => ({ intended: 'stale', spoken: '', matched: false }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fakeVoiceAI as any).verbatimDeliveryReport = verbatimDeliveryReport;
    try {
      const telephony = makeFakeTelephony();
      const options = makeFakeCallSessionOptions(telephony.provider);
      options.tools = [{ name: 'check_my_availability', description: 'test-only', schema: z.object({}), handler: vi.fn(async () => ({ free: true })) }];
      const session = new CallSession(options);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (session as any).handleToolCall('call-1', 'check_my_availability', {});

      expect(verbatimDeliveryReport).not.toHaveBeenCalled();
      expect(vi.mocked(options.buildToolContext).mock.calls[0]![1]).toBeUndefined();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (fakeVoiceAI as any).verbatimDeliveryReport;
    }
  });

  it('for a tool with verbatimMessage, proceeds anyway after SPEAK_VERBATIM_TIMEOUT_MS if the forced speech never reports turn_end', async () => {
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const options = makeFakeCallSessionOptions(telephony.provider);
      options.tools = [
        {
          name: 'leave_voicemail_and_end_call',
          description: 'test-only voicemail tool',
          schema: z.object({ message: z.string() }),
          handler: vi.fn(async () => ({ ok: true })),
          endsCall: true,
          verbatimMessage: (input: { message: string }) => input.message,
        },
      ];
      const session = new CallSession(options);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleToolCallPromise = (session as any).handleToolCall('call-1', 'leave_voicemail_and_end_call', { message: 'test message' });
      await vi.advanceTimersByTimeAsync(4000); // TURN_END_WAIT_MS — satisfies the pre-existing endsCall wait
      expect(fakeVoiceAI.sayVerbatim).toHaveBeenCalledTimes(1);
      // No turn_end ever emitted for the forced speech itself.
      await vi.advanceTimersByTimeAsync(20_000); // SPEAK_VERBATIM_TIMEOUT_MS
      await handleToolCallPromise;

      expect(options.buildToolContext).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('for a tool marked endsCall, proceeds anyway after TURN_END_WAIT_MS if turn_end never arrives, rather than hanging forever', async () => {
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const options = makeFakeCallSessionOptions(telephony.provider);
      options.tools = [
        {
          name: 'hangup_tool',
          description: 'test-only end-call tool',
          schema: z.object({}),
          handler: vi.fn(async () => ({ ok: true })),
          endsCall: true,
        },
      ];
      const session = new CallSession(options);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleToolCallPromise = (session as any).handleToolCall('call-1', 'hangup_tool', {});
      // No turn_end ever emitted.
      await vi.advanceTimersByTimeAsync(4000); // TURN_END_WAIT_MS
      await handleToolCallPromise;

      expect(options.buildToolContext).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallSession: the call ending while a tool handler is still running', () => {
  // The hang-up-during-booking race: the callee hangs up while
  // confirm_appointment is still writing the calendar event. Recording the
  // call's end first lands the task in 'failed' and texts a failure for a
  // booking that went through.
  beforeEach(() => {
    voiceAIEmitter.removeAllListeners('event');
  });

  function sessionWithSlowTool() {
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const order: string[] = [];
    let finishHandler!: () => void;
    const handler = vi.fn(
      () =>
        new Promise((resolve) => {
          finishHandler = () => {
            order.push('handler finished');
            resolve({ ok: true });
          };
        }),
    );
    options.tools = [{ name: 'slow_tool', description: 'test-only', schema: z.object({}), handler }];
    vi.mocked(options.onStatusChange).mockImplementation(async (patch) => {
      order.push(`status:${patch.kind}`);
    });
    return { telephony, options, order, handler, finish: () => finishHandler() };
  }

  it('records the call end only after the in-flight handler finishes', async () => {
    const { telephony, options, order, handler, finish } = sessionWithSlowTool();
    await new CallSession(options).start();

    voiceAIEmitter.emit('event', { type: 'tool_call', call: { id: 'call-1', name: 'slow_tool', arguments: {} } } satisfies VoiceAIEvent);
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'callee hung up' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['status:started']);

    finish();
    await vi.waitFor(() => expect(order).toContain('status:ended'));
    expect(order).toEqual(['status:started', 'handler finished', 'status:ended']);
  });

  it('ignores a tool call that arrives while end() is waiting, and still ends the call exactly once', async () => {
    const { telephony, options, order, handler, finish } = sessionWithSlowTool();
    await new CallSession(options).start();

    voiceAIEmitter.emit('event', { type: 'tool_call', call: { id: 'call-1', name: 'slow_tool', arguments: {} } } satisfies VoiceAIEvent);
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'callee hung up' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The voice AI is still connected while end() waits, so the model can still call a tool.
    voiceAIEmitter.emit('event', { type: 'tool_call', call: { id: 'call-2', name: 'slow_tool', arguments: {} } } satisfies VoiceAIEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('call-2', { ok: false, error: 'call_ended' }, true);

    finish();
    await vi.waitFor(() => expect(order).toContain('status:ended'));
    // disconnect() makes a real provider emit 'disconnected', which reaches end() again.
    voiceAIEmitter.emit('event', { type: 'disconnected', reason: 'client disconnect' } satisfies VoiceAIEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(order.filter((entry) => entry === 'status:ended')).toHaveLength(1);
    expect(options.notifyIfTerminal).toHaveBeenCalledTimes(1);
  });

  it("stops waiting at the tool's own budget (its watchdog, 15s) plus a margin if the handler never finishes (#3)", async () => {
    // Was TOOL_TIMEOUT_MS + 1s (9s), shorter than the 15s the tool-pending
    // watchdog itself allows a handler — so end() could record the call over
    // a handler that was still inside its budget.
    vi.useFakeTimers();
    try {
      const { telephony, options, order, handler } = sessionWithSlowTool();
      await new CallSession(options).start();

      voiceAIEmitter.emit('event', { type: 'tool_call', call: { id: 'call-1', name: 'slow_tool', arguments: {} } } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalled();
      telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'callee hung up' });

      await vi.advanceTimersByTimeAsync(12_000); // past the old 9s cap, inside the tool's budget
      expect(order).not.toContain('status:ended');
      await vi.advanceTimersByTimeAsync(4_000); // 15s budget + 1s margin
      expect(order).toContain('status:ended');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('a tool with its own handler budget (handlerBudgetMs, #7)', () => {
    // transfer_to_owner cannot be cut off once its redirect is sent, so it
    // declares how long it may run; the watchdog and end()'s wait honor it.
    function sessionWithBudgetedTool(handlerBudgetMs: number) {
      const s = sessionWithSlowTool();
      s.options.tools = [{ ...s.options.tools[0]!, endsCall: true, handlerBudgetMs }];
      return s;
    }

    it('the tool-pending watchdog allows the declared budget, counted after the turn_end wait', async () => {
      vi.useFakeTimers();
      try {
        const { options, order, handler } = sessionWithBudgetedTool(60_000);
        await new CallSession(options).start();
        voiceAIEmitter.emit('event', { type: 'tool_call', call: { id: 'call-1', name: 'slow_tool', arguments: {} } } satisfies VoiceAIEvent);
        voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
        await vi.advanceTimersByTimeAsync(0);
        expect(handler).toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(59_000); // far past the default 15s
        expect(order).not.toContain('status:failed');
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(61_000 + 1_000); // fail() then waits out the in-flight budget
        expect(order).toContain('status:failed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('end() keeps waiting for it through TURN_END_WAIT_MS plus the declared budget', async () => {
      vi.useFakeTimers();
      try {
        const { telephony, options, order, handler, finish } = sessionWithBudgetedTool(60_000);
        await new CallSession(options).start();
        voiceAIEmitter.emit('event', { type: 'tool_call', call: { id: 'call-1', name: 'slow_tool', arguments: {} } } satisfies VoiceAIEvent);
        voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
        await vi.advanceTimersByTimeAsync(0);
        expect(handler).toHaveBeenCalled();
        telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'stop' });

        await vi.advanceTimersByTimeAsync(40_000); // past the default 15s + 1s margin
        expect(order).not.toContain('status:ended');
        finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(['status:started', 'handler finished', 'status:ended']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('a failure mid-tool also waits for the handler, so a booking still landing is recorded before "failed" (#3)', async () => {
    // A telephony error (or the tool-pending watchdog) during
    // confirm_appointment used to record 'failed' — and text a failure —
    // while the calendar write was still going.
    const { telephony, options, order, handler, finish } = sessionWithSlowTool();
    await new CallSession(options).start();

    voiceAIEmitter.emit('event', { type: 'tool_call', call: { id: 'call-1', name: 'slow_tool', arguments: {} } } satisfies VoiceAIEvent);
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    telephony.emit({ callId: callAttempt.id, type: 'error', error: new Error('media stream dropped') });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['status:started']);

    finish();
    await vi.waitFor(() => expect(order).toContain('status:failed'));
    expect(order).toEqual(['status:started', 'handler finished', 'status:failed']);
    await vi.waitFor(() => expect(options.notifyIfTerminal).toHaveBeenCalledTimes(1));
  });
});

describe('CallSession: a retryable Voice AI error is tolerated instead of killing the call', () => {
  // Regression coverage for a real live call (2026-09-01, callId d38b79ab):
  // the silence watchdog's nudge (voiceAI.triggerResponse()) collided with a
  // response OpenAI's own server-side VAD had already started, producing a
  // VoiceAIError with retryable: true ("conversation_already_has_active_response").
  // handleVoiceAIEvent's 'error' case previously called fail() unconditionally
  // for any error, tearing down a call that was actually fine.
  beforeEach(() => {
    voiceAIEmitter.removeAllListeners('event');
  });

  it('does not fail the call on a retryable Voice AI error — logs and continues', async () => {
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const session = new CallSession(options);
    await session.start();

    voiceAIEmitter.emit('event', {
      type: 'error',
      error: new VoiceAIError('conversation_already_has_active_response', true, 'conversation_already_has_active_response'),
    } satisfies VoiceAIEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(options.onStatusChange).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }));
    expect(telephony.provider.hangUp).not.toHaveBeenCalled();
    expect(fakeVoiceAI.disconnect).not.toHaveBeenCalled();
  });

  it('still fails the call on a non-retryable Voice AI error, unchanged from before', async () => {
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const session = new CallSession(options);
    await session.start();

    voiceAIEmitter.emit('event', {
      type: 'error',
      error: new VoiceAIError('fatal upstream failure', false),
    } satisfies VoiceAIEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(options.onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }));
    expect(telephony.provider.hangUp).toHaveBeenCalledTimes(1);
  });
});

describe('CallSession: silence watchdog does not nudge a response already known to be in flight', () => {
  // Second half of the same live-call bug's fix shape: the collision above
  // happened because the silence watchdog's nudge had no way to know a
  // response was already active. This covers the one case CallSession CAN
  // know about without an extra provider signal — a response it triggered
  // itself (the opening greeting) that hasn't reached turn_end yet.
  beforeEach(() => {
    voiceAIEmitter.removeAllListeners('event');
  });

  it('skips the nudge when the greeting response it triggered is still in flight', async () => {
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const options = { ...makeFakeCallSessionOptions(telephony.provider), greetOnConnect: true };
      const session = new CallSession(options);
      await session.start();

      telephony.emit({
        callId: callAttempt.id,
        type: 'connected',
        meta: { callId: callAttempt.id, providerCallId: 'CA-fake-sid', toNumber: '' },
      });
      await vi.advanceTimersByTimeAsync(500); // GREETING_DELAY_MS
      expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);

      // Caller talks over the still-in-progress greeting before it reaches
      // turn_end — arms the silence watchdog exactly as a normal user turn would.
      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: 'Hello?', isFinal: true } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(7000); // SILENCE_WATCHDOG_MS

      // Must not have sent a second triggerResponse() — that's the exact
      // collision that killed the real call.
      expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallSession: silence watchdog — the model going quiet after a user turn', () => {
  // Regression coverage for a real live call: after a finalized user
  // transcript ("I got to chill. I got to chill."), OpenAI's Realtime API
  // never emitted another response event of ANY kind — no audio, no
  // transcript, no error — for the rest of the call, even though the caller
  // kept talking and being transcribed correctly the whole time. Nothing on
  // our side ever noticed or tried to recover; the call just sat silent for
  // over a minute until the caller gave up and hung up. There was previously
  // no equivalent of toolPendingWatchdog for "the model stopped responding
  // to speech at all".
  //
  // voiceAIEmitter is a single module-level EventEmitter shared by every
  // test in this file, and no earlier test ever unsubscribes its session's
  // listener — harmless for tests that only assert on their own
  // freshly-created telephony mock, but fatal here since fakeVoiceAI (and
  // its triggerResponse spy) is the SAME shared singleton every session
  // uses. Without this, emitting an event here would also fire every
  // still-attached listener left over from every earlier test in the file.
  beforeEach(() => {
    voiceAIEmitter.removeAllListeners('event');
  });

  it('does not arm for a final user transcript the provider marks answered — a full-duplex model already replied before it went final', async () => {
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));
      await session.start();

      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: 'Sounds good.', isFinal: true, answered: true } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(7000 * 3); // SILENCE_WATCHDOG_MS, then the give-up window

      expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((session as any).silenceWatchdog).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  for (const [label, text] of [
    ['an empty', ''],
    ['a suspect (wrong-script hallucination)', 'ᱤᱠ'],
  ] as const) {
    it(`does not arm for ${label} final user transcript — nobody said anything, so there is nothing to answer (#25)`, async () => {
      vi.useFakeTimers();
      try {
        const telephony = makeFakeTelephony();
        const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));
        await session.start();

        voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text, isFinal: true } satisfies VoiceAIEvent);
        await vi.advanceTimersByTimeAsync(7000 * 3); // SILENCE_WATCHDOG_MS, then the give-up window

        expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((session as any).silenceWatchdog).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('nudges the model with an explicit response trigger if it stays silent for SILENCE_WATCHDOG_MS after a finalized user turn', async () => {
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));
      await session.start();

      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: 'I got to chill.', isFinal: true } satisfies VoiceAIEvent);
      expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(7000); // SILENCE_WATCHDOG_MS

      expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not nudge if the model actually starts responding (audio_chunk) before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));
      await session.start();

      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: 'Hello.', isFinal: true } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(3000);
      voiceAIEmitter.emit('event', {
        type: 'audio_chunk',
        chunk: { data: Buffer.alloc(80), sampleRate: 8000 },
      } satisfies VoiceAIEvent);

      await vi.advanceTimersByTimeAsync(7000); // SILENCE_WATCHDOG_MS from the transcript would have elapsed by now

      expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the model its arguments were malformed, rather than invalid, when the vendor payload did not parse', async () => {
    // A truncated arguments string arrives as `arguments: {}` plus
    // `unparsedArguments` — without the distinction, a cut-off message looks
    // exactly like a deliberate no-argument call, and the model gets told its
    // input was invalid rather than that it should send the call again.
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const handler = vi.fn(async () => ({ ok: true }));
    options.tools = [
      {
        name: 'check_my_availability',
        description: 'test-only availability tool',
        schema: z.object({ date: z.string(), time: z.string(), durationMinutes: z.number() }),
        handler,
      },
    ];
    const session = new CallSession(options);
    await session.start();

    voiceAIEmitter.emit('event', {
      type: 'tool_call',
      call: {
        id: 'call-1',
        name: 'check_my_availability',
        arguments: {},
        unparsedArguments: '{"date":"2026-09-22","time":"6:00pm',
      },
    } satisfies VoiceAIEvent);

    await vi.waitFor(() =>
      expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith(
        'call-1',
        expect.objectContaining({ ok: false, error: 'malformed_arguments' }),
        true,
      ),
    );
    // The handler must not run — we have no idea what was actually asked for.
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not nudge if the model responds via a tool_call rather than audio', async () => {
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const options = makeFakeCallSessionOptions(telephony.provider);
      options.tools = [{ name: 'noop_tool', description: 'test-only', schema: z.object({}), handler: vi.fn(async () => ({ ok: true })) }];
      const session = new CallSession(options);
      await session.start();

      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: 'Book it.', isFinal: true } satisfies VoiceAIEvent);
      voiceAIEmitter.emit('event', {
        type: 'tool_call',
        call: { id: 'call-1', name: 'noop_tool', arguments: {} },
      } satisfies VoiceAIEvent);

      await vi.advanceTimersByTimeAsync(7000); // SILENCE_WATCHDOG_MS

      expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('repeated finalized user transcripts while already armed do not push the deadline back — matches the real call, where the caller kept retrying every few seconds without ever resetting how long the model had already been silent', async () => {
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const session = new CallSession(makeFakeCallSessionOptions(telephony.provider));
      await session.start();

      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: 'I got to chill.', isFinal: true } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(5000);
      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: 'Keeping up with me?', isFinal: true } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(5000);
      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: "She's not saying anything.", isFinal: true } satisfies VoiceAIEvent);

      // 10s have elapsed since the FIRST finalized transcript — past the 7s
      // deadline — even though later transcripts kept arriving.
      expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up and fails the call if the model is still silent after the nudge itself goes unanswered', async () => {
    vi.useFakeTimers();
    try {
      const telephony = makeFakeTelephony();
      const options = makeFakeCallSessionOptions(telephony.provider);
      const session = new CallSession(options);
      await session.start();

      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: 'Hello?', isFinal: true } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(7000); // first window -> nudge
      expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(7000); // second window, still nothing -> give up

      expect(options.onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed', reason: 'assistant_silence_watchdog' }));
      expect(telephony.provider.hangUp).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallSession: every finalised line goes to onTranscript, numbered in arrival order (#6)', () => {
  beforeEach(() => {
    voiceAIEmitter.removeAllListeners('event');
  });

  async function startedSession() {
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const session = new CallSession(options);
    await session.start();
    return { session, options };
  }

  const say = (role: 'user' | 'assistant', text: string, isFinal = true) =>
    voiceAIEmitter.emit('event', { type: 'transcript', role, text, isFinal } satisfies VoiceAIEvent);

  it('passes seq, role, text, quality, provider and arrival time; seq counts across both sides', async () => {
    const { options } = await startedSession();
    say('user', "Claudia's, how can I help?");
    say('assistant', 'Hi, calling for Steve.');
    await vi.waitFor(() => expect(options.onTranscript).toHaveBeenCalledTimes(2));

    const calls = vi.mocked(options.onTranscript).mock.calls.map(([t]) => t);
    expect(calls[0]).toMatchObject({ seq: 1, role: 'user', text: "Claudia's, how can I help?", quality: 'ok', voiceProvider: 'fake-voice' });
    expect(calls[1]).toMatchObject({ seq: 2, role: 'assistant' });
    expect(calls[0]!.spokenAt).toBeInstanceOf(Date);
  });

  it('skips partial and empty lines without using up a seq number', async () => {
    const { options } = await startedSession();
    say('user', 'Claud', false);
    say('user', '   ');
    say('user', 'Hello?');
    await vi.waitFor(() => expect(options.onTranscript).toHaveBeenCalledTimes(1));
    expect(vi.mocked(options.onTranscript).mock.calls[0]![0]).toMatchObject({ seq: 1, text: 'Hello?' });
  });

  it('keeps suspect lines, marked as suspect (#25)', async () => {
    const { options } = await startedSession();
    say('user', 'ᱤᱠ');
    await vi.waitFor(() => expect(options.onTranscript).toHaveBeenCalledTimes(1));
    expect(vi.mocked(options.onTranscript).mock.calls[0]![0]).toMatchObject({ quality: 'suspect' });
  });

  it('a failed save never fails the call, and the next line is still recorded', async () => {
    const { options } = await startedSession();
    vi.mocked(options.onTranscript).mockRejectedValueOnce(new Error('db down'));
    say('user', 'First.');
    say('user', 'Second.');
    await vi.waitFor(() => expect(options.onTranscript).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(options.onFailure).not.toHaveBeenCalled();
    expect(vi.mocked(options.onTranscript).mock.calls[1]![0]).toMatchObject({ seq: 2, text: 'Second.' });
  });
});

describe("CallSession: reports whether the call opened by saying it's an AI (#8)", () => {
  beforeEach(() => {
    voiceAIEmitter.removeAllListeners('event');
  });

  async function endAfter(lines: { role: 'user' | 'assistant'; text: string }[]) {
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const session = new CallSession(options);
    await session.start();
    for (const { role, text } of lines) {
      voiceAIEmitter.emit('event', { type: 'transcript', role, text, isFinal: true } satisfies VoiceAIEvent);
    }
    await session.stop('test over');
    return vi.mocked(options.onStatusChange).mock.calls.map(([patch]) => patch).find((p) => p.kind === 'ended');
  }

  it('disclosed: Banjo\'s first line says AI', async () => {
    const ended = await endAfter([
      { role: 'user', text: "Claudia's, how can I help?" },
      { role: 'assistant', text: "Hi, I'm an AI assistant calling on behalf of Steve." },
    ]);
    expect(ended).toMatchObject({ kind: 'ended', disclosure: 'disclosed' });
  });

  it("missed: judged on Banjo's FIRST line, so saying it later when asked doesn't count", async () => {
    const ended = await endAfter([
      { role: 'assistant', text: "Hi, I'm calling on behalf of Steve." },
      { role: 'user', text: 'Am I talking to a real person?' },
      { role: 'assistant', text: "I'm an AI assistant." },
    ]);
    expect(ended).toMatchObject({ disclosure: 'missed' });
  });

  it('no_speech: Banjo never spoke', async () => {
    expect(await endAfter([])).toMatchObject({ disclosure: 'no_speech' });
  });
});

describe('CallSession: recording starts only after the recording notice has been heard (#8)', () => {
  // Live test, 2026-09-24: recording was started when the opener's TEXT went
  // final, 2s after "Hello?" — the model writes faster than it speaks, and
  // the recording's own audio showed Banjo still mid-opener, before "This
  // call is recorded." was heard. So: wait for the turn to end and its audio
  // to finish playing. Late is fine; early is the bug.
  beforeEach(() => {
    voiceAIEmitter.removeAllListeners('event');
  });

  async function session(recordCalls: boolean, startRecording = vi.fn(async () => ({ recordingId: 'RE1' }))) {
    const telephony = makeFakeTelephony();
    const provider = { ...telephony.provider, startRecording };
    const options = { ...makeFakeCallSessionOptions(provider), recordCalls };
    const s = new CallSession(options);
    await s.start();
    return { options, startRecording };
  }
  const emit = (event: VoiceAIEvent) => voiceAIEmitter.emit('event', event);
  const say = (role: 'user' | 'assistant', text: string) => emit({ type: 'transcript', role, text, isFinal: true });
  /** Banjo's speech on its way to the phone: 8 bytes per ms of mu-law. */
  const speak = (ms: number) => emit({ type: 'audio_chunk', chunk: { data: Buffer.alloc(ms * 8), sampleRate: 8000 } });

  it('waits for the turn to end AND its audio to finish playing, then starts once', async () => {
    vi.useFakeTimers();
    try {
      const { options, startRecording } = await session(true);
      say('user', "Claudia's, how can I help?");
      speak(6000); // a ~6s opener, queued to the phone
      say('assistant', "Hi, I'm an AI assistant calling on behalf of Steve. This call is recorded.");
      await vi.advanceTimersByTimeAsync(1000);
      expect(startRecording).not.toHaveBeenCalled(); // text is final, audio is still playing

      emit({ type: 'turn_end' });
      await vi.advanceTimersByTimeAsync(4000); // ~5s in: still playing
      expect(startRecording).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2000); // played out, plus the margin
      expect(startRecording).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(options.onStatusChange).toHaveBeenCalledWith({ kind: 'recording_started', recordingId: 'RE1' }),
      );

      say('assistant', 'We recorded a lot of rain this week.');
      emit({ type: 'turn_end' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(startRecording).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels if Banjo is interrupted before its turn ends — the notice may never have been heard', async () => {
    vi.useFakeTimers();
    try {
      const { startRecording } = await session(true);
      speak(6000);
      say('assistant', 'This call is recorded.');
      emit({ type: 'interrupted' });
      emit({ type: 'turn_end' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(startRecording).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never starts if Banjo never says the notice', async () => {
    vi.useFakeTimers();
    try {
      const { startRecording } = await session(true);
      say('assistant', "Hi, I'm an AI assistant calling on behalf of Steve.");
      emit({ type: 'turn_end' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(startRecording).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never starts with recording off', async () => {
    vi.useFakeTimers();
    try {
      const { startRecording } = await session(false);
      say('assistant', 'This call is recorded.');
      emit({ type: 'turn_end' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(startRecording).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed start is logged, not a failed call', async () => {
    vi.useFakeTimers();
    try {
      const { options } = await session(true, vi.fn(async () => { throw new Error('twilio 500'); }));
      say('assistant', 'This call is recorded.');
      emit({ type: 'turn_end' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(options.onFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallSession: while a call-ending tool is running, nothing else can end the call (#7 follow-up)', () => {
  // transfer_to_owner may wait ~74s on Twilio's redirect. A silence nudge, or
  // a second tool call such as end_call, used to be accepted meanwhile and
  // could hang up the call mid-transfer; it also replaced (then cleared) the
  // transfer's own tool-pending watchdog.
  beforeEach(() => {
    voiceAIEmitter.removeAllListeners('event');
  });

  function sessionWithTransferAndEndCall() {
    const telephony = makeFakeTelephony();
    const options = makeFakeCallSessionOptions(telephony.provider);
    const order: string[] = [];
    let finishTransfer!: (result: unknown) => void;
    const transferHandler = vi.fn(
      () =>
        new Promise((resolve) => {
          finishTransfer = resolve;
        }),
    );
    const endCallHandler = vi.fn(async () => {
      await telephony.provider.hangUp(callAttempt.id);
      return { ok: true };
    });
    const lookupHandler = vi.fn(async () => ({ ok: true }));
    options.tools = [
      { name: 'transfer_to_owner', description: 'test-only', schema: z.object({}), handler: transferHandler, endsCall: true, handlerBudgetMs: 60_000 },
      { name: 'end_call', description: 'test-only', schema: z.object({}), handler: endCallHandler, endsCall: true },
      { name: 'lookup', description: 'test-only', schema: z.object({}), handler: lookupHandler },
    ];
    vi.mocked(options.onStatusChange).mockImplementation(async (patch) => {
      order.push(`status:${patch.kind}`);
    });
    return { telephony, options, order, transferHandler, endCallHandler, lookupHandler, finishTransfer: (r: unknown) => finishTransfer(r) };
  }

  const toolCall = (id: string, name: string) =>
    voiceAIEmitter.emit('event', { type: 'tool_call', call: { id, name, arguments: {} } } satisfies VoiceAIEvent);

  it('refuses a second tool call, never runs its handler, and leaves the first tool\'s watchdog in charge', async () => {
    vi.useFakeTimers();
    try {
      const { telephony, options, order, transferHandler, endCallHandler } = sessionWithTransferAndEndCall();
      await new CallSession(options).start();
      toolCall('call-1', 'transfer_to_owner');
      voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(transferHandler).toHaveBeenCalled();

      toolCall('call-2', 'end_call');
      voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(endCallHandler).not.toHaveBeenCalled();
      expect(telephony.provider.hangUp).not.toHaveBeenCalled();
      expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('call-2', expect.objectContaining({ ok: false, error: 'call_ending' }), true);

      // Still the transfer's 60s budget, not a replacement 15s one (or none).
      await vi.advanceTimersByTimeAsync(50_000);
      expect(order).not.toContain('status:failed');
      await vi.advanceTimersByTimeAsync(10_000 + 61_000 + 1_000); // past the budget, then fail() waits out the in-flight handler
      expect(order).toContain('status:failed');
      expect(options.onFailure).toHaveBeenCalledWith('tool_pending_watchdog');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a non-ending tool call too, while the call-ending tool runs', async () => {
    vi.useFakeTimers();
    try {
      const { options, transferHandler, lookupHandler } = sessionWithTransferAndEndCall();
      await new CallSession(options).start();
      toolCall('call-1', 'transfer_to_owner');
      await vi.advanceTimersByTimeAsync(4_000); // TURN_END_WAIT_MS with no turn_end
      expect(transferHandler).toHaveBeenCalled();

      toolCall('call-2', 'lookup');
      await vi.advanceTimersByTimeAsync(0);
      expect(lookupHandler).not.toHaveBeenCalled();
      expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('call-2', expect.objectContaining({ ok: false, error: 'call_ending' }), true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not nudge or give up on silence while the call-ending tool runs', async () => {
    vi.useFakeTimers();
    try {
      const { options, order, transferHandler } = sessionWithTransferAndEndCall();
      const session = new CallSession(options);
      await session.start();
      toolCall('call-1', 'transfer_to_owner');
      voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(transferHandler).toHaveBeenCalled();

      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: 'Hello? Are you still there?', isFinal: true } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(7000 * 3); // SILENCE_WATCHDOG_MS, then the give-up window, and more

      expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
      expect(order).not.toContain('status:failed');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((session as any).silenceWatchdog).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('after the call-ending tool fails with the call still live, accepts the next tool call and handles silence again', async () => {
    vi.useFakeTimers();
    try {
      const { telephony, options, order, transferHandler, endCallHandler, finishTransfer } = sessionWithTransferAndEndCall();
      await new CallSession(options).start();
      toolCall('call-1', 'transfer_to_owner');
      voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(transferHandler).toHaveBeenCalled();

      finishTransfer({ ok: false, error: 'transfer_failed' });
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('call-1', { ok: false, error: 'transfer_failed' }, false);

      // Silence handling is back.
      voiceAIEmitter.emit('event', { type: 'transcript', role: 'user', text: 'Hello?', isFinal: true } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(7000); // SILENCE_WATCHDOG_MS
      expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);

      // And the model can end the call the way the prompt tells it to.
      toolCall('call-2', 'end_call');
      voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(endCallHandler).toHaveBeenCalledTimes(1);
      expect(telephony.provider.hangUp).toHaveBeenCalledWith(callAttempt.id);
      expect(order).not.toContain('status:failed');
    } finally {
      vi.useRealTimers();
    }
  });
});
