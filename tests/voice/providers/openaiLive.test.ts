import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceAIEvent, VoiceAISessionConfig } from '../../../src/voice/types.js';

class FakeWs extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  url: string;
  options: { headers?: Record<string, string> } | undefined;
  constructor(url: string, options?: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    this.options = options;
    wsInstances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
}

const wsInstances: FakeWs[] = [];

vi.mock('ws', () => ({ default: FakeWs }));
const log = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../../src/lib/logger.js', () => ({
  childLogger: () => log,
}));
vi.mock('../../../src/config/index.js', () => ({
  config: { OPENAI_API_KEY: 'test-key', OPENAI_LIVE_MODEL: 'gpt-live-1', OPENAI_LIVE_BACKEND_MODEL: 'gpt-5.6-terra' },
}));

const { OpenAILiveProvider, OUTPUT_IDLE_TURN_END_MS, TRANSCRIPT_IDLE_FINAL_MS } = await import('../../../src/voice/providers/openaiLive.js');

const availabilityTool = {
  name: 'check_my_availability',
  description: 'Check availability',
  parameters: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
};

const sessionConfig: VoiceAISessionConfig = {
  instructions: 'FULL backend prompt',
  frontendInstructions: 'VOICE prompt',
  tools: [availabilityTool],
  inputAudioFormat: 'g711_ulaw_8k',
  outputAudioFormat: 'g711_ulaw_8k',
};

const AUDIO = Buffer.from([1, 2, 3]).toString('base64');
/** G.711 mu-law digital silence — what Live pads the gaps between utterances with. */
const SILENCE = Buffer.from([0xff, 0xff, 0x7f]).toString('base64');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sent(ws: FakeWs): any[] {
  return ws.sent.map((s) => JSON.parse(s));
}

function serverSends(ws: FakeWs, message: Record<string, unknown>): void {
  ws.emit('message', Buffer.from(JSON.stringify(message)));
}

function latestWs(): FakeWs {
  return wsInstances[wsInstances.length - 1]!;
}

function ofType<T extends VoiceAIEvent['type']>(events: VoiceAIEvent[], type: T): Extract<VoiceAIEvent, { type: T }>[] {
  return events.filter((e): e is Extract<VoiceAIEvent, { type: T }> => e.type === type);
}

function functionCallEvent(callId: string, args: string) {
  return {
    type: 'response.event',
    event_id: 'evt_resp',
    delegation_id: 'del_1',
    event: {
      type: 'response.output_item.done',
      output_index: 0,
      sequence_number: 3,
      item: { type: 'function_call', call_id: callId, name: 'check_my_availability', arguments: args },
    },
  };
}

