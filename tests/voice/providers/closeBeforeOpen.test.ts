import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceAIEvent, VoiceAIProvider } from '../../../src/voice/types.js';

// Mimics `ws`: close() on a socket still CONNECTING aborts the handshake and
// emits 'error' ("WebSocket was closed before the connection was
// established") and then 'close', on a later tick.
class FakeWs extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWs.CONNECTING;
  constructor() {
    super();
    wsInstances.push(this);
  }
  send() {}
  terminate() {}
  close() {
    if (this.readyState !== FakeWs.CONNECTING) return;
    setImmediate(() => {
      this.emit('error', new Error('WebSocket was closed before the connection was established'));
      this.readyState = FakeWs.CLOSED;
      this.emit('close', 1006, Buffer.from(''));
    });
  }
}

const wsInstances: FakeWs[] = [];

vi.mock('ws', () => ({ default: FakeWs }));
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/lib/logger.js', () => ({ childLogger: () => log, logger: log }));
// vitest.config.ts only pins OpenAI credentials; set the others here so the
// test doesn't depend on whatever the developer's shell or .env happens to hold.
vi.mock('../../../src/config/index.js', async (importOriginal) => {
  const { config } = await importOriginal<typeof import('../../../src/config/index.js')>();
  return {
    config: {
      ...config,
      GEMINI_API_KEY: 'test-key',
      ELEVENLABS_API_KEY: 'test-key',
      ELEVENLABS_AGENT_ID: 'test-agent',
    },
  };
});

const { OpenAIRealtimeProvider } = await import('../../../src/voice/providers/openai.js');
const { OpenAILiveProvider } = await import('../../../src/voice/providers/openaiLive.js');
const { GeminiLiveProvider } = await import('../../../src/voice/providers/gemini.js');
const { ElevenLabsProvider } = await import('../../../src/voice/providers/elevenlabs.js');

const sessionConfig = {
  instructions: 'irrelevant',
  tools: [],
  inputAudioFormat: 'g711_ulaw_8k' as const,
  outputAudioFormat: 'g711_ulaw_8k' as const,
};

const providers: Array<[string, () => VoiceAIProvider]> = [
  ['openai', () => new OpenAIRealtimeProvider()],
  ['openai-live', () => new OpenAILiveProvider()],
  ['gemini', () => new GeminiLiveProvider()],
  ['elevenlabs', () => new ElevenLabsProvider()],
];

// #100: a call Twilio fails at once ends while the voice AI is still
// connecting, and CallSession.end() disconnects a socket that never opened.
// That close is ours, not a provider failure: it must not be logged as an
// error or reported as a Voice AI 'error' event.
describe.each(providers)('%s: disconnect() before the socket opens', (_name, make) => {
  it('is not logged or reported as an error, and connect() still rejects', async () => {
    log.error.mockClear();
    const provider = make();
    const events: VoiceAIEvent[] = [];
    provider.on('event', (e) => events.push(e));

    const connecting = provider.connect(sessionConfig);
    const settled = connecting.then(
      () => 'resolved',
      () => 'rejected',
    );
    await provider.disconnect();

    expect(await settled).toBe('rejected');
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('still reports a real socket error before the socket opens', async () => {
    log.error.mockClear();
    const provider = make();
    const events: VoiceAIEvent[] = [];
    provider.on('event', (e) => events.push(e));

    const connecting = provider.connect(sessionConfig).catch(() => {});
    wsInstances[wsInstances.length - 1]!.emit('error', new Error('getaddrinfo ENOTFOUND'));
    await connecting;

    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(log.error).toHaveBeenCalled();
  });
});
