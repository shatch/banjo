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
});
