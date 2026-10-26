import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSessionOptions } from '../../src/session/callSession.js';
import type { CallContext } from '../../src/session/types.js';
import type { TelephonyEvent, TelephonyProvider } from '../../src/telephony/providers/types.js';
import type { AnswerVerdict, VoiceAIEvent, VoiceAIProvider } from '../../src/voice/types.js';
import { answerNote } from '../../src/session/answerCheck.js';

// Who answered (#187): the other party's first line judged out of band, the
// verdict recorded, and a voicemail or phone menu steered with a fixed note.
// Never a gate: nothing is refused or hung up on a verdict.
const voiceAIEmitter = new EventEmitter();
const fakeVoiceAI = {
  name: 'fake-voice',
  connect: vi.fn(async () => {}),
  sendAudioChunk: vi.fn(),
  sendToolResult: vi.fn(),
  interrupt: vi.fn(),
  triggerResponse: vi.fn(),
  sayVerbatim: vi.fn(),
  addContext: vi.fn(),
  judgeFirstLine: vi.fn(async (_line: string, _earlier: string[]) => 'human' as AnswerVerdict),
  disconnect: vi.fn(async () => {}),
  on: vi.fn((_event: 'event', listener: (e: VoiceAIEvent) => void) => voiceAIEmitter.on('event', listener)),
  off: vi.fn((_event: 'event', listener: (e: VoiceAIEvent) => void) => voiceAIEmitter.off('event', listener)),
} satisfies VoiceAIProvider;

vi.mock('../../src/voice/factory.js', () => ({ createVoiceAIProvider: () => fakeVoiceAI }));

const { CallSession } = await import('../../src/session/callSession.js');

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
    tools: [],
    openingLine: "Hi, I'm an AI assistant calling on behalf of Alex.",
    pickupLine: "Hi, I'm an AI assistant calling on behalf of Alex.",
    beginCall: vi.fn(async () => ({ providerCallId: 'CA-1' })),
    buildToolContext: vi.fn(async () => ({}) as CallContext),
    onStatusChange: vi.fn(async () => {}),
    onFailure: vi.fn(async () => {}),
    notifyIfTerminal: vi.fn(async () => {}),
    onTranscript: vi.fn(async () => {}),
    judgeFirstLine: true,
    ...overrides,
  };
  const emitTelephony = (e: TelephonyEvent) => emitter.emit('event', e);
  return { options, telephony, emitTelephony };
}

const voice = (e: VoiceAIEvent) => voiceAIEmitter.emit('event', e);
const heard = (text: string) => voice({ type: 'transcript', role: 'user', text, isFinal: true });

async function answered(overrides: Partial<CallSessionOptions> = {}) {
  const s = setup(overrides);
  const session = new CallSession(s.options);
  await session.start();
  s.emitTelephony({ callId: 'call-1', type: 'connected', meta: { callId: 'call-1', providerCallId: 'CA-1', toNumber: '+15555550100' } });
  return { ...s, session };
}

const judged = (options: CallSessionOptions) =>
  (options.onStatusChange as ReturnType<typeof vi.fn>).mock.calls.map(([p]) => p).filter((p) => p.kind === 'answer_judged');

beforeEach(() => {
  vi.clearAllMocks();
  voiceAIEmitter.removeAllListeners();
  fakeVoiceAI.judgeFirstLine.mockImplementation(async () => 'human');
});

describe('answerNote', () => {
  it('steers only a voicemail, to the verbatim message tool, with fixed text', () => {
    expect(answerNote('voicemail')).toMatch(/leave_voicemail_and_end_call/);
    expect(answerNote('voicemail')).toMatch(/If a person speaks/);
    // Tried, and it made Banjo press a menu's Spanish option (menu-on-hold 0/3).
    expect(answerNote('ivr')).toBeUndefined();
    expect(answerNote('human')).toBeUndefined();
    expect(answerNote('uncertain')).toBeUndefined();
  });
});

