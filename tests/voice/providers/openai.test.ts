import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

class FakeWs extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    wsInstances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
}

const wsInstances: FakeWs[] = [];

vi.mock('ws', () => ({ default: FakeWs }));
vi.mock('../../../src/lib/logger.js', () => ({
  childLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('../../../src/config/index.js', () => ({
  config: { OPENAI_API_KEY: 'test-key', OPENAI_REALTIME_MODEL: 'gpt-realtime' },
}));

const { OpenAIRealtimeProvider } = await import('../../../src/voice/providers/openai.js');

const sessionConfig = {
  instructions: 'irrelevant for this test',
  tools: [],
  inputAudioFormat: 'g711_ulaw_8k' as const,
  outputAudioFormat: 'g711_ulaw_8k' as const,
  voice: 'alloy' as const,
};

function sentTypes(ws: FakeWs): string[] {
  return ws.sent.map((s) => JSON.parse(s).type);
}

describe('OpenAIRealtimeProvider.triggerResponse: race with connect()', () => {
  it('queues a triggerResponse() call made before the WS opens, and fires it once open', async () => {
    const provider = new OpenAIRealtimeProvider();
    const connectPromise = provider.connect(sessionConfig);
    const ws = wsInstances[wsInstances.length - 1]!;

    // The race: triggerResponse() called BEFORE the ws has opened.
    provider.triggerResponse();
    expect(sentTypes(ws)).not.toContain('response.create');

    ws.readyState = FakeWs.OPEN;
    ws.emit('open');
    await connectPromise;

    expect(sentTypes(ws)).toContain('response.create');
    // Sent exactly once — not duplicated on top of session.update.
    expect(sentTypes(ws).filter((t) => t === 'response.create')).toHaveLength(1);
  });

  it('still sends immediately when triggerResponse() is called after the WS is already open', async () => {
    const provider = new OpenAIRealtimeProvider();
    const connectPromise = provider.connect(sessionConfig);
    const ws = wsInstances[wsInstances.length - 1]!;
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');
    await connectPromise;

    provider.triggerResponse();

    expect(sentTypes(ws).filter((t) => t === 'response.create')).toHaveLength(1);
  });

  it('does not queue or send anything if triggerResponse() is never called', async () => {
    const provider = new OpenAIRealtimeProvider();
    const connectPromise = provider.connect(sessionConfig);
    const ws = wsInstances[wsInstances.length - 1]!;
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');
    await connectPromise;

    expect(sentTypes(ws)).not.toContain('response.create');
  });

  // #118: the silence nudge before Banjo's first words cues the disclosure.
  it('sends a cue as response.instructions, and a bare response.create without one, open or queued', async () => {
    const provider = new OpenAIRealtimeProvider();
    const connectPromise = provider.connect(sessionConfig);
    const ws = wsInstances[wsInstances.length - 1]!;
    provider.triggerResponse('Say the opening line.');
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');
    await connectPromise;
    provider.triggerResponse('Say it again.');
    provider.triggerResponse();

    const creates = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'response.create');
    expect(creates).toEqual([
      { type: 'response.create', response: { instructions: 'Say the opening line.' } },
      { type: 'response.create', response: { instructions: 'Say it again.' } },
      { type: 'response.create' },
    ]);
  });
});

describe('OpenAIRealtimeProvider tool-call argument parsing', () => {
  async function connectedProvider() {
    const provider = new OpenAIRealtimeProvider();
    const connectPromise = provider.connect(sessionConfig);
    const ws = wsInstances[wsInstances.length - 1]!;
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');
    await connectPromise;
    const calls: { id: string; name: string; arguments: Record<string, unknown>; unparsedArguments?: string }[] = [];
    provider.on('event', (e) => {
      if (e.type === 'tool_call') calls.push(e.call);
    });
    return { provider, ws, calls };
  }

  it('flags truncated arguments instead of passing them off as an empty object', async () => {
    // A real live call (2026-09-22) produced exactly this: OpenAI streamed
    // `{"date":"2026-09-22","time":"6:00pm` — unterminated. The parse failure
    // was swallowed and the tool ran with {}, which is indistinguishable from
    // a legitimate no-argument call, so the model was told its arguments were
    // invalid rather than that its message had been cut off. It never retried,
    // and asserted an availability answer it had never actually checked.
    const { ws, calls } = await connectedProvider();

    ws.emit(
      'message',
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call_RutETUnPmWe7AVud',
        name: 'check_my_availability',
        arguments: '{"date":"2026-09-22","time":"6:00pm',
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'check_my_availability',
      arguments: {},
      unparsedArguments: '{"date":"2026-09-22","time":"6:00pm',
    });
  });

  it('leaves unparsedArguments unset when the arguments parse cleanly', async () => {
    const { ws, calls } = await connectedProvider();

    ws.emit(
      'message',
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call-ok',
        name: 'check_my_availability',
        arguments: '{"date":"2026-09-22","time":"18:00","durationMinutes":90}',
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.unparsedArguments).toBeUndefined();
    expect(calls[0]!.arguments).toEqual({ date: '2026-09-22', time: '18:00', durationMinutes: 90 });
  });
});

describe('OpenAIRealtimeProvider.sendToolResult', () => {
  async function openProvider() {
    const provider = new OpenAIRealtimeProvider();
    const connectPromise = provider.connect(sessionConfig);
    const ws = wsInstances[wsInstances.length - 1]!;
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');
    await connectPromise;
    ws.sent = [];
    return { provider, ws };
  }

  it('prompts the model to continue after a tool result by default', async () => {
    const { provider, ws } = await openProvider();
    provider.sendToolResult('call-1', { ok: true });
    expect(sentTypes(ws)).toEqual(['conversation.item.create', 'response.create']);
  });

  it("leaves the model waiting for the other party with respond: false (#133)", async () => {
    const { provider, ws } = await openProvider();
    provider.sendToolResult('call-1', { ok: false }, true, { respond: false });
    expect(sentTypes(ws)).toEqual(['conversation.item.create']);
  });
});
