import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProvider } from '../../src/calendar/types.js';
import type { Contact } from '../../src/contacts/schema.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';
import type { TelephonyEvent, TelephonyProvider } from '../../src/telephony/providers/types.js';
import type { VoiceAIEvent, VoiceAIProvider } from '../../src/voice/types.js';

/**
 * transfer_to_owner run end to end through a real CallSession and the real
 * outbound adapter (#7): the tool redirects the call, then Twilio's stream
 * 'stop' ends the session. Only the edges are faked — the voice AI, the
 * telephony provider, the task store and the SMS channel.
 */

// An in-memory task store that behaves like transitionTask: a terminal task
// stays put.
const TERMINAL = new Set(['confirmed', 'voicemail_left', 'negotiation_failed', 'escalated', 'conversation_completed', 'failed', 'cancelled', 'transferred']);
const store = vi.hoisted(() => ({ task: undefined as unknown as { id: string; status: string; outcome: unknown; contactId: string; mode: string } }));
const transitionTask = vi.hoisted(() => vi.fn());
vi.mock('../../src/tasks/service.js', () => ({
  getTask: vi.fn(async () => ({ ...store.task })),
  isTerminalStatus: (status: string) => TERMINAL.has(status),
  updateCallAttempt: vi.fn(async () => {}),
  transitionTask,
}));

const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/notifications/twilioSms.js', () => ({
  createNotificationChannel: () => ({ notify }),
  sendOwnerSms: vi.fn(async () => {}),
}));

const contact = { id: "contact-1", displayName: "Luigi's", phoneNumber: "+15555550100" } as unknown as Contact;
vi.mock('../../src/contacts/service.js', () => ({ getContact: vi.fn(async () => contact) }));
vi.mock('../../src/transcripts/service.js', () => ({ saveTranscriptTurn: vi.fn(async () => {}) }));

const voiceAIEmitter = new EventEmitter();
const fakeVoiceAI = {
  name: 'fake-voice',
  connect: vi.fn(async () => {}),
  sendAudioChunk: vi.fn(),
  sendToolResult: vi.fn(),
  interrupt: vi.fn(),
  triggerResponse: vi.fn(),
  sayVerbatim: vi.fn(),
  disconnect: vi.fn(async () => {}),
  on: vi.fn((_event: 'event', listener: (e: VoiceAIEvent) => void) => voiceAIEmitter.on('event', listener)),
  off: vi.fn((_event: 'event', listener: (e: VoiceAIEvent) => void) => voiceAIEmitter.off('event', listener)),
} satisfies VoiceAIProvider;
vi.mock('../../src/voice/factory.js', () => ({ createVoiceAIProvider: () => fakeVoiceAI }));

const { config } = await import('../../src/config/index.js');
const { CallSession } = await import('../../src/session/callSession.js');
const { buildOutboundCallSessionOptions } = await import('../../src/tasks/callSessionAdapter.js');

const callAttempt = { id: 'call-attempt-1' } as CallAttempt;

/** A telephony fake whose transferCall resolves when the test says so, like a slow Twilio REST call. */
function makeTelephony() {
  const emitter = new EventEmitter();
  let finishRedirect!: () => void;
  const provider: TelephonyProvider = {
    name: 'fake-telephony',
    nativeAudioFormat: 'g711_ulaw_8k',
    originateCall: vi.fn(async () => ({ providerCallId: 'CA-fake-sid' })),
    sendAudio: vi.fn(),
    sendDigits: vi.fn(async () => {}),
    interrupt: vi.fn(),
    hangUp: vi.fn(async () => {}),
    transferCall: vi.fn(() => new Promise<void>((resolve) => (finishRedirect = resolve))),
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
  };
  return {
    provider,
    emit: (e: TelephonyEvent) => emitter.emit('event', e),
    finishRedirect: () => finishRedirect(),
  };
}