/** Connects, opens the socket, and acknowledges session.start — the state every post-startup test begins from. */
async function startSession(config: VoiceAISessionConfig = sessionConfig) {
  const provider = new OpenAILiveProvider();
  const events: VoiceAIEvent[] = [];
  provider.on('event', (e) => events.push(e));
  const connectPromise = provider.connect(config);
  const ws = latestWs();
  ws.readyState = FakeWs.OPEN;
  ws.emit('open');
  serverSends(ws, { type: 'session.started', event_id: 'evt_1', session: { id: 'sess_1' } });
  await connectPromise;
  return { provider, ws, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OpenAILiveProvider: connect / session.start', () => {
  it('connects to the Live sessions endpoint with bearer auth and no model in the URL', () => {
    void new OpenAILiveProvider().connect(sessionConfig);
    const ws = latestWs();
    expect(ws.url).toBe('wss://api.openai.com/v1/live/sessions');
    expect(ws.options?.headers).toEqual({ Authorization: 'Bearer test-key' });
  });

  it('sends session.start with the model, one shared mu-law format, the voice-layer prompt, and tool schemas under delegation.responses', async () => {
    const provider = new OpenAILiveProvider();
    const connectPromise = provider.connect(sessionConfig);
    const ws = latestWs();
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');

    expect(sent(ws)).toEqual([
      {
        type: 'session.start',
        session: {
          model: 'gpt-live-1',
          instructions: 'VOICE prompt',
          audio: { format: { type: 'audio/pcmu', rate: 8000 } },
          delegation: {
            type: 'responses',
            responses: {
              model: 'gpt-5.6-terra',
              instructions: 'FULL backend prompt',
              tools: [{ type: 'function', ...availabilityTool }],
            },
          },
        },
      },
    ]);

    serverSends(ws, { type: 'session.started', event_id: 'evt_1', session: { id: 'sess_1' } });
    await connectPromise;
  });

  it('falls back to the full prompt for the voice layer when no frontendInstructions are supplied', () => {
    const { frontendInstructions: _omitted, ...withoutFrontend } = sessionConfig;
    void new OpenAILiveProvider().connect(withoutFrontend);
    const ws = latestWs();
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');
    expect(sent(ws)[0].session.instructions).toBe('FULL backend prompt');
  });

  it('does not resolve connect() or send any other command until session.started arrives', async () => {
    const provider = new OpenAILiveProvider();
    let resolved = false;
    const connectPromise = provider.connect(sessionConfig).then(() => {
      resolved = true;
    });
    const ws = latestWs();
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');

    provider.sendAudioChunk({ data: Buffer.from([9]), sampleRate: 8000 });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(sent(ws).map((m) => m.type)).toEqual(['session.start']);

    serverSends(ws, { type: 'session.started', event_id: 'evt_1', session: { id: 'sess_1' } });
    await connectPromise;
    provider.sendAudioChunk({ data: Buffer.from([9]), sampleRate: 8000 });
    expect(sent(ws).at(-1)).toEqual({ type: 'session.input_audio.append', audio: Buffer.from([9]).toString('base64') });
  });

  it('throws — without opening a socket — when input and output audio formats differ, since Live has one shared format', () => {
    const before = wsInstances.length;
    expect(() => new OpenAILiveProvider().connect({ ...sessionConfig, inputAudioFormat: 'pcm16_16k', outputAudioFormat: 'pcm16_24k' })).toThrow(
      /one audio format for both directions/,
    );
    expect(wsInstances.length).toBe(before);
  });

  it('throws for pcm16_8k, which Live WebSocket PCM does not support', () => {
    expect(() => new OpenAILiveProvider().connect({ ...sessionConfig, inputAudioFormat: 'pcm16_8k', outputAudioFormat: 'pcm16_8k' })).toThrow(/pcm16_8k/);
  });

  it('tags output audio with the negotiated PCM rate', async () => {
    const { ws, events } = await startSession({ ...sessionConfig, inputAudioFormat: 'pcm16_24k', outputAudioFormat: 'pcm16_24k' });
    expect(sent(ws)[0].session.audio.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    serverSends(ws, { type: 'session.output_audio.delta', delta: AUDIO });
    expect(ofType(events, 'audio_chunk')[0]!.chunk.sampleRate).toBe(24000);
  });

  it('rejects connect() when the server errors before session.started', async () => {
    const provider = new OpenAILiveProvider();
    const events: VoiceAIEvent[] = [];
    provider.on('event', (e) => events.push(e));
    const connectPromise = provider.connect(sessionConfig);
    const ws = latestWs();
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');
    serverSends(ws, { type: 'error', event_id: 'evt_err', error: { code: 'unknown_parameter', message: 'Unknown parameter', type: 'invalid_request_error' } });

    await expect(connectPromise).rejects.toThrow(/Unknown parameter/);
    expect(ofType(events, 'error')[0]!.error.vendorCode).toBe('unknown_parameter');
  });

  it('rejects connect() — and emits no disconnected event — when the socket closes before session.started', async () => {
    const provider = new OpenAILiveProvider();
    const events: VoiceAIEvent[] = [];
    provider.on('event', (e) => events.push(e));
    const connectPromise = provider.connect(sessionConfig);
    latestWs().emit('close', 1006, Buffer.from(''));

    await expect(connectPromise).rejects.toThrow(/closed before session.started/);
    expect(ofType(events, 'disconnected')).toHaveLength(0);
  });
});

describe('OpenAILiveProvider: tool calls via Responses delegation', () => {
  it('unwraps a function call nested in response.event into exactly one tool_call', async () => {
    const { ws, events } = await startSession();
    serverSends(ws, functionCallEvent('call_abc', '{"date":"2026-09-15"}'));
    serverSends(ws, functionCallEvent('call_abc', '{"date":"2026-09-15"}')); // repeated — must not double-dispatch
    serverSends(ws, { type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1' } } });

    const calls = ofType(events, 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.call).toMatchObject({ id: 'call_abc', name: 'check_my_availability', arguments: { date: '2026-09-15' } });
  });

  it('sends a tool result as response.item.create followed by response.create', async () => {
    const { provider, ws } = await startSession();
    provider.sendToolResult('call_abc', { free: true });

    expect(sent(ws).slice(-2)).toEqual([
      {
        type: 'response.item.create',
        event_id: expect.any(String),
        item: { type: 'function_call_output', call_id: 'call_abc', output: '{"free":true}' },
      },
      { type: 'response.create' },
    ]);
  });

  it('shapes an error tool result the same way the Realtime adapter does', async () => {
    const { provider, ws } = await startSession();
    provider.sendToolResult('call_abc', 'boom', true);
    expect(JSON.parse(sent(ws).at(-2).item.output)).toEqual({ error: true, value: 'boom' });
  });
});

describe('OpenAILiveProvider: synthesized turn_end', () => {
  it('fires exactly once after output audio goes quiet, and never while deltas keep arriving', async () => {
    vi.useFakeTimers();
    const { ws, events } = await startSession();

    for (let i = 0; i < 5; i++) {
      serverSends(ws, { type: 'session.output_audio.delta', delta: AUDIO });
      vi.advanceTimersByTime(OUTPUT_IDLE_TURN_END_MS - 100);
    }
    expect(ofType(events, 'turn_end')).toHaveLength(0);

    vi.advanceTimersByTime(100);
    expect(ofType(events, 'turn_end')).toHaveLength(1);

    vi.advanceTimersByTime(OUTPUT_IDLE_TURN_END_MS * 10);
    expect(ofType(events, 'turn_end')).toHaveLength(1);

    const chunks = ofType(events, 'audio_chunk');
    expect(chunks).toHaveLength(5);
    expect(chunks[0]!.chunk).toEqual({ data: Buffer.from([1, 2, 3]), sampleRate: 8000 });
  });

  it('drops digital-silence frames — a continuous silent stream after speech neither reaches CallSession nor keeps the turn open (regression: 0 turn_ends in a 7.5-minute live call)', async () => {
    vi.useFakeTimers();
    const { ws, events } = await startSession();
    serverSends(ws, { type: 'session.output_audio.delta', delta: AUDIO });
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(100);
      serverSends(ws, { type: 'session.output_audio.delta', delta: SILENCE });
    }

    expect(ofType(events, 'audio_chunk')).toHaveLength(1);
    expect(ofType(events, 'turn_end')).toHaveLength(1);
  });

  it('emits a final assistant transcript once its fragments go quiet, even while the model is still speaking', async () => {
    vi.useFakeTimers();
    const { ws, events } = await startSession();
    serverSends(ws, { type: 'session.output_transcript.delta', event_id: 'e1', start_ms: 0, end_ms: 400, delta: 'Hello there.' });
    for (let i = 0; i < 15; i++) {
      serverSends(ws, { type: 'session.output_audio.delta', delta: AUDIO });
      vi.advanceTimersByTime(100);
    }

    expect(ofType(events, 'transcript').filter((t) => t.isFinal)).toEqual([
      { type: 'transcript', role: 'assistant', text: 'Hello there.', isFinal: true },
    ]);
    expect(ofType(events, 'turn_end')).toHaveLength(0);
  });

  it('ends a tool-only turn that produces no audio at all', async () => {
    vi.useFakeTimers();
    const { ws, events } = await startSession();
    serverSends(ws, functionCallEvent('call_abc', '{}'));
    expect(ofType(events, 'turn_end')).toHaveLength(0);
    vi.advanceTimersByTime(OUTPUT_IDLE_TURN_END_MS);
    expect(ofType(events, 'turn_end')).toHaveLength(1);
  });

  it('emits streaming assistant transcript fragments, then one final assistant transcript at turn_end', async () => {
    vi.useFakeTimers();
    const { ws, events } = await startSession();
    serverSends(ws, { type: 'session.output_transcript.delta', event_id: 'e1', start_ms: 0, end_ms: 400, delta: 'Hello ' });
    serverSends(ws, { type: 'session.output_transcript.delta', event_id: 'e2', start_ms: 400, end_ms: 800, delta: 'there.' });
    vi.advanceTimersByTime(OUTPUT_IDLE_TURN_END_MS);

    expect(ofType(events, 'transcript')).toEqual([
      { type: 'transcript', role: 'assistant', text: 'Hello ', isFinal: false },
      { type: 'transcript', role: 'assistant', text: 'there.', isFinal: false },
      { type: 'transcript', role: 'assistant', text: 'Hello there.', isFinal: true },
    ]);
    expect(ofType(events, 'turn_end')).toHaveLength(1);
  });

  it('synthesizes a final user transcript once caller fragments go quiet — CallSession arms its silence watchdog only on one', async () => {
    vi.useFakeTimers();
    const { ws, events } = await startSession();
    serverSends(ws, { type: 'session.input_transcript.delta', event_id: 'e1', start_ms: 0, end_ms: 300, delta: 'Hi, ' });
    serverSends(ws, { type: 'session.input_transcript.delta', event_id: 'e2', start_ms: 300, end_ms: 900, delta: 'who is this?' });
    expect(ofType(events, 'transcript').filter((t) => t.isFinal)).toHaveLength(0);

    vi.advanceTimersByTime(TRANSCRIPT_IDLE_FINAL_MS);
    expect(ofType(events, 'transcript').filter((t) => t.isFinal)).toEqual([
      { type: 'transcript', role: 'user', text: 'Hi, who is this?', isFinal: true },
    ]);
    // Caller speech alone is not the model's turn ending.
    expect(ofType(events, 'turn_end')).toHaveLength(0);
  });
});

describe('OpenAILiveProvider: speak-then-verify verbatim delivery', () => {
  const MESSAGE = 'Please call back at 555-1234.';

  it('reports nothing before sayVerbatim() has ever been called', async () => {
    const { provider } = await startSession();
    expect(provider.verbatimDeliveryReport()).toBeUndefined();
  });

  it('asks for the message via session.instructions.append with a null delegation_id', async () => {
    const { provider, ws } = await startSession();
    provider.sayVerbatim(MESSAGE);
    const append = sent(ws).at(-1);
    expect(append.type).toBe('session.instructions.append');
    expect(append.delegation_id).toBeNull();
    expect(append.content).toContain(MESSAGE);
  });

  it('reports matched when the output transcript contains the message', async () => {
    const { provider, ws } = await startSession();
    provider.sayVerbatim(MESSAGE);
    serverSends(ws, { type: 'session.output_audio.delta', delta: AUDIO });
    serverSends(ws, { type: 'session.output_transcript.delta', event_id: 'e1', start_ms: 0, end_ms: 1, delta: 'Please call back at ' });
    serverSends(ws, { type: 'session.output_transcript.delta', event_id: 'e2', start_ms: 1, end_ms: 2, delta: '555-1234.' });
    expect(provider.verbatimDeliveryReport()).toEqual({ intended: MESSAGE, spoken: MESSAGE, matched: true });
  });

  it('reports not matched — with what was actually said — when the model paraphrases', async () => {
    const { provider, ws } = await startSession();
    provider.sayVerbatim(MESSAGE);
    serverSends(ws, { type: 'session.output_transcript.delta', event_id: 'e1', start_ms: 0, end_ms: 1, delta: 'Give us a call back later.' });
    expect(provider.verbatimDeliveryReport()).toEqual({ intended: MESSAGE, spoken: 'Give us a call back later.', matched: false });
  });

  it('reports not matched when sayVerbatim() is called with no started session', () => {
    const provider = new OpenAILiveProvider();
    provider.sayVerbatim(MESSAGE);
    expect(provider.verbatimDeliveryReport()).toEqual({ intended: MESSAGE, spoken: '', matched: false });
  });

  it('holds turn_end back after sayVerbatim() until the verbatim speech starts — a leftover preamble turn_end must not end the wait early', async () => {
    vi.useFakeTimers();
    const { provider, ws, events } = await startSession();
    serverSends(ws, { type: 'session.output_audio.delta', delta: AUDIO }); // preamble, arms the debounce

    provider.sayVerbatim(MESSAGE);
    serverSends(ws, { type: 'session.output_audio.delta', delta: SILENCE }); // silence isn't the message starting
    vi.advanceTimersByTime(OUTPUT_IDLE_TURN_END_MS * 5);
    serverSends(ws, { type: 'response.event', event: { type: 'response.completed' } }); // backend activity doesn't count
    vi.advanceTimersByTime(OUTPUT_IDLE_TURN_END_MS * 5);
    expect(ofType(events, 'turn_end')).toHaveLength(0);

    serverSends(ws, { type: 'session.output_audio.delta', delta: AUDIO });
    serverSends(ws, { type: 'session.output_transcript.delta', event_id: 'e1', start_ms: 0, end_ms: 1, delta: MESSAGE });
    vi.advanceTimersByTime(OUTPUT_IDLE_TURN_END_MS);
    expect(ofType(events, 'turn_end')).toHaveLength(1);
    expect(provider.verbatimDeliveryReport()?.matched).toBe(true);
  });
});

describe('OpenAILiveProvider: diagnostics', () => {
  it('logs exactly one event summary when the session ends — event counts, synthesized turn_ends, longest speech gap, dropped silent chunks', async () => {
    vi.useFakeTimers();
    const { ws } = await startSession();
    log.info.mockClear();

    serverSends(ws, { type: 'session.output_audio.delta', delta: AUDIO });
    vi.advanceTimersByTime(100);
    serverSends(ws, { type: 'session.output_audio.delta', delta: SILENCE });
    vi.advanceTimersByTime(100);
    serverSends(ws, { type: 'session.output_audio.delta', delta: AUDIO });
    serverSends(ws, functionCallEvent('call_abc', '{}'));
    vi.advanceTimersByTime(OUTPUT_IDLE_TURN_END_MS);
    serverSends(ws, { type: 'session.closed', event_id: 'evt_c', reason: 'remote_hangup', session: { id: 'sess_1' }, usage: { seconds: 3 } });
    ws.emit('close', 1000, Buffer.from(''));

    const summaries = log.info.mock.calls.filter((call) => call[1] === 'openai live event summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]![0]).toMatchObject({
      eventCounts: { 'session.output_audio.delta': 3, 'response.event:response.output_item.done': 1, 'session.closed': 1 },
      turnEndsEmitted: 1,
      maxSpeechAudioGapMs: 200,
      silentOutputAudioChunks: 1,
    });
  });
});

describe('OpenAILiveProvider: triggerResponse / interrupt / disconnect', () => {
  it('queues a triggerResponse() made before session.started and sends it once, as an instruction to the voice layer', async () => {
    const provider = new OpenAILiveProvider();
    const connectPromise = provider.connect(sessionConfig);
    const ws = latestWs();
    provider.triggerResponse();
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');
    expect(sent(ws).map((m) => m.type)).toEqual(['session.start']);

    serverSends(ws, { type: 'session.started', event_id: 'evt_1', session: { id: 'sess_1' } });
    await connectPromise;

    const appends = sent(ws).filter((m) => m.type === 'session.instructions.append');
    expect(appends).toHaveLength(1);
    expect(appends[0].delegation_id).toBeNull();
    // response.create would only prompt the delegated backend, not the voice.
    expect(sent(ws).map((m) => m.type)).not.toContain('response.create');
  });

  it('interrupt() sends nothing — Live has no cancel event', async () => {
    const { provider, ws } = await startSession();
    const before = ws.sent.length;
    provider.interrupt();
    expect(ws.sent.length).toBe(before);
  });

  it('maps session.closed to one disconnected event carrying the close reason, even when the socket close follows', async () => {
    const { ws, events } = await startSession();
    serverSends(ws, { type: 'session.closed', event_id: 'evt_c', reason: 'remote_hangup', session: { id: 'sess_1' }, usage: { seconds: 42 } });
    ws.emit('close', 1000, Buffer.from(''));

    const disconnected = ofType(events, 'disconnected');
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0]!.reason).toContain('remote_hangup');
  });
});
