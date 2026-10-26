import { describe, expect, it } from 'vitest';
import { fingerprint, type RecordingFile } from '../../src/evals/recording.js';
import type { LogEntry } from '../../src/evals/recorder.js';
import { replay, ReplayVoiceAI } from '../../src/evals/replayer.js';
import type { VoiceAIEvent, VoiceAISessionConfig } from '../../src/voice/types.js';

const CONFIG = { instructions: 'Call for Alex.', tools: [{ name: 'end_call' }] };
const SESSION = { ...CONFIG, inputAudioFormat: 'pcm16', outputAudioFormat: 'pcm16' } as unknown as VoiceAISessionConfig;

function recording(log: LogEntry[], has: string[] = []): RecordingFile {
  return {
    version: 1,
    scenarioId: 's',
    scenarioHash: 'h',
    fingerprint: fingerprint(CONFIG),
    recordedAt: '2026-10-22T15:00:00.000Z',
    windowStart: '2026-10-22T15:00:00.000Z',
    gitSha: 'x',
    model: 'gpt-realtime',
    log: [{ dir: 'in', t: 0, call: 'capabilities', has, props: {} }, ...log],
  };
}

const out = (event: VoiceAIEvent): LogEntry => ({ dir: 'out', t: 1, event });
const inp = (entry: Record<string, unknown>): LogEntry => ({ dir: 'in', t: 1, ...entry }) as LogEntry;

/** Stands in for CallSession: answers each tool call with the result it's given. */
function codeUnderTest(voice: ReplayVoiceAI, results: Record<string, unknown>) {
  const seen: string[] = [];
  voice.on('event', (e) => {
    seen.push(e.type === 'transcript' ? `${e.role}: ${e.text}` : e.type);
    if (e.type === 'tool_call') voice.sendToolResult(e.call.id, results[e.call.name] ?? { ok: true });
  });
  return seen;
}

const BASIC = [
  inp({ call: 'connect', config: CONFIG }),
  out({ type: 'connected' }),
  inp({ call: 'sendUserText', text: 'Hello?' }),
  out({ type: 'transcript', role: 'user', text: 'Hello?', isFinal: true }),
  out({ type: 'transcript', role: 'assistant', text: "Hi, I'm an AI. Bye!", isFinal: true }),
  out({ type: 'tool_call', call: { id: 'c1', name: 'end_call', arguments: {} } }),
  inp({ call: 'sendToolResult', toolCallId: 'c1', result: { ok: true, taskId: '6f1c1a52-3b1e-4a8c-9a59-1f0a9b8f2c11' } }),
];

describe('replay', () => {
  it('replays a recording in order and returns ok', async () => {
    const voice = new ReplayVoiceAI(recording(BASIC));
    const seen = codeUnderTest(voice, { end_call: { ok: true, taskId: '0d2b7e44-91aa-4f3e-8c55-77e0c1d2a3b4' } });
    const done = replay(voice, { waitMs: 500 });
    await voice.connect(SESSION);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(seen).toEqual(['connected', 'user: Hello?', "assistant: Hi, I'm an AI. Bye!", 'tool_call']);
  });

  it('a tool result that differs from the recording is a divergence at that index', async () => {
    const voice = new ReplayVoiceAI(recording(BASIC));
    codeUnderTest(voice, { end_call: { ok: false, error: 'no_goodbye' } });
    const done = replay(voice, { waitMs: 500 });
    await voice.connect(SESSION);
    const outcome = await done;
    expect(outcome).toMatchObject({ ok: false, divergence: { index: 7, expected: { call: 'sendToolResult' } } });
  });

  it('a recorded input the code never makes times out as a divergence', async () => {
    const voice = new ReplayVoiceAI(recording(BASIC));
    voice.on('event', () => {}); // never answers the tool call
    const done = replay(voice, { waitMs: 50 });
    await voice.connect(SESSION);
    await expect(done).resolves.toMatchObject({ ok: false, divergence: { index: 7, actual: 'timeout' } });
  });

  it('a call the recording never had is a divergence', async () => {
    const voice = new ReplayVoiceAI(recording(BASIC));
    codeUnderTest(voice, {});
    voice.on('event', (e) => {
      if (e.type === 'connected') voice.triggerResponse('Say hello.');
    });
    const done = replay(voice, { waitMs: 500 });
    await voice.connect(SESSION);
    await expect(done).resolves.toMatchObject({ ok: false, divergence: { actual: { call: 'triggerResponse' } } });
  });

  it('a different fingerprint at connect returns stale', async () => {
    const voice = new ReplayVoiceAI(recording(BASIC));
    const done = replay(voice, { waitMs: 500 });
    await voice.connect({ ...SESSION, instructions: 'Call for Alex. A new rule.' });
    await expect(done).resolves.toEqual({ ok: false, stale: true });
  });

  it('judgeHoldLine returns the recorded verdict, once the replay reaches it', async () => {
    const log = [
      inp({ call: 'connect', config: CONFIG }),
      out({ type: 'connected' }),
      inp({ call: 'judgeHoldLine', line: 'Press 1 for sales.', earlier: [], verdict: 'menu' }),
    ];
    const voice = new ReplayVoiceAI(recording(log, ['judgeHoldLine']));
    expect('judgeHoldLine' in voice).toBe(true);
    expect('addContext' in voice).toBe(false);
    voice.on('event', (e) => {
      if (e.type === 'connected') void voice.judgeHoldLine!('Press 1 for sales.', []).then((v) => verdicts.push(v));
    });
    const verdicts: string[] = [];
    const done = replay(voice, { waitMs: 500 });
    await voice.connect(SESSION);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(verdicts).toEqual(['menu']);
  });

  it('judgeFirstLine returns the recorded verdict, once the replay reaches it (#187)', async () => {
    const log = [
      inp({ call: 'connect', config: CONFIG }),
      out({ type: 'connected' }),
      inp({ call: 'judgeFirstLine', line: 'Leave a message.', earlier: [], verdict: 'voicemail' }),
    ];
    const voice = new ReplayVoiceAI(recording(log, ['judgeFirstLine']));
    expect('judgeFirstLine' in voice).toBe(true);
    const verdicts: string[] = [];
    voice.on('event', (e) => {
      if (e.type === 'connected') void voice.judgeFirstLine!('Leave a message.', []).then((v) => verdicts.push(v));
    });
    const done = replay(voice, { waitMs: 500 });
    await voice.connect(SESSION);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(verdicts).toEqual(['voicemail']);
  });

  it('plays the other party hanging up', async () => {
    const log = [inp({ call: 'connect', config: CONFIG }), out({ type: 'connected' }), inp({ call: 'calleeHangsUp' })];
    const voice = new ReplayVoiceAI(recording(log));
    let hungUp = false;
    const done = replay(voice, { waitMs: 500, hangUp: () => (hungUp = true) });
    await voice.connect(SESSION);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(hungUp).toBe(true);
  });
});
