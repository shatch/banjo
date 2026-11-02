import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CallSessionOptions } from '../../src/session/callSession.js';
import type { CallContext } from '../../src/session/types.js';
import type { TelephonyEvent, TelephonyProvider } from '../../src/telephony/providers/types.js';
import type { HoldVerdict, VoiceAIEvent, VoiceAIProvider } from '../../src/voice/types.js';
import { defineVoiceTool } from '../../src/voice/tools/defineVoiceTool.js';
import { holdBudgetMs, isRepeatOnHold, menuPromptNote, personPickedUpNote, voicemailOnHoldNote } from '../../src/session/hold.js';

// Waiting on hold (#151), at the VoiceAIProvider/TelephonyProvider boundary,
// like tests/session/callSession.test.ts, with a voice provider that can hold.
const voiceAIEmitter = new EventEmitter();
const fakeVoiceAI = {
  name: 'fake-voice',
  maxSessionMs: 60 * 60_000 as number | undefined,
  connect: vi.fn(async () => {}),
  sendAudioChunk: vi.fn(),
  sendToolResult: vi.fn(),
  interrupt: vi.fn(),
  triggerResponse: vi.fn(),
  sayVerbatim: vi.fn(),
  setHold: vi.fn(),
  addContext: vi.fn(),
  judgeHoldLine: vi.fn(async (_line: string, _earlier: string[]) => 'recording' as HoldVerdict),
  disconnect: vi.fn(async () => {}),
  on: vi.fn((_event: 'event', listener: (e: VoiceAIEvent) => void) => voiceAIEmitter.on('event', listener)),
  off: vi.fn((_event: 'event', listener: (e: VoiceAIEvent) => void) => voiceAIEmitter.off('event', listener)),
} satisfies VoiceAIProvider;

vi.mock('../../src/voice/factory.js', () => ({ createVoiceAIProvider: () => fakeVoiceAI }));

const { CallSession } = await import('../../src/session/callSession.js');

const waitOnHold = defineVoiceTool({ name: 'wait_on_hold', description: 'hold', schema: z.object({}), startsHold: true, handler: async () => ({ ok: true }) });

function setup(overrides: Partial<CallSessionOptions> = {}) {
  const emitter = new EventEmitter();
  const telephony: TelephonyProvider = {
    name: 'fake-telephony',
    nativeAudioFormat: 'g711_ulaw_8k',
    originateCall: vi.fn(async () => ({ providerCallId: 'CA-1' })),
    sendAudio: vi.fn(),
    sendDigits: vi.fn(async () => {}),
    interrupt: vi.fn(),
    hangUp: vi.fn(async () => {}),
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
  };
  const options: CallSessionOptions = {
    callId: 'call-1',
    telephony,
    systemPrompt: 'irrelevant',
    tools: [waitOnHold],
    openingLine: "Hi, I'm an AI assistant calling on behalf of Alex. This call is recorded.",
    pickupLine: "Hi, I'm an AI assistant calling on behalf of Alex.",
    beginCall: vi.fn(async () => ({ providerCallId: 'CA-1' })),
    buildToolContext: vi.fn(async () => ({}) as CallContext),
    onStatusChange: vi.fn(async () => {}),
    onFailure: vi.fn(async () => {}),
    notifyIfTerminal: vi.fn(async () => {}),
    onTranscript: vi.fn(async () => {}),
    onHoldChange: vi.fn(async () => {}),
    onHoldLimit: vi.fn(async () => {}),
    maxHoldMs: 5 * 60_000,
    ...overrides,
  };
  const emitTelephony = (e: TelephonyEvent) => emitter.emit('event', e);
  return { options, telephony, emitTelephony };
}

const voice = (e: VoiceAIEvent) => voiceAIEmitter.emit('event', e);
const heard = (text: string) => voice({ type: 'transcript', role: 'user', text, isFinal: true });

async function onHold(overrides: Partial<CallSessionOptions> = {}) {
  const s = setup(overrides);
  const session = new CallSession(s.options);
  await session.start();
  s.emitTelephony({ callId: 'call-1', type: 'connected', meta: { callId: 'call-1', providerCallId: 'CA-1', toNumber: '+15555550100' } });
  voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
  await vi.waitFor(() => expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(true));
  return { ...s, session };
}

