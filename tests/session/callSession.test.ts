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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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

      expect(options.onStatusChange).toHaveBeenCalledWith({ kind: 'failed', reason: 'assistant_silence_watchdog' });
      expect(telephony.provider.hangUp).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
