import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TwilioProvider } from '../../src/telephony/providers/twilio.js';
import { pcm16ToMuLaw } from '../../src/telephony/audio/codec.js';
import type { TelephonyEvent } from '../../src/telephony/providers/types.js';

/** Minimal fake satisfying the subset of `ws`'s WebSocket API TwilioProvider actually calls. */
function fakeWebSocket() {
  const emitter = new EventEmitter();
  let closed = false;
  return {
    on: (event: string, handler: (...args: unknown[]) => void) => emitter.on(event, handler),
    emitMessage: (payload: unknown) => emitter.emit('message', Buffer.from(JSON.stringify(payload))),
    emitClose: () => emitter.emit('close'),
    close: () => {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}

describe('TwilioProvider.buildTwiml', () => {
  it('passes callId via a <Parameter> element, not a query string on the Stream url', () => {
    // Regression test: a live call connected its media-stream WebSocket
    // with an empty callId because Twilio strips query-string parameters
    // from <Stream url="..."> before opening the connection — sendAudio()
    // then couldn't find the call's WS (it was registered under the real
    // callId, but the socket arrived associated with ""), so the model's
    // audio never reached the phone at all (silent call). callId must be
    // delivered via a <Parameter> child instead, read back from the
    // 'start' event's customParameters in handleMediaStreamConnection().
    const provider = new TwilioProvider();
    const twiml = provider.buildTwiml('abc-123');

    expect(twiml).toContain('<Parameter name="callId" value="abc-123" />');
    // The url attribute itself must NOT carry callId as a query string —
    // that's the exact form that silently failed.
    expect(twiml).not.toMatch(/url="[^"]*\?callId=/);
  });

  it('produces well-formed TwiML with a single Connect/Stream', () => {
    const provider = new TwilioProvider();
    const twiml = provider.buildTwiml('xyz');

    expect(twiml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(twiml).toContain('<Response>');
    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain('<Stream url="wss://');
  });
});

describe('TwilioProvider.handleAmdCallback', () => {
  // Regression test: this method didn't exist at all before — the AMD
  // webhook route (src/server.ts) called `telephony.handleAmdCallback?.(...)`
  // with optional chaining, which silently no-op'd on every real call
  // (AMD is requested via answeringMachineDetection: true in
  // session/callSession.ts) because TwilioProvider never implemented it.
  // CallSession's 'answering_machine_detected' case, and the answeredBy
  // DB write in updateCallAttempt, never fired despite AMD always being
  // requested.
  it('emits a typed answering_machine_detected event for a known AnsweredBy value', () => {
    const provider = new TwilioProvider();
    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));

    provider.handleAmdCallback('call-1', 'machine_start');

    expect(events).toEqual([{ callId: 'call-1', type: 'answering_machine_detected', answeredBy: 'machine_start' }]);
  });

  it('normalizes an unrecognized AnsweredBy value to "unknown" rather than passing it through untyped', () => {
    const provider = new TwilioProvider();
    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));

    provider.handleAmdCallback('call-1', 'some_future_twilio_value');

    expect(events).toEqual([{ callId: 'call-1', type: 'answering_machine_detected', answeredBy: 'unknown' }]);
  });
});

describe('TwilioProvider.handleMediaStreamConnection', () => {
  it('emits inbound audio as RAW mu-law bytes, not pre-decoded PCM16', () => {
    // Regression test: a live call connected fine and the caller heard the
    // model speak, but the model never understood anything the caller said —
    // its server-side VAD paused on speech energy but produced no coherent
    // response. Root cause: this handler used to decode mu-law -> PCM16
    // before emitting the audio_chunk event, but session/audioPipeline.ts's
    // passthrough mode (used for OpenAI/ElevenLabs, both mu-law-capable)
    // assumes inbound chunks are still raw mu-law and forwards them
    // untouched — so CallSession sent PCM16 bytes to a session configured
    // for audio/pcmu (mu-law) input, silently corrupting every frame.
    const provider = new TwilioProvider();
    const ws = fakeWebSocket();
    provider.handleMediaStreamConnection(ws as never);

    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));

    ws.emitMessage({ event: 'connected' });
    // callSid ('CA123') and customParameters.callId ('call-1') are
    // deliberately different here — see the assertion below, which pins
    // outbound resolution to customParameters.callId specifically. Without
    // it, a regression that swapped in the inbound resolver (start.callSid)
    // for the outbound path would go undetected: sendAudio()/hangUp() would
    // silently fail to find the call, the exact class of bug buildTwiml's
    // own "<Parameter> not query string" test documents as a real incident.
    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ123', callSid: 'CA123', customParameters: { callId: 'call-1' } } });

    const connectedEvent = events.find((e) => e.type === 'connected');
    expect(connectedEvent).toEqual({
      callId: 'call-1', // from customParameters.callId, NOT callSid ('CA123')
      type: 'connected',
      meta: { callId: 'call-1', providerCallId: 'CA123', toNumber: '' },
    });

    const originalMuLaw = pcm16ToMuLaw(Buffer.from(new Int16Array([1000, -1000, 500]).buffer));
    ws.emitMessage({ event: 'media', media: { payload: originalMuLaw.toString('base64') } });

    const audioEvent = events.find((e) => e.type === 'audio_chunk');
    expect(audioEvent).toBeDefined();
    if (audioEvent?.type !== 'audio_chunk') throw new Error('expected audio_chunk event');

    // Same byte length as the mu-law input (1 byte/sample) — if this were
    // decoded to PCM16 it would be double the length (2 bytes/sample).
    expect(audioEvent.chunk.data.length).toBe(originalMuLaw.length);
    expect(audioEvent.chunk.data.equals(originalMuLaw)).toBe(true);
  });
});