async function startTransferCall() {
  const telephony = makeTelephony();
  const options = buildOutboundCallSessionOptions({
    task: store.task as unknown as Task,
    callAttempt,
    contact,
    telephony: telephony.provider,
    calendar: {} as CalendarProvider,
    systemPrompt: 'irrelevant',
  });
  await new CallSession(options).start();
  telephony.emit({ callId: callAttempt.id, type: 'connected' } as TelephonyEvent);
  voiceAIEmitter.emit('event', {
    type: 'tool_call',
    call: { id: 'tc-1', name: 'transfer_to_owner', arguments: { reason: 'they need a card number' } },
  } satisfies VoiceAIEvent);
  // endsCall: the session waits for the handoff line's turn_end first.
  voiceAIEmitter.emit('event', { type: 'turn_end' } satisfies VoiceAIEvent);
  return telephony;
}

const transitionsTo = (status: string) => transitionTask.mock.calls.filter((c) => c[1] === status);

beforeEach(() => {
  vi.clearAllMocks();
  voiceAIEmitter.removeAllListeners('event');
  config.TRANSFER_ENABLED = true;
  config.TRANSFER_TO_PHONE_NUMBER = '+15557654321';
  store.task = { id: 'task-1', status: 'negotiating', outcome: null, contactId: contact.id, mode: 'booking' };
  transitionTask.mockImplementation(async (_id: string, status: string, opts: { outcome?: unknown } = {}) => {
    if (TERMINAL.has(store.task.status)) return;
    store.task = { ...store.task, status, outcome: opts.outcome ?? store.task.outcome };
  });
});
afterEach(() => {
  config.TRANSFER_ENABLED = false;
  vi.useRealTimers();
});

describe('transfer_to_owner through a real CallSession (#7)', () => {
  it('notifies the owner exactly once, with the transferred outcome, when the stream stops after the redirect', async () => {
    const telephony = await startTransferCall();
    await vi.waitFor(() => expect(telephony.provider.transferCall).toHaveBeenCalled());
    telephony.finishRedirect();
    await vi.waitFor(() => expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('tc-1', { ok: true }, false));

    // Twilio's stream 'stop' once the call has left the <Connect><Stream>.
    telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'stop' });
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(store.task.status).toBe('transferred');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('task-1', expect.objectContaining({ kind: 'transferred' }), expect.any(String));
  });

  it('a redirect that takes longer than TOOL_TIMEOUT_MS is not reported to the model as failed, and the task ends transferred', async () => {
    vi.useFakeTimers();
    const telephony = await startTransferCall();
    await vi.advanceTimersByTimeAsync(1_000); // the handoff line plays out
    expect(telephony.provider.transferCall).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000); // Twilio is slow: past TOOL_TIMEOUT_MS and the default 15s watchdog
    expect(fakeVoiceAI.sendToolResult).not.toHaveBeenCalled();
    expect(telephony.provider.hangUp).not.toHaveBeenCalled();

    telephony.finishRedirect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeVoiceAI.sendToolResult).toHaveBeenCalledWith('tc-1', { ok: true }, false);

    telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'stop' });
    await vi.advanceTimersByTimeAsync(100);

    expect(store.task.status).toBe('transferred');
    expect(transitionsTo('failed')).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('task-1', expect.objectContaining({ kind: 'transferred' }), expect.any(String));
  });

  it("end() keeps waiting for a slow redirect when the stream stops before Twilio's REST response returns", async () => {
    vi.useFakeTimers();
    const telephony = await startTransferCall();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(telephony.provider.transferCall).toHaveBeenCalled();

    // Twilio applied the new TwiML and stopped the stream; its REST response is still on the way.
    telephony.emit({ callId: callAttempt.id, type: 'ended', reason: 'stop' });
    await vi.advanceTimersByTimeAsync(25_000); // past the default tool budget plus its margin
    expect(transitionsTo('failed')).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();

    telephony.finishRedirect();
    await vi.advanceTimersByTimeAsync(100);

    expect(store.task.status).toBe('transferred');
    expect(transitionsTo('failed')).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
