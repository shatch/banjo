import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { RecordingVoiceAI } from '../../src/evals/recorder.js';
import type { TextVoiceAIProvider } from '../../src/sim/simCall.js';
import type { VoiceAIEvent, VoiceAIEventListener } from '../../src/voice/types.js';

const OPTIONAL = ['addContext', 'setHold', 'judgeHoldLine', 'judgeFirstLine', 'verbatimDeliveryReport', 'usageTotals'] as const;

/** A text voice session; `full` also has every optional method, as OpenAI Realtime does. */
function inner(full: boolean) {
  const emitter = new EventEmitter();
  const base: Record<string, unknown> = {
    name: 'fake',
    marksVerbatimTurns: false,
    emitsInterruptions: true,
    connect: async () => {},
    sendAudioChunk: () => {},
    sendUserText: (text: string) => {
      emitter.emit('event', { type: 'transcript', role: 'assistant', text: `re: ${text}`, isFinal: true } satisfies VoiceAIEvent);
      emitter.emit('event', { type: 'tool_call', call: { id: 't1', name: 'end_call', arguments: {} } } satisfies VoiceAIEvent);
    },
    sendToolResult: () => {},
    interrupt: () => {},
    triggerResponse: () => {},
    sayVerbatim: () => {},
    disconnect: async () => {},
    on: (_: 'event', l: VoiceAIEventListener) => emitter.on('event', l),
    off: (_: 'event', l: VoiceAIEventListener) => emitter.off('event', l),
  };
  if (full) {
    Object.assign(base, {
      addContext: () => {},
      setHold: () => {},
      judgeHoldLine: async () => 'menu',
      judgeFirstLine: async () => 'voicemail',
      verbatimDeliveryReport: () => ({ intended: 'Bye!', spoken: 'Bye!', matched: true }),
      usageTotals: () => ({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 }),
    });
  }
  return base as unknown as TextVoiceAIProvider;
}

describe('RecordingVoiceAI', () => {
  it.each([true, false])('exposes each optional method exactly when the inner provider has it (full: %s)', (full) => {
    const wrapped = inner(full);
    const rec = new RecordingVoiceAI(wrapped);
    for (const method of OPTIONAL) expect(method in rec, method).toBe(method in wrapped);
  });

  it("copies the inner provider's flags", () => {
    const rec = new RecordingVoiceAI(inner(false));
    expect(rec.marksVerbatimTurns).toBe(false);
    expect(rec.emitsInterruptions).toBe(true);
    expect(rec.maxSessionMs).toBeUndefined();
  });

  it("logs a capabilities entry first, naming the inner provider's optional methods and flags", () => {
    const rec = new RecordingVoiceAI(inner(true));
    expect(rec.log[0]).toEqual({
      dir: 'in',
      t: 0,
      call: 'capabilities',
      has: [...OPTIONAL],
      props: { emitsInterruptions: true, marksVerbatimTurns: false },
    });
  });

  it('logs inputs and events in arrival order', async () => {
    const rec = new RecordingVoiceAI(inner(false));
    rec.on('event', () => {});
    await rec.connect({ instructions: 'Be nice.', tools: [], inputAudioFormat: 'pcm16', outputAudioFormat: 'pcm16' } as never);
    rec.sendUserText('Hello?');
    rec.sendToolResult('t1', { ok: true });
    expect(rec.log.slice(1).map((e) => (e.dir === 'in' ? e.call : e.event.type))).toEqual(['connect', 'sendUserText', 'transcript', 'tool_call', 'sendToolResult']);
    expect(rec.log[1]).toMatchObject({ call: 'connect', config: { instructions: 'Be nice.', tools: [] } });
  });

  it('judgeHoldLine logs the verdict the inner provider returned', async () => {
    const rec = new RecordingVoiceAI(inner(true));
    await expect(rec.judgeHoldLine!('Press 1 for sales.', [])).resolves.toBe('menu');
    expect(rec.log.at(-1)).toMatchObject({ call: 'judgeHoldLine', line: 'Press 1 for sales.', earlier: [], verdict: 'menu' });
  });

  it('judgeFirstLine logs the verdict the inner provider returned (#187)', async () => {
    const rec = new RecordingVoiceAI(inner(true));
    await expect(rec.judgeFirstLine!('Leave a message.', ['Hi.'])).resolves.toBe('voicemail');
    expect(rec.log.at(-1)).toMatchObject({ call: 'judgeFirstLine', line: 'Leave a message.', earlier: ['Hi.'], verdict: 'voicemail' });
  });

  it('verbatimDeliveryReport logs the report it returned', () => {
    const rec = new RecordingVoiceAI(inner(true));
    expect(rec.verbatimDeliveryReport!()).toMatchObject({ matched: true });
    expect(rec.log.at(-1)).toMatchObject({ call: 'verbatimDeliveryReport', report: { matched: true } });
  });

  it("listeners added through on() receive the inner provider's events", () => {
    const rec = new RecordingVoiceAI(inner(false));
    const seen: string[] = [];
    rec.on('event', (e) => seen.push(e.type));
    rec.sendUserText('Hi');
    expect(seen).toEqual(['transcript', 'tool_call']);
  });
});