beforeEach(() => {
  vi.clearAllMocks();
  voiceAIEmitter.removeAllListeners();
  fakeVoiceAI.maxSessionMs = 60 * 60_000;
  fakeVoiceAI.judgeHoldLine.mockImplementation(async () => 'recording');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('isRepeatOnHold', () => {
  it('skips a line that repeats one already heard, allowing for transcription differences', () => {
    const before = ['Your call is important to us. Please stay on the line.'];
    expect(isRepeatOnHold('your call is important to us, please stay on the line', before)).toBe(true);
    expect(isRepeatOnHold('Your call is important to us. Please stay on the line and hold.', before)).toBe(true);
  });

  it("never skips a person picking up: they say something new", () => {
    const before = ['Your call is important to us. Please stay on the line.', 'Please hold.'];
    expect(isRepeatOnHold('Thanks for holding, this is Dana. How can I help?', before)).toBe(false);
    expect(isRepeatOnHold('Hello?', before)).toBe(false);
  });

  it('skips a line with no words in it', () => {
    expect(isRepeatOnHold('...', [])).toBe(true);
  });
});

describe('holdBudgetMs', () => {
  const base = { maxHoldMs: 20 * 60_000, now: 0, sessionStartedAt: 0, maxSessionMs: 60 * 60_000, reserveMs: 10 * 60_000 };
  it("is the call's limit when the session has room", () => {
    expect(holdBudgetMs(base)).toBe(20 * 60_000);
  });
  it('is cut short to leave the session time to talk in', () => {
    expect(holdBudgetMs({ ...base, now: 40 * 60_000 })).toBe(10 * 60_000);
    expect(holdBudgetMs({ ...base, now: 55 * 60_000 })).toBeLessThanOrEqual(0);
  });
  it('is just the limit for a provider with no known session length', () => {
    expect(holdBudgetMs({ ...base, maxSessionMs: undefined, now: 500 * 60_000 })).toBe(20 * 60_000);
  });
});

describe('personPickedUpNote', () => {
  it('has Banjo open again with the disclosure, and is fixed text', () => {
    const note = personPickedUpNote("Hi, I'm an AI assistant calling on behalf of Alex.");
    expect(note).toContain(`Your first sentence must be: "Hi, I'm an AI assistant calling on behalf of Alex."`);
    expect(note).toContain('wait_on_hold again');
  });
});

describe('menuPromptNote', () => {
  it('hands the turn back to answer a phone menu, with no disclosure, and is fixed text', () => {
    const note = menuPromptNote();
    expect(note).toContain('press_digits');
    expect(note).toContain('wait_on_hold');
    expect(note).not.toContain('AI assistant');
    expect(note).not.toMatch(/"[^"]+"/); // quotes nothing for the model to repeat (#154)
  });
});

describe('voicemailOnHoldNote', () => {
  it('steers to the voicemail tool, leaves room for a person, and is fixed text', () => {
    const note = voicemailOnHoldNote();
    expect(note).toContain('leave_voicemail_and_end_call');
    expect(note).toContain('person speaks');
    expect(note).not.toMatch(/"[^"]+"/);
  });
});

describe('CallSession on hold (#151)', () => {
  it('goes on hold silently: no reply to the tool result, and the owner is told the limit', async () => {
    const { options } = await onHold();
    expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-1', { ok: true }, false, { respond: false });
    expect(options.onHoldChange).toHaveBeenCalledWith({ kind: 'started', maxMs: 5 * 60_000 });
  });

  it("never nudges the model on hold, however long it's quiet", async () => {
    vi.useFakeTimers();
    await onHold();
    heard('Please hold.');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
  });

  it('judges each new line once, with what came before, and skips repeats', async () => {
    await onHold();
    heard('Please hold. Your call is important to us.');
    await vi.waitFor(() => expect(fakeVoiceAI.judgeHoldLine).toHaveBeenCalledTimes(1));
    heard('please hold, your call is important to us');
    heard('The estimated wait time is five minutes.');
    await vi.waitFor(() => expect(fakeVoiceAI.judgeHoldLine).toHaveBeenCalledTimes(2));
    expect(fakeVoiceAI.judgeHoldLine).toHaveBeenLastCalledWith('The estimated wait time is five minutes.', ['Please hold. Your call is important to us.']);
    expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
    expect(fakeVoiceAI.setHold).not.toHaveBeenCalledWith(false);
  });

  it('judges only the latest of the lines that arrive while a judgment is out', async () => {
    let finish!: (v: HoldVerdict) => void;
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await onHold();
    heard('Please hold.');
    heard('Press 1 to leave a callback number.');
    heard('Our hours are nine to five.');
    finish('recording');
    await vi.waitFor(() => expect(fakeVoiceAI.judgeHoldLine).toHaveBeenCalledTimes(2));
    expect(fakeVoiceAI.judgeHoldLine).toHaveBeenLastCalledWith('Our hours are nine to five.', ['Please hold.']);
  });

  it('a person picks up: off hold, the owner is told, and Banjo opens to them with the disclosure', async () => {
    const { options } = await onHold();
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(async () => 'person');
    heard('Thanks for holding, this is Dana. How can I help?');

    await vi.waitFor(() => expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(false));
    // Their words as a user line after a fixed note, never inside instructions:
    // a cue would replace the session's instructions and quote them there.
    expect(fakeVoiceAI.addContext).toHaveBeenCalledWith([
      { role: 'system', text: personPickedUpNote(options.pickupLine) },
      { role: 'user', text: 'Thanks for holding, this is Dana. How can I help?' },
    ]);
    expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledWith();
    expect(options.onHoldChange).toHaveBeenCalledWith({ kind: 'person', waitedMs: expect.any(Number) });
    // Off hold, lines go to the model as usual, not to the judge.
    heard('Hello?');
    expect(fakeVoiceAI.judgeHoldLine).toHaveBeenCalledTimes(1);
  });

  it('a phone menu asking for input: off hold, and Banjo answers it, with no reopening and no owner message', async () => {
    const { options } = await onHold();
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(async () => 'menu');
    heard("I found an account at street number 42. Is this the account you're calling about?");

    await vi.waitFor(() => expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(false));
    expect(fakeVoiceAI.addContext).toHaveBeenCalledWith([
      { role: 'system', text: menuPromptNote() },
      { role: 'user', text: "I found an account at street number 42. Is this the account you're calling about?" },
    ]);
    expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);
    expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledWith();
    expect(options.onHoldChange).toHaveBeenCalledWith({ kind: 'menu' });
    expect(options.onHoldChange).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'person' }));
    // Off hold, lines go to the model as usual, not to the judge.
    heard('Say yes or no.');
    expect(fakeVoiceAI.judgeHoldLine).toHaveBeenCalledTimes(1);
  });

  // #238: a screen's "stay on the line" ended in "leave a message", and Banjo sat silent through it.
  it('a voicemail greeting on hold: off hold, and Banjo is handed the turn to leave its message, with no owner message', async () => {
    const { options } = await onHold();
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(async () => 'voicemail');
    heard("Sorry, this person isn't available. Please leave a message after the tone.");

    await vi.waitFor(() => expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(false));
    expect(fakeVoiceAI.addContext).toHaveBeenCalledWith([
      { role: 'system', text: voicemailOnHoldNote() },
      { role: 'user', text: "Sorry, this person isn't available. Please leave a message after the tone." },
    ]);
    expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);
    expect(options.onHoldChange).toHaveBeenCalledWith({ kind: 'voicemail' });
    expect(options.onHoldChange).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'person' }));
  });

  it('after a menu hands the turn back, Banjo can wait on hold again', async () => {
    await onHold();
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(async () => 'menu');
    heard('If this is not the account, say no or press 2. Otherwise, please remain on the line.');
    await vi.waitFor(() => expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(false));

    voice({ type: 'tool_call', call: { id: 'hold-2', name: 'wait_on_hold', arguments: {} } });
    await vi.waitFor(() => expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-2', { ok: true }, false, { respond: false }));
    expect(fakeVoiceAI.setHold).toHaveBeenLastCalledWith(true);
  });

  it('the limit runs out: recorded, then the call ends', async () => {
    vi.useFakeTimers();
    const { options, telephony } = await onHold({ maxHoldMs: 60_000 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(options.onHoldLimit).toHaveBeenCalledWith(60_000);
    expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(telephony.hangUp).toHaveBeenCalled());
    expect(options.onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ended', reason: 'hold_limit' }));
  });

  it('the other party hanging up ends the hold, and a late judgment changes nothing', async () => {
    let finish!: (v: HoldVerdict) => void;
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { options, emitTelephony } = await onHold();
    heard('Please hold.');
    emitTelephony({ callId: 'call-1', type: 'ended', reason: 'stop' });
    await vi.waitFor(() => expect(options.onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ended' })));
    finish('person');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
    expect(options.onHoldLimit).not.toHaveBeenCalled();
  });

  it('refuses a hold with no session time left to talk in afterwards, and stays off hold', async () => {
    fakeVoiceAI.maxSessionMs = 5 * 60_000; // less than the 10 minutes kept back
    const s = setup();
    await new CallSession(s.options).start();
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.waitFor(() => expect(fakeVoiceAI.sendToolResult).toHaveBeenCalled());
    expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-1', expect.objectContaining({ ok: false, error: 'hold_unavailable' }), true);
    expect(fakeVoiceAI.setHold).not.toHaveBeenCalled();
  });

  it('refuses a second hold while already holding', async () => {
    await onHold();
    voice({ type: 'tool_call', call: { id: 'hold-2', name: 'wait_on_hold', arguments: {} } });
    await vi.waitFor(() =>
      expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-2', expect.objectContaining({ error: 'already_on_hold' }), true),
    );
  });
});

describe('recording consent on hold: nothing is recorded after a hold (#151, #8)', () => {
  const NOTICE_LINE = "Hi, I'm an AI assistant calling on behalf of Alex. This call is recorded.";

  /** A recorded call: the notice was said, its turn ended, and (with `started`) the recording's start timer fired. */
  async function recordedCall(telephonyOverrides: Partial<TelephonyProvider> = {}, started = true) {
    vi.useFakeTimers();
    const s = setup({ recordCalls: true });
    Object.assign(s.telephony, {
      startRecording: vi.fn(async () => ({ recordingId: 'RE-1' })),
      stopRecording: vi.fn(async () => {}),
      ...telephonyOverrides,
    });
    await new CallSession(s.options).start();
    s.emitTelephony({ callId: 'call-1', type: 'connected', meta: { callId: 'call-1', providerCallId: 'CA-1', toNumber: '+15555550100' } });
    voice({ type: 'transcript', role: 'assistant', text: NOTICE_LINE, isFinal: true });
    voice({ type: 'turn_end' });
    if (started) {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(s.telephony.startRecording).toHaveBeenCalledTimes(1);
    }
    return s;
  }

  /** On hold, a person picks up (or a menu asks for input), and Banjo says the notice, twice for good measure. */
  async function holdThenNoticeAgain(verdict: HoldVerdict = 'person') {
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.advanceTimersByTimeAsync(1_000);
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(async () => verdict);
    heard(verdict === 'person' ? 'This is Dana.' : 'Is this the account you are calling about?');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 2; i++) {
      voice({ type: 'transcript', role: 'assistant', text: NOTICE_LINE, isFinal: true });
      voice({ type: 'turn_end' });
      await vi.advanceTimersByTimeAsync(1_000);
    }
  }

  it('stops a running recording before the hold, and never records again on that call', async () => {
    const s = await recordedCall();
    await holdThenNoticeAgain();
    expect(s.telephony.stopRecording).toHaveBeenCalledTimes(1);
    expect((s.telephony.stopRecording as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      fakeVoiceAI.setHold.mock.invocationCallOrder[0]!,
    );
    expect(s.telephony.startRecording).toHaveBeenCalledTimes(1);
  });

  it('a menu handing the turn back never restarts the recording either', async () => {
    const s = await recordedCall();
    await holdThenNoticeAgain('menu');
    expect(s.telephony.stopRecording).toHaveBeenCalledTimes(1);
    expect(s.telephony.startRecording).toHaveBeenCalledTimes(1);
  });

  it('calls off a recording only scheduled when the hold began, for good, and still stops anything running', async () => {
    const s = await recordedCall({}, false);
    await holdThenNoticeAgain();
    expect(s.telephony.startRecording).not.toHaveBeenCalled();
    // Stopped regardless of what Banjo thinks is running.
    expect(s.telephony.stopRecording).toHaveBeenCalledTimes(1);
  });

  it('a call put on hold before any notice is never recorded either', async () => {
    vi.useFakeTimers();
    const s = setup({ recordCalls: true });
    Object.assign(s.telephony, { startRecording: vi.fn(async () => ({ recordingId: 'RE-1' })), stopRecording: vi.fn(async () => {}) });
    await new CallSession(s.options).start();
    s.emitTelephony({ callId: 'call-1', type: 'connected', meta: { callId: 'call-1', providerCallId: 'CA-1', toNumber: '+15555550100' } });
    await holdThenNoticeAgain();
    expect(s.telephony.startRecording).not.toHaveBeenCalled();
    expect(s.telephony.stopRecording).toHaveBeenCalledTimes(1);
  });

  it('an unrecorded call has nothing to stop, and holds as usual', async () => {
    const s = setup();
    Object.assign(s.telephony, { stopRecording: vi.fn(async () => {}) });
    await new CallSession(s.options).start();
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.waitFor(() => expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(true));
    expect(s.telephony.stopRecording).not.toHaveBeenCalled();
  });

  it('a stop waits for a start still in flight, so it stops the recording that start made', async () => {
    let finishStart!: () => void;
    const order: string[] = [];
    const s = await recordedCall(
      {
        startRecording: vi.fn(() => new Promise<{ recordingId: string }>((resolve) => (finishStart = () => (order.push('start'), resolve({ recordingId: 'RE-1' }))))),
        stopRecording: vi.fn(async () => void order.push('stop')),
      },
      false,
    );
    await vi.advanceTimersByTimeAsync(1_000); // the start timer fires; the start is in flight
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.telephony.stopRecording).not.toHaveBeenCalled();
    finishStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['start', 'stop']);
    expect(fakeVoiceAI.setHold).toHaveBeenCalledWith(true);
  });

  it('fails closed: no hold if a running recording cannot be stopped', async () => {
    await recordedCall({ stopRecording: vi.fn(async () => { throw new Error('twilio 500'); }) });
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-1', expect.objectContaining({ ok: false, error: 'hold_unavailable' }), true);
    expect(fakeVoiceAI.setHold).not.toHaveBeenCalled();
  });

  it('no hold starts if the call ended while the recording was being stopped', async () => {
    let finishStop!: () => void;
    const s = await recordedCall({ stopRecording: vi.fn(() => new Promise<void>((resolve) => (finishStop = resolve))) });
    voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
    await vi.advanceTimersByTimeAsync(0);
    s.emitTelephony({ callId: 'call-1', type: 'ended', reason: 'stop' });
    finishStop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fakeVoiceAI.setHold).not.toHaveBeenCalledWith(true);
    expect(s.options.onHoldChange).not.toHaveBeenCalled();
  });
});