describe('judging who answered (#187)', () => {
  it('judges the first line they say and records the verdict, with how long it took', async () => {
    const { options } = await answered();
    heard('Hi, this is Dana at Claudia’s, how can I help you?');

    await vi.waitFor(() => expect(judged(options)).toHaveLength(1));
    expect(fakeVoiceAI.judgeFirstLine).toHaveBeenCalledWith('Hi, this is Dana at Claudia’s, how can I help you?', []);
    expect(judged(options)[0]).toEqual({ kind: 'answer_judged', verdict: 'human', latencyMs: expect.any(Number), banjoSpokeFirst: false });
    expect(fakeVoiceAI.addContext).not.toHaveBeenCalled();
  });

  it('adds a fixed note for a voicemail, without prompting a reply or ending anything', async () => {
    fakeVoiceAI.judgeFirstLine.mockImplementation(async () => 'voicemail');
    const { options, telephony } = await answered();
    heard("You've reached the voicemail of 202-555-0101. Please leave a message after the tone.");

    await vi.waitFor(() => expect(fakeVoiceAI.addContext).toHaveBeenCalledWith([{ role: 'system', text: answerNote('voicemail') }]));
    expect(judged(options)[0]).toMatchObject({ verdict: 'voicemail' });
    expect(fakeVoiceAI.triggerResponse).not.toHaveBeenCalled();
    expect(telephony.hangUp).not.toHaveBeenCalled();
  });

  it('judges a second line, with the first as context, when the first was unclear, and stops there', async () => {
    fakeVoiceAI.judgeFirstLine.mockImplementationOnce(async () => 'uncertain').mockImplementationOnce(async () => 'ivr');
    const { options } = await answered();
    heard('Thank you for calling Northline Cable.');
    await vi.waitFor(() => expect(judged(options)).toHaveLength(1));
    heard('For billing, press 1. For technical support, press 2.');
    await vi.waitFor(() => expect(judged(options)).toHaveLength(2));
    heard('Para español, oprima nueve.');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fakeVoiceAI.judgeFirstLine).toHaveBeenCalledTimes(2);
    expect(fakeVoiceAI.judgeFirstLine).toHaveBeenLastCalledWith('For billing, press 1. For technical support, press 2.', ['Thank you for calling Northline Cable.']);
    expect(judged(options).map((p) => p.verdict)).toEqual(['uncertain', 'ivr']);
    expect(fakeVoiceAI.addContext).not.toHaveBeenCalled();
  });

  it('judges one line at a time: a line heard while the first is out is not judged', async () => {
    let finish: (v: AnswerVerdict) => void = () => {};
    fakeVoiceAI.judgeFirstLine.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { options } = await answered();
    heard('Hello?');
    heard('Hello, anyone there?');
    finish('human');

    await vi.waitFor(() => expect(judged(options)).toHaveLength(1));
    expect(fakeVoiceAI.judgeFirstLine).toHaveBeenCalledTimes(1);
  });

  it('says whether Banjo had already spoken when the verdict came back', async () => {
    let finish: (v: AnswerVerdict) => void = () => {};
    fakeVoiceAI.judgeFirstLine.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { options } = await answered();
    heard('Hello?');
    voice({ type: 'transcript', role: 'assistant', text: "Hi, I'm an AI assistant calling on behalf of Alex.", isFinal: true });
    finish('human');

    await vi.waitFor(() => expect(judged(options)).toHaveLength(1));
    expect(judged(options)[0]).toMatchObject({ banjoSpokeFirst: true });
  });

  it('is off unless the session asks for it, and skipped for a provider that cannot judge', async () => {
    const { options } = await answered({ judgeFirstLine: false });
    heard('Hello?');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fakeVoiceAI.judgeFirstLine).not.toHaveBeenCalled();
    expect(judged(options)).toHaveLength(0);

    const judge = fakeVoiceAI.judgeFirstLine;
    delete (fakeVoiceAI as Partial<typeof fakeVoiceAI>).judgeFirstLine;
    try {
      const second = await answered();
      heard('Hello?');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(judged(second.options)).toHaveLength(0);
    } finally {
      fakeVoiceAI.judgeFirstLine = judge;
    }
  });
});