describe('TwilioProvider.buildInboundTwiml', () => {
  it('produces well-formed TwiML pointing at the inbound stream URL, with no <Parameter> element', () => {
    // Unlike buildTwiml (outbound), no <Parameter> is needed: an inbound
    // call's callId IS Twilio's own CallSid, which the 'start' event's
    // start.callSid field already carries without a custom parameter.
    const provider = new TwilioProvider();
    const twiml = provider.buildInboundTwiml();

    expect(twiml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(twiml).toContain('<Response>');
    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain('<Stream url="wss://');
    expect(twiml).toContain('/telephony/twilio/inbound-stream');
    expect(twiml).not.toContain('<Parameter');
  });
});

describe('TwilioProvider.buildDeclineTwiml', () => {
  it('produces a <Reject> response — never answers the call', () => {
    const provider = new TwilioProvider();
    const twiml = provider.buildDeclineTwiml();

    expect(twiml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(twiml).toContain('<Reject');
    expect(twiml).not.toContain('<Connect>');
    expect(twiml).not.toContain('<Stream');
  });
});

describe('TwilioProvider.isAnyCallActive', () => {
  it('is false with no calls registered', () => {
    const provider = new TwilioProvider();
    expect(provider.isAnyCallActive()).toBe(false);
  });

  it('is true once an inbound call is registered', () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
    expect(provider.isAnyCallActive()).toBe(true);
  });

  it('is false again once that call ends (its media-stream socket sends a stop event)', () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
    const ws = fakeWebSocket();
    provider.handleInboundMediaStreamConnection(ws as never);
    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ999', callSid: 'CA-inbound-1' } });
    ws.emitMessage({ event: 'stop' });

    expect(provider.isAnyCallActive()).toBe(false);
  });
});

describe('TwilioProvider.registerInboundCall', () => {
  it('sets providerCallId immediately (unlike outbound originateCall, which only learns it after the REST call returns)', async () => {
    // Regression guard for the exact bug hangUp()'s own doc comment
    // describes for a different code path: without providerCallId set,
    // hangUp() no-ops with a warning instead of actually ending the call.
    // For inbound, the CallSid IS the providerCallId from the moment the
    // webhook lands — there is no REST round-trip to wait for.
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');

    // hangUp() is the only externally-observable way to check providerCallId
    // was set, since `calls` is private — mock the Twilio REST client call
    // it makes and confirm it actually fires (rather than warning and
    // no-op'ing).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (provider as any).client;
    const update = vi.fn(async () => ({}));
    // `calls` is a getter-only accessor on the Twilio SDK's prototype
    // (configurable, no setter) — direct assignment throws in strict mode,
    // so override it on the instance via defineProperty instead.
    Object.defineProperty(client, 'calls', { value: vi.fn(() => ({ update })), configurable: true });

    await provider.hangUp('CA-inbound-1');

    expect(client.calls).toHaveBeenCalledWith('CA-inbound-1');
    expect(update).toHaveBeenCalledWith({ status: 'completed' });
  });
});

describe('TwilioProvider.hangUp', () => {
  it('still removes the call entry (isAnyCallActive returns to false) even when the Twilio REST update rejects', async () => {
    // Regression guard: without a finally, a REST failure here (e.g. the
    // call already ended on Twilio's side) would leave the entry in
    // `calls` forever, latching isAnyCallActive() to true for the rest of
    // the process's life since no other event will ever remove it.
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
    expect(provider.isAnyCallActive()).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (provider as any).client;
    const update = vi.fn(async () => {
      throw new Error('call already completed');
    });
    Object.defineProperty(client, 'calls', { value: vi.fn(() => ({ update })), configurable: true });

    await expect(provider.hangUp('CA-inbound-1')).rejects.toThrow('call already completed');
    expect(provider.isAnyCallActive()).toBe(false);
  });
});

