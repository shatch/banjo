import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
// twilio.ts logs through a childLogger; capture it so hang-up warnings can be asserted.
const { fakeLog } = vi.hoisted(() => ({
  fakeLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/lib/logger.js', () => ({ childLogger: () => fakeLog, logger: fakeLog }));

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

/** A provider that has placed `callId` (REST mocked; Twilio answers with `callSid`), so a media stream may attach to it. */
async function providerWithPlacedCall(callId = 'call-1', callSid = 'CA123') {
  const provider = new TwilioProvider();
  const create = vi.fn(async () => ({ sid: callSid }));
  Object.defineProperty((provider as any).client, 'calls', { value: Object.assign(vi.fn(), { create }), configurable: true });
  await provider.originateCall({ to: '+15555550100', callId });
  return provider;
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
  it('emits inbound audio as RAW mu-law bytes, not pre-decoded PCM16', async () => {
    // Regression test: a live call connected fine and the caller heard the
    // model speak, but the model never understood anything the caller said —
    // its server-side VAD paused on speech energy but produced no coherent
    // response. Root cause: this handler used to decode mu-law -> PCM16
    // before emitting the audio_chunk event, but session/audioPipeline.ts's
    // passthrough mode (used for OpenAI/ElevenLabs, both mu-law-capable)
    // assumes inbound chunks are still raw mu-law and forwards them
    // untouched — so CallSession sent PCM16 bytes to a session configured
    // for audio/pcmu (mu-law) input, silently corrupting every frame.
    const provider = await providerWithPlacedCall('call-1', 'CA123');
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
      meta: { callId: 'call-1', providerCallId: 'CA123', toNumber: '+15555550100' },
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

describe('TwilioProvider media stream: only for a call Banjo placed or answered (GHSA-5x8v-r99f-ph3m)', () => {
  /** Opens a stream, sends `start`, and returns what it emitted and whether it closed. */
  function openStream(provider: TwilioProvider, start: Record<string, unknown>, inbound = false) {
    const ws = fakeWebSocket();
    if (inbound) provider.handleInboundMediaStreamConnection(ws as never);
    else provider.handleMediaStreamConnection(ws as never);
    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));
    ws.emitMessage({ event: 'start', start });
    return { ws, events };
  }

  it('refuses an outbound stream for a callId it never placed, and adds no call', () => {
    const provider = new TwilioProvider();
    const { ws, events } = openStream(provider, { streamSid: 'MZ1', callSid: 'CA1', customParameters: { callId: 'made-up' } });

    expect(ws.closed).toBe(true);
    expect(events).toEqual([]);
    // Used to add an entry, so every inbound call was declined while the socket stayed open.
    expect(provider.isAnyCallActive()).toBe(false);
  });

  it('refuses an inbound stream for a CallSid it never answered, and adds no call', () => {
    const provider = new TwilioProvider();
    const { ws, events } = openStream(provider, { streamSid: 'MZ1', callSid: 'CA-unknown' }, true);

    expect(ws.closed).toBe(true);
    expect(events).toEqual([]);
    expect(provider.isAnyCallActive()).toBe(false);
  });

  it('refuses a second stream for a call that already has one, leaving the first in place', async () => {
    const provider = await providerWithPlacedCall('call-1', 'CA123');
    const first = openStream(provider, { streamSid: 'MZ1', callSid: 'CA123', customParameters: { callId: 'call-1' } });
    const second = openStream(provider, { streamSid: 'MZ2', callSid: 'CA123', customParameters: { callId: 'call-1' } });

    expect(first.ws.closed).toBe(false);
    expect(second.ws.closed).toBe(true);
    expect(second.events).toEqual([]);

    // The refused socket closing must not end the real call.
    second.ws.emitClose();
    expect(provider.isAnyCallActive()).toBe(true);
  });

  it('refuses an outbound stream whose callSid is not the call Twilio placed', async () => {
    const provider = await providerWithPlacedCall('call-1', 'CA123');
    const { ws, events } = openStream(provider, { streamSid: 'MZ1', callSid: 'CA-other', customParameters: { callId: 'call-1' } });

    expect(ws.closed).toBe(true);
    expect(events).toEqual([]);
  });

  it('refuses an outbound stream with no callSid once the call has one', async () => {
    const provider = await providerWithPlacedCall('call-1', 'CA123');
    const { ws } = openStream(provider, { streamSid: 'MZ1', customParameters: { callId: 'call-1' } });

    expect(ws.closed).toBe(true);
  });

  it('ignores a second start on an accepted stream rather than re-pointing it', async () => {
    const provider = await providerWithPlacedCall('call-1', 'CA123');
    await provider.originateCall({ to: '+15555550101', callId: 'call-2' });
    const { ws, events } = openStream(provider, { streamSid: 'MZ1', callSid: 'CA123', customParameters: { callId: 'call-1' } });
    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ2', callSid: 'CA123', customParameters: { callId: 'call-2' } } });

    expect(events.filter((e) => e.type === 'connected').map((e) => e.callId)).toEqual(['call-1']);
    expect(ws.closed).toBe(false);
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

describe('TwilioProvider.hangUp: a repeat hang-up is expected, not a warning', () => {
  // Every call logged "hangUp called with no known providerCallId" at WARN:
  // an ending tool hangs up (and the call is forgotten), then CallSession's
  // teardown hangs up again, as its own comment says it safely may. The
  // warning is still worth having for a call Twilio never knew about.
  function providerWithCall() {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (provider as any).client;
    Object.defineProperty(client, 'calls', { value: vi.fn(() => ({ update: vi.fn(async () => ({})) })), configurable: true });
    return provider;
  }

  it('does not warn when hanging up a call this provider already ended', async () => {
    const provider = providerWithCall();
    fakeLog.warn.mockClear();
    await provider.hangUp('CA-inbound-1');
    await provider.hangUp('CA-inbound-1');
    expect(fakeLog.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/no known providerCallId/));
  });

  it('still warns for a call it never knew about', async () => {
    const provider = new TwilioProvider();
    fakeLog.warn.mockClear();
    await provider.hangUp('CA-never-seen');
    expect(fakeLog.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/no known providerCallId/));
  });
});

describe('TwilioProvider.handleInboundMediaStreamConnection', () => {
  it('resolves callId from the start event\'s own callSid field, not customParameters', () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
    const ws = fakeWebSocket();
    provider.handleInboundMediaStreamConnection(ws as never);

    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));

    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ999', callSid: 'CA-inbound-1' } });

    expect(events).toEqual([
      { callId: 'CA-inbound-1', type: 'connected', meta: { callId: 'CA-inbound-1', providerCallId: 'CA-inbound-1', toNumber: '+15555550100' } },
    ]);
  });

  it('emits inbound audio as RAW mu-law bytes, not pre-decoded PCM16 — same behavior as the outbound handler', () => {
    // Same regression this file's outbound handleMediaStreamConnection test
    // guards against (see that describe block above) — the shared helper
    // must preserve it for inbound too.
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
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

describe('TwilioProvider recording (#8)', () => {
  it('startRecording starts a two-track recording on the live call', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-inbound-1', '+15555550100');
    const create = vi.fn(async () => ({ sid: 'RE123' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty((provider as any).client, 'calls', { value: vi.fn(() => ({ recordings: { create } })), configurable: true });

    await expect(provider.startRecording('CA-inbound-1')).resolves.toEqual({ recordingId: 'RE123' });
    expect(create).toHaveBeenCalledWith({ recordingChannels: 'dual', recordingTrack: 'both' });
  });

  it('startRecording refuses a call it has no Twilio id for', async () => {
    await expect(new TwilioProvider().startRecording('nope')).rejects.toThrow();
  });

  it('deleteRecording removes it, and treats "already gone" (404) as done', async () => {
    const provider = new TwilioProvider();
    const remove = vi.fn(async () => true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty((provider as any).client, 'recordings', { value: vi.fn(() => ({ remove })), configurable: true });
    await provider.deleteRecording('RE123');
    expect(remove).toHaveBeenCalled();

    remove.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }));
    await expect(provider.deleteRecording('RE-gone')).resolves.toBeUndefined();
    remove.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(provider.deleteRecording('RE-err')).rejects.toThrow('boom');
  });
});

describe('TwilioProvider.transferCall (#7)', () => {
  function withFakeCalls(provider: TwilioProvider, update = vi.fn(async () => ({})), recordingUpdate = vi.fn(async () => ({}))) {
    const recordings = Object.assign(vi.fn(() => ({ update: recordingUpdate })), { create: vi.fn(async () => ({ sid: 'RE-live' })) });
    const calls = vi.fn(() => ({ update, recordings }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty((provider as any).client, 'calls', { value: calls, configurable: true });
    return { update, recordingUpdate, calls };
  }

  it('redirects the live call to a <Dial> with an action callback and nothing after it', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-1', '+15555550100');
    const { update } = withFakeCalls(provider);

    await provider.transferCall('CA-1', { to: '+15557654321' });

    const twiml = (update.mock.calls[0] as unknown as [{ twiml: string }])[0].twiml;
    expect(twiml).toMatch(/<Dial[^>]*timeout="20"/);
    expect(twiml).toMatch(/<Dial[^>]*answerOnBridge="true"/);
    expect(twiml).toMatch(/action="https:\/\/[^"]+\/telephony\/twilio\/transfer-callback\?callId=CA-1"/);
    // #74: the principal's leg is screened before it is bridged.
    expect(twiml).toMatch(/<Number url="https:\/\/[^"]+\/telephony\/twilio\/transfer-screen\?callId=CA-1">\+15557654321<\/Number>/);
    expect(twiml).toMatch(/<\/Dial><\/Response>$/);
  });

  it('records nothing and plays no notice unless TRANSCRIBE_TRANSFERS is on', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-10', '+15555550100');
    const { update } = withFakeCalls(provider);
    await provider.transferCall('CA-10', { to: '+15557654321' });
    const twiml = (update.mock.calls[0] as unknown as [{ twiml: string }])[0].twiml;
    expect(twiml).not.toContain('record');
    expect(twiml).not.toContain('<Say');
  });

  it('with TRANSCRIBE_TRANSFERS, tells them it will be recorded before the dial, and records both sides apart', async () => {
    const { config } = await import('../../src/config/index.js');
    config.TRANSCRIBE_TRANSFERS = true;
    try {
      const provider = new TwilioProvider();
      provider.registerInboundCall('CA-11', '+15555550100');
      const { update } = withFakeCalls(provider);
      await provider.transferCall('CA-11', { to: '+15557654321' });
      const twiml = (update.mock.calls[0] as unknown as [{ twiml: string }])[0].twiml;
      expect(twiml).toMatch(/^<\?xml[^>]*\?><Response><Say>This call will be recorded\.<\/Say><Dial /);
      expect(twiml).toMatch(/<Dial[^>]*record="record-from-answer-dual"/);
      expect(twiml).toMatch(/<Dial[^>]*recordingStatusCallback="https:\/\/[^"]+\/telephony\/twilio\/transfer-recording\?callId=CA-11"/);
      expect(twiml).toMatch(/<Dial[^>]*recordingStatusCallbackEvent="completed"/);
      expect(new TwilioProvider().buildTransferScreenTwiml('CA-11')).toContain('This call is recorded. Press 1 to take it.');
    } finally {
      config.TRANSCRIBE_TRANSFERS = false;
    }
  });

  it('stops a running recording before transferring', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-2', '+15555550100');
    const { update, recordingUpdate, calls } = withFakeCalls(provider);
    await provider.startRecording('CA-2');

    await provider.transferCall('CA-2', { to: '+15557654321' });

    expect(recordingUpdate).toHaveBeenCalledWith({ status: 'stopped' });
    expect(recordingUpdate.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
    expect(calls).toHaveBeenCalledWith('CA-2');
  });

  it('still transfers when stopping the recording fails', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-3', '+15555550100');
    const { update } = withFakeCalls(provider, undefined, vi.fn(async () => { throw new Error('recording gone'); }));
    await provider.startRecording('CA-3');

    await provider.transferCall('CA-3', { to: '+15557654321' });
    expect(update).toHaveBeenCalled();
  });

  it('forgets the call after a successful redirect, so the session teardown hangUp() cannot end the bridged call', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-4', '+15555550100');
    const { update } = withFakeCalls(provider);

    await provider.transferCall('CA-4', { to: '+15557654321' });
    expect(provider.isAnyCallActive()).toBe(false);

    await provider.hangUp('CA-4');
    expect(update).toHaveBeenCalledTimes(1); // the redirect only, no { status: 'completed' }
  });

  it('keeps the call when the redirect fails, so Banjo can keep talking', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-5', '+15555550100');
    withFakeCalls(provider, vi.fn(async () => { throw new Error('twilio 500'); }));

    await expect(provider.transferCall('CA-5', { to: '+15557654321' })).rejects.toThrow('twilio 500');
    expect(provider.isAnyCallActive()).toBe(true);
  });

  it('refuses a call it has no Twilio id for', async () => {
    await expect(new TwilioProvider().transferCall('nope', { to: '+15557654321' })).rejects.toThrow();
  });

  it('never logs the TwiML (it holds the principal\'s number)', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-6', '+15555550100');
    withFakeCalls(provider);
    fakeLog.info.mockClear();
    await provider.transferCall('CA-6', { to: '+15557654321' });
    expect(JSON.stringify(fakeLog.info.mock.calls)).not.toContain('+15557654321');
  });
});

describe('TwilioProvider.buildTransferCallbackTwiml (#7)', () => {
  it('just hangs up after an answered transfer', () => {
    const twiml = new TwilioProvider().buildTransferCallbackTwiml('answered');
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('<Say');
  });

  it('says the fallback message, XML-escaped, then hangs up when not answered', async () => {
    const { config } = await import('../../src/config/index.js');
    const original = config.TRANSFER_FALLBACK_MESSAGE;
    config.TRANSFER_FALLBACK_MESSAGE = 'Smith & Sons <will> call "back"';
    try {
      const twiml = new TwilioProvider().buildTransferCallbackTwiml('no_answer');
      expect(twiml).toContain('Smith &amp; Sons &lt;will&gt; call');
      expect(twiml).toMatch(/<\/Say><Hangup\/><\/Response>$/);
    } finally {
      config.TRANSFER_FALLBACK_MESSAGE = original;
    }
  });
});

describe('TwilioProvider: transfer screening (#74)', () => {
  // Live, 2026-09-26: the principal let the transfer ring, their carrier
  // voicemail picked up inside the dial timeout, and Twilio reported the dial
  // 'completed' — recorded as answered, the caller bridged into voicemail and
  // never told they weren't reached. Only a press of 1 counts as answered.
  it('asks the principal to press 1, then hangs up their leg if they do not', () => {
    const twiml = new TwilioProvider().buildTransferScreenTwiml('CA-9');
    expect(twiml).toMatch(/<Gather[^>]*numDigits="1"/);
    expect(twiml).toMatch(/<Gather[^>]*action="https:\/\/[^"]+\/telephony\/twilio\/transfer-screen-result\?callId=CA-9"/);
    expect(twiml).toMatch(/<Say[^>]*loop="2"[^>]*>[^<]*[Pp]ress 1[^<]*<\/Say><\/Gather>/);
    expect(twiml).toMatch(/<Gather[^>]*timeout="5"/);
    expect(twiml).not.toContain('actionOnEmptyResult'); // no key must fall through to the hang-up
    expect(twiml).toMatch(/<\/Gather><Hangup\/><\/Response>$/);
  });

  it('bridges on a 1, and remembers it once for the transfer callback', () => {
    const provider = new TwilioProvider();
    const twiml = provider.acceptTransferScreen('CA-10', '1');
    expect(twiml).not.toContain('Hangup');
    expect(twiml).toMatch(/<Say>Connecting\.<\/Say><\/Response>$/); // then the screen ends, and Twilio bridges
    expect(provider.takeTransferAccepted('CA-10')).toBe(true);
    expect(provider.takeTransferAccepted('CA-10')).toBe(false);
  });

  it.each([['2'], [''], ['*']])('hangs up the principal\'s leg on %j, and does not count it as accepted', (digits) => {
    const provider = new TwilioProvider();
    const twiml = provider.acceptTransferScreen('CA-11', digits);
    expect(twiml).toContain('<Hangup/>');
    expect(provider.takeTransferAccepted('CA-11')).toBe(false);
  });

  it('keeps acceptances apart per call', () => {
    const provider = new TwilioProvider();
    provider.acceptTransferScreen('CA-12', '1');
    expect(provider.takeTransferAccepted('CA-13')).toBe(false);
    expect(provider.takeTransferAccepted('CA-12')).toBe(true);
  });

  it('forgets an acceptance whose transfer callback never came, after four hours', () => {
    vi.useFakeTimers();
    try {
      const provider = new TwilioProvider();
      provider.acceptTransferScreen('CA-14', '1');
      vi.advanceTimersByTime(3 * 60 * 60_000);
      provider.acceptTransferScreen('CA-16', '1');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((provider as any).acceptedTransfers.has('CA-14')).toBe(true); // a long bridged call keeps its entry
      vi.advanceTimersByTime(61 * 60_000);
      provider.acceptTransferScreen('CA-15', '1'); // any later acceptance sweeps stale ones
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((provider as any).acceptedTransfers.has('CA-14')).toBe(false);
      expect(provider.takeTransferAccepted('CA-15')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TwilioProvider status callback (#79)', () => {
  /** A provider with `callId` originated (REST mocked) but no media stream opened yet. */
  async function providerWithOriginatedCall(callId = 'call-1') {
    const provider = new TwilioProvider();
    const create = vi.fn(async () => ({ sid: 'CA-out-1' }));
    Object.defineProperty((provider as any).client, 'calls', { value: Object.assign(vi.fn(), { create }), configurable: true });
    await provider.originateCall({ to: '+15555550100', callId });
    const events: TelephonyEvent[] = [];
    provider.on('event', (e) => events.push(e));
    return { provider, create, events };
  }

  it('asks Twilio for a status callback carrying our callId', async () => {
    const { create } = await providerWithOriginatedCall();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCallback: expect.stringContaining('/telephony/twilio/status-callback?callId=call-1'),
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['completed'],
      }),
    );
  });

  it.each(['failed', 'busy', 'no-answer', 'canceled', 'completed'])(
    "ends a call that never connected when Twilio reports '%s'",
    async (status) => {
      const { provider, events } = await providerWithOriginatedCall();

      provider.handleStatusCallback('call-1', status);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ callId: 'call-1', type: 'ended' });
      expect((events[0] as { reason: string }).reason).not.toBe('');
      // Forgotten, so a later hangUp() from the session's teardown is a quiet no-op.
      fakeLog.warn.mockClear();
      await provider.hangUp('call-1');
      expect(fakeLog.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no known providerCallId'));
    },
  );

  it('ignores a status for a call whose media stream opened — the stream owns its end', async () => {
    const { provider, events } = await providerWithOriginatedCall();
    const ws = fakeWebSocket();
    provider.handleMediaStreamConnection(ws as never);
    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA-out-1', customParameters: { callId: 'call-1' } } });
    events.length = 0;

    provider.handleStatusCallback('call-1', 'completed');

    expect(events).toEqual([]);
  });

  it('ignores a status arriving after the stream already ended the call', async () => {
    const { provider, events } = await providerWithOriginatedCall();
    const ws = fakeWebSocket();
    provider.handleMediaStreamConnection(ws as never);
    ws.emitMessage({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA-out-1', customParameters: { callId: 'call-1' } } });
    ws.emitMessage({ event: 'stop' });
    events.length = 0;

    provider.handleStatusCallback('call-1', 'completed');

    expect(events).toEqual([]);
  });

  it('ignores unknown calls and non-final statuses', async () => {
    const { provider, events } = await providerWithOriginatedCall();

    provider.handleStatusCallback('some-other-call', 'failed');
    provider.handleStatusCallback('call-1', 'ringing');

    expect(events).toEqual([]);
  });
});

describe('TwilioProvider warm transfer (#149)', () => {
  const OWNER = '+15557654321';
  const BRIEF = "Pam at Claudia's needs you about the vaccination records.";

  /** A provider with one live call, and fakes for creating the owner's call and updating either leg. */
  function setup(callId: string, opts: { create?: ReturnType<typeof vi.fn> } = {}) {
    const provider = new TwilioProvider();
    provider.registerInboundCall(callId, '+15555550100');
    const create = opts.create ?? vi.fn(async () => ({ sid: 'CA-owner' }));
    const updates = new Map<string, ReturnType<typeof vi.fn>>();
    const recordingUpdate = vi.fn(async () => ({}));
    const recordings = Object.assign(vi.fn(() => ({ update: recordingUpdate })), { create: vi.fn(async () => ({ sid: 'RE-live' })) });
    const calls = Object.assign(
      vi.fn((sid: string) => {
        if (!updates.has(sid)) updates.set(sid, vi.fn(async () => ({})));
        return { update: updates.get(sid)!, recordings };
      }),
      { create },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty((provider as any).client, 'calls', { value: calls, configurable: true });
    const update = (sid: string) => updates.get(sid) ?? vi.fn();
    return { provider, create, update, recordingUpdate };
  }

  const loopIn = (provider: TwilioProvider, callId: string, timeoutMs = 60_000) =>
    provider.loopInOwner(callId, { to: OWNER, brief: BRIEF, timeoutMs });

  it('calls the owner on a second line with the brief and a press-1 prompt, without touching the live call', async () => {
    const { provider, create, update } = setup('CA-w1');
    void loopIn(provider, 'CA-w1');
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    const args = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(args.to).toBe(OWNER);
    expect(args.statusCallback).toMatch(/\/telephony\/twilio\/loop-in-status\?callId=CA-w1$/);
    expect(args.statusCallbackEvent).toEqual(['completed']);
    const twiml = args.twiml as string;
    expect(twiml).toMatch(/<Gather[^>]*action="https:\/\/[^"]+\/telephony\/twilio\/loop-in-result\?callId=CA-w1"/);
    expect(twiml).toContain(`<Say>${BRIEF}</Say>`);
    expect(twiml).toContain('Press 1 to talk to them now');
    expect(twiml).toMatch(/<Hangup\/><\/Response>$/);
    expect(update('CA-w1')).not.toHaveBeenCalled();
    expect(provider.isAnyCallActive()).toBe(true);
  });

  it('accept: stops the recording, moves the call into a conference the owner joins, and lets the call go', async () => {
    const { provider, update, recordingUpdate } = setup('CA-w2');
    await provider.startRecording('CA-w2');
    const result = loopIn(provider, 'CA-w2');
    await vi.waitFor(() => expect(provider['loopIns'].get('CA-w2')?.ownerCallSid).toBe('CA-owner'));

    const ownerTwiml = await provider.acceptLoopIn('CA-w2', '1');

    await expect(result).resolves.toBe('accepted');
    expect(recordingUpdate).toHaveBeenCalledWith({ status: 'stopped' });
    const theirs = (update('CA-w2').mock.calls[0] as unknown as [{ twiml: string }])[0].twiml;
    expect(theirs).toMatch(/<Conference[^>]*endConferenceOnExit="true"[^>]*>banjo-CA-w2<\/Conference>/);
    expect(ownerTwiml).toMatch(/<Conference[^>]*endConferenceOnExit="true"[^>]*>banjo-CA-w2<\/Conference>/);
    expect(recordingUpdate.mock.invocationCallOrder[0]).toBeLessThan(update('CA-w2').mock.invocationCallOrder[0]!);
    // Forgotten, so CallSession's teardown hang-up can't end the bridged call.
    expect(provider.isAnyCallActive()).toBe(false);
    await provider.hangUp('CA-w2');
    expect(update('CA-w2')).toHaveBeenCalledTimes(1);
    expect(update('CA-owner')).not.toHaveBeenCalled();
  });

  it('decline: any other key hangs up the owner and leaves the call with Banjo', async () => {
    const { provider, update } = setup('CA-w3');
    const result = loopIn(provider, 'CA-w3');
    await vi.waitFor(() => expect(provider['loopIns'].get('CA-w3')?.ownerCallSid).toBe('CA-owner'));

    const ownerTwiml = await provider.acceptLoopIn('CA-w3', '2');

    await expect(result).resolves.toBe('declined');
    expect(ownerTwiml).toMatch(/<Hangup\/><\/Response>$/);
    expect(ownerTwiml).not.toContain('Conference');
    expect(update('CA-w3')).not.toHaveBeenCalled();
    expect(provider.isAnyCallActive()).toBe(true);
  });

  it("no answer: the owner's leg ending without a key press (busy, unanswered, their voicemail) leaves the call with Banjo", async () => {
    const { provider } = setup('CA-w4');
    const result = loopIn(provider, 'CA-w4');
    await vi.waitFor(() => expect(provider['loopIns'].get('CA-w4')?.ownerCallSid).toBe('CA-owner'));

    provider.handleLoopInStatus('CA-w4', 'completed');

    await expect(result).resolves.toBe('no_answer');
    expect(provider.isAnyCallActive()).toBe(true);
  });

  it("gives up after timeoutMs and hangs up the owner's line", async () => {
    vi.useFakeTimers();
    try {
      const { provider, update } = setup('CA-w5');
      const result = loopIn(provider, 'CA-w5', 1_000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe('no_answer');
      expect(update('CA-owner')).toHaveBeenCalledWith({ status: 'completed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops ringing the owner when the other party hangs up first", async () => {
    const { provider, update } = setup('CA-w6');
    const result = loopIn(provider, 'CA-w6');
    await vi.waitFor(() => expect(provider['loopIns'].get('CA-w6')?.ownerCallSid).toBe('CA-owner'));

    await provider.hangUp('CA-w6');

    await expect(result).resolves.toBe('no_answer');
    expect(update('CA-owner')).toHaveBeenCalledWith({ status: 'completed' });
  });

  it('a 1 that comes after the wait is over gets an apology, not a bridge', async () => {
    const { provider, update } = setup('CA-w7');
    const result = loopIn(provider, 'CA-w7');
    await vi.waitFor(() => expect(provider['loopIns'].get('CA-w7')?.ownerCallSid).toBe('CA-owner'));
    provider.handleLoopInStatus('CA-w7', 'no-answer');
    await result;

    const ownerTwiml = await provider.acceptLoopIn('CA-w7', '1');
    expect(ownerTwiml).toContain('already ended');
    expect(update('CA-w7')).not.toHaveBeenCalled();
  });

  it('keeps the call with Banjo when the bridge redirect fails', async () => {
    const { provider, update } = setup('CA-w8');
    const result = loopIn(provider, 'CA-w8');
    await vi.waitFor(() => expect(provider['loopIns'].get('CA-w8')?.ownerCallSid).toBe('CA-owner'));
    // Calling update() for an unseen sid creates its fake; make the live call's reject.
    provider['client'].calls('CA-w8');
    update('CA-w8').mockRejectedValueOnce(new Error('twilio 500'));

    const ownerTwiml = await provider.acceptLoopIn('CA-w8', '1');

    await expect(result).resolves.toBe('no_answer');
    expect(ownerTwiml).toContain("couldn't connect you");
    expect(provider.isAnyCallActive()).toBe(true);
  });

  it("throws, and leaves nothing pending, when the owner's call can't be placed", async () => {
    const { provider } = setup('CA-w9', { create: vi.fn(async () => { throw new Error('twilio 400'); }) });
    await expect(loopIn(provider, 'CA-w9')).rejects.toThrow('twilio 400');
    expect(provider['loopIns'].has('CA-w9')).toBe(false);
  });

  it('refuses a call it has no Twilio id for', async () => {
    await expect(loopIn(new TwilioProvider(), 'nope')).rejects.toThrow();
  });

  it('escapes the brief, so words from the call can never become TwiML', () => {
    const twiml = new TwilioProvider().buildLoopInTwiml('CA-x', 'Hi</Say><Dial>+15550000000</Dial><Say>');
    expect(twiml).not.toContain('<Dial>');
    expect(twiml).toContain('&lt;Dial&gt;');
  });

  it("never logs the owner's number or the brief", async () => {
    const { provider } = setup('CA-w10');
    fakeLog.info.mockClear();
    const result = loopIn(provider, 'CA-w10');
    await vi.waitFor(() => expect(provider['loopIns'].get('CA-w10')?.ownerCallSid).toBe('CA-owner'));
    await provider.acceptLoopIn('CA-w10', '2');
    await result;
    const logged = JSON.stringify(fakeLog.info.mock.calls);
    expect(logged).not.toContain(OWNER);
    expect(logged).not.toContain('vaccination');
  });
});

describe('TwilioProvider.stopRecording (#151)', () => {
  /** A live call whose Twilio recordings are `listed`; each recording's update is the shared `update` spy, called with its sid. */
  function withRecordings(callId: string, listed: { sid: string; status: string }[] | Error) {
    const provider = new TwilioProvider();
    provider.registerInboundCall(callId, '+15555550100');
    const update = vi.fn(async (_sid: string, _params: unknown) => ({}));
    const list = vi.fn(async () => {
      if (listed instanceof Error) throw listed;
      return listed;
    });
    const recordings = Object.assign(
      vi.fn((sid: string) => ({ update: (params: unknown) => update(sid, params) })),
      { list, create: vi.fn(async () => ({ sid: 'RE-live' })) },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty((provider as any).client, 'calls', { value: vi.fn(() => ({ recordings })), configurable: true });
    return { provider, update, list };
  }

  it("stops every running or paused recording Twilio reports, including one Banjo never got the SID of", async () => {
    const { provider, update } = withRecordings('CA-r1', [
      { sid: 'RE-known', status: 'in-progress' },
      { sid: 'RE-lost-response', status: 'in-progress' },
      { sid: 'RE-paused', status: 'paused' },
      { sid: 'RE-old', status: 'completed' },
    ]);
    await provider.stopRecording('CA-r1');
    expect(update.mock.calls).toEqual([
      ['RE-known', { status: 'stopped' }],
      ['RE-lost-response', { status: 'stopped' }],
      ['RE-paused', { status: 'stopped' }],
    ]);
  });

  it('has nothing to stop when nothing is running', async () => {
    const { provider, update } = withRecordings('CA-r2', []);
    await expect(provider.stopRecording('CA-r2')).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it("fails closed: throws when Twilio can't be asked, or refuses the stop, or the call is unknown", async () => {
    await expect(withRecordings('CA-r3', new Error('twilio 500')).provider.stopRecording('CA-r3')).rejects.toThrow('twilio 500');
    const { provider, update } = withRecordings('CA-r4', [{ sid: 'RE-1', status: 'in-progress' }]);
    update.mockRejectedValueOnce(new Error('cannot stop'));
    await expect(provider.stopRecording('CA-r4')).rejects.toThrow('cannot stop');
    await expect(new TwilioProvider().stopRecording('nope')).rejects.toThrow();
  });

  it("stops the recording this process started even when Twilio's list doesn't show it yet", async () => {
    const { provider, update } = withRecordings('CA-r5', []);
    await provider.startRecording('CA-r5'); // RE-live
    await provider.stopRecording('CA-r5');
    expect(update.mock.calls).toEqual([['RE-live', { status: 'stopped' }]]);
  });

  it('fails closed after a start that failed once sent: an empty list is not proof nothing is recording', async () => {
    const { provider } = withRecordings('CA-r6', []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recordings = (provider as any).client.calls('CA-r6').recordings;
    recordings.create.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(provider.startRecording('CA-r6')).rejects.toThrow('socket hang up');
    await expect(provider.stopRecording('CA-r6')).rejects.toThrow(/no stop can be confirmed/);
  });

  it('after an uncertain start, stops what Twilio does list and still refuses to confirm', async () => {
    const { provider, update } = withRecordings('CA-r7', [{ sid: 'RE-other', status: 'in-progress' }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client.calls('CA-r7').recordings.create.mockRejectedValueOnce(new Error('timeout'));
    await expect(provider.startRecording('CA-r7')).rejects.toThrow();
    // The listed one may not be the one that start made, which may not be listed yet.
    await expect(provider.stopRecording('CA-r7')).rejects.toThrow(/no stop can be confirmed/);
    expect(update.mock.calls).toEqual([['RE-other', { status: 'stopped' }]]);
  });
});