describe('waiting on hold needs every hold method', () => {
  it('refuses on a provider that cannot add context', async () => {
    const addContext = fakeVoiceAI.addContext;
    // @ts-expect-error removed for this test only
    delete fakeVoiceAI.addContext;
    try {
      const s = setup();
      await new CallSession(s.options).start();
      voice({ type: 'tool_call', call: { id: 'hold-1', name: 'wait_on_hold', arguments: {} } });
      await vi.waitFor(() => expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('hold-1', expect.objectContaining({ error: 'hold_unsupported' }), true));
    } finally {
      fakeVoiceAI.addContext = addContext;
    }
  });
});

describe('relayOwnerNote: an answer from the owner during the call (ask_owner)', () => {
  it('adds the note and prompts a reply, once any reply in progress has finished', async () => {
    const s = setup();
    const session = new CallSession(s.options);
    await session.start();
    s.emitTelephony({ callId: 'call-1', type: 'connected', meta: { callId: 'call-1', providerCallId: 'CA-1', toNumber: '+15555550100' } });
    // Banjo is mid-reply.
    voice({ type: 'audio_chunk', chunk: { data: Buffer.alloc(80), sampleRate: 8000 } });
    const relayed = session.relayOwnerNote('Alex answered: the gate code is 1234.');
    await new Promise((r) => setTimeout(r, 10));
    expect(fakeVoiceAI.addContext).not.toHaveBeenCalled();
    voice({ type: 'turn_end' });
    expect(await relayed).toBe(true);
    expect(fakeVoiceAI.addContext).toHaveBeenCalledWith([{ role: 'system', text: 'Alex answered: the gate code is 1234.' }]);
    expect(fakeVoiceAI.triggerResponse).toHaveBeenCalledTimes(1);
  });

  it('on hold, keeps the note silent until the hold ends, then adds it before the pickup note', async () => {
    const { options, session } = await onHold();
    expect(await session.relayOwnerNote('Alex answered: yes.')).toBe(true);
    expect(fakeVoiceAI.addContext).not.toHaveBeenCalled();
    expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
    fakeVoiceAI.judgeHoldLine.mockImplementationOnce(async () => 'person');
    heard('Hi, this is Dana.');
    await vi.waitFor(() => expect(fakeVoiceAI.addContext).toHaveBeenCalled());
    expect(fakeVoiceAI.addContext).toHaveBeenCalledWith([
      { role: 'system', text: 'Alex answered: yes.' },
      { role: 'system', text: personPickedUpNote(options.pickupLine) },
      { role: 'user', text: 'Hi, this is Dana.' },
    ]);
  });

  it('reports false once the call has ended', async () => {
    const { session } = await onHold();
    await session.stop('owner stopped it');
    expect(await session.relayOwnerNote('too late')).toBe(false);
  });
});