describe('TwilioProvider.handleInboundMediaStreamConnection', () => {
  it('resolves callId from the start event\'s own callSid field, not customParameters', () => {
    const provider = new TwilioProvider();
    const ws = fakeWebSocket();
    provider.handleInboundMediaStreamConnection(ws as never);

    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));

    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ999', callSid: 'CA-inbound-1' } });

    expect(events).toEqual([
      { callId: 'CA-inbound-1', type: 'connected', meta: { callId: 'CA-inbound-1', providerCallId: 'CA-inbound-1', toNumber: '' } },
    ]);
  });

  it('emits inbound audio as RAW mu-law bytes, not pre-decoded PCM16 — same behavior as the outbound handler', () => {
    // Same regression this file's outbound handleMediaStreamConnection test
    // guards against (see that describe block above) — the shared helper
    // must preserve it for inbound too.
    const provider = new TwilioProvider();
    const ws = fakeWebSocket();
    provider.handleInboundMediaStreamConnection(ws as never);

    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));

    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ999', callSid: 'CA-inbound-1' } });
    const originalMuLaw = pcm16ToMuLaw(Buffer.from(new Int16Array([1000, -1000, 500]).buffer));
    ws.emitMessage({ event: 'media', media: { payload: originalMuLaw.toString('base64') } });

    const audioEvent = events.find((e) => e.type === 'audio_chunk');
    expect(audioEvent).toBeDefined();
    if (audioEvent?.type !== 'audio_chunk') throw new Error('expected audio_chunk event');
    expect(audioEvent.chunk.data.length).toBe(originalMuLaw.length);
    expect(audioEvent.chunk.data.equals(originalMuLaw)).toBe(true);
  });

  it('closes the socket and emits nothing if the start event carries no callSid', () => {
    const provider = new TwilioProvider();
    const ws = fakeWebSocket();
    provider.handleInboundMediaStreamConnection(ws as never);

    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));

    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ999' } }); // no callSid

    expect(events).toEqual([]);
    expect(ws.closed).toBe(true);
  });
});

describe('TwilioProvider inbound registration timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('unregisters an inbound call if its Media Stream never connects within the timeout', () => {
    // Regression guard for the WS-upgrade-never-lands / caller-hangs-up-
    // before-connecting leak: without this timeout, registerInboundCall()
    // seeds `calls` and nothing else ever removes the entry if no 'start'
    // event arrives — isAnyCallActive() would then latch to true for the
    // rest of the process's life.
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
    expect(provider.isAnyCallActive()).toBe(true);

    vi.advanceTimersByTime(30_000);

    expect(provider.isAnyCallActive()).toBe(false);
  });

  it('does not unregister a call whose Media Stream connected before the timeout', () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
    const ws = fakeWebSocket();
    provider.handleInboundMediaStreamConnection(ws as never);
    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ999', callSid: 'CA-inbound-1' } });

    vi.advanceTimersByTime(30_000);

    expect(provider.isAnyCallActive()).toBe(true);
  });

});

describe('TwilioProvider media-stream socket close without a prior stop frame', () => {
  it('removes the call and emits an ended event when the socket closes without a prior stop', () => {
    // Regression guard for the "Twilio-side error / network drop" leak
    // path: previously ws.on('close', ...) only logged, so a call whose
    // socket dropped without a clean 'stop' frame stayed in `calls`
    // forever and isAnyCallActive() latched to true permanently.
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
    const ws = fakeWebSocket();
    provider.handleInboundMediaStreamConnection(ws as never);
    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ999', callSid: 'CA-inbound-1' } });

    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));

    ws.emitClose();

    expect(provider.isAnyCallActive()).toBe(false);
    expect(events).toEqual([{ callId: 'CA-inbound-1', type: 'ended', reason: 'socket_closed' }]);
  });

  it('does not double-emit ended when close fires after stop already handled cleanup', () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
    const ws = fakeWebSocket();
    provider.handleInboundMediaStreamConnection(ws as never);
    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ999', callSid: 'CA-inbound-1' } });
    ws.emitMessage({ event: 'stop' });

    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));

    ws.emitClose();

    expect(events).toEqual([]);
  });

  it('does nothing when the socket closes before any start event ever arrived (callId still null)', () => {
    const provider = new TwilioProvider();
    const ws = fakeWebSocket();
    provider.handleInboundMediaStreamConnection(ws as never);

    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));

    expect(() => ws.emitClose()).not.toThrow();
    expect(events).toEqual([]);
  });
});
