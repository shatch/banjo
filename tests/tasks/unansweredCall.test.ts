import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProvider } from '../../src/calendar/types.js';
import type { Contact } from '../../src/contacts/schema.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';
import type { VoiceAIEvent, VoiceAIProvider } from '../../src/voice/types.js';

// The real TwilioProvider, CallSession, and outbound adapter wired together —
// only persistence, notifications, and the two vendor SDKs are faked. Covers
// the bug end to end: an outbound call that nobody answers never opens a Media
// Stream, so before the status callback nothing ended its session, it stayed
// in the live-call registry (which the stale-call sweep skips), and its task
// sat in 'calling' until the process restarted.

const voiceEvents = new EventEmitter();
const fakeVoiceAI = {
  name: 'fake-voice',
  connect: vi.fn(async () => {}),
  sendAudioChunk: vi.fn(),
  sendToolResult: vi.fn(),
  interrupt: vi.fn(),
  triggerResponse: vi.fn(),
  sayVerbatim: vi.fn(),
  disconnect: vi.fn(async () => {}),
  on: (_e: 'event', l: (e: VoiceAIEvent) => void) => voiceEvents.on('event', l),
  off: (_e: 'event', l: (e: VoiceAIEvent) => void) => voiceEvents.off('event', l),
} satisfies VoiceAIProvider;
vi.mock('../../src/voice/factory.js', () => ({ createVoiceAIProvider: () => fakeVoiceAI }));

const { taskStore, getTask, transitionTask, updateCallAttempt } = vi.hoisted(() => {
  const taskStore = new Map<string, { id: string; status: string; outcome?: unknown }>();
  return {
    taskStore,
    getTask: vi.fn(async (id: string) => taskStore.get(id)),
    transitionTask: vi.fn(async (id: string, status: string, patch: { outcome?: unknown }) => {
      const task = { ...taskStore.get(id)!, status, ...patch };
      taskStore.set(id, task);
      return task;
    }),
    updateCallAttempt: vi.fn(async () => {}),
  };
});
vi.mock('../../src/tasks/service.js', () => ({
  getTask,
  transitionTask,
  updateCallAttempt,
  isTerminalStatus: (status: string) => !['pending', 'checking_availability', 'calling', 'negotiating'].includes(status),
}));
vi.mock('../../src/transcripts/service.js', () => ({ saveTranscriptTurn: vi.fn(async () => {}) }));

const contact = { id: 'contact-1', displayName: "Luigi's", phoneNumber: '+15551230000' } as Contact;
vi.mock('../../src/contacts/service.js', () => ({ getContact: vi.fn(async () => contact) }));

const { notify } = vi.hoisted(() => ({ notify: vi.fn(async () => {}) }));
vi.mock('../../src/notifications/twilioSms.js', () => ({ createNotificationChannel: () => ({ notify }) }));

const { TwilioProvider } = await import('../../src/telephony/providers/twilio.js');
const { CallSession } = await import('../../src/session/callSession.js');
const { buildOutboundCallSessionOptions } = await import('../../src/tasks/callSessionAdapter.js');
const { getLiveCall, registerLiveCall } = await import('../../src/tasks/liveCalls.js');

const calendar = {} as CalendarProvider;

beforeEach(() => {
  vi.clearAllMocks();
  taskStore.clear();
});

describe('an outbound call nobody answers', () => {
  it('ends the call, fails the task with "no one answered", leaves the live-call registry, and notifies the owner', async () => {
    const task = { id: 'task-1', status: 'calling', mode: 'booking', contactId: contact.id } as unknown as Task;
    taskStore.set(task.id, { id: task.id, status: 'calling' });
    const callAttempt = { id: 'attempt-1' } as CallAttempt;

    const telephony = new TwilioProvider();
    const create = vi.fn(async () => ({ sid: 'CA-out-1' }));
    const hangUpRest = vi.fn();
    Object.defineProperty((telephony as any).client, 'calls', { value: Object.assign(hangUpRest, { create }), configurable: true });

    const session = new CallSession(
      buildOutboundCallSessionOptions({ task, callAttempt, contact, telephony, calendar, systemPrompt: 'prompt' }),
    );
    registerLiveCall({ taskId: task.id, callAttemptId: callAttempt.id, session });
    await session.start();
    expect(getLiveCall(task.id)).toBeDefined();

    // Twilio rings out and reports the final status (see /telephony/twilio/status).
    telephony.handleStatusCallback(callAttempt.id, 'no-answer', 'CA-out-1');

    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(taskStore.get(task.id)).toMatchObject({ status: 'failed', outcome: { kind: 'failed', reason: 'no one answered' } });
    expect(getLiveCall(task.id)).toBeUndefined();
    expect(updateCallAttempt).toHaveBeenCalledWith(callAttempt.id, expect.objectContaining({ status: 'ended', endedAt: expect.any(Date) }));
    expect(notify).toHaveBeenCalledWith(task.id, { kind: 'failed', reason: 'no one answered' }, "Couldn't complete the call to Luigi's — no one answered.");
    expect(fakeVoiceAI.disconnect).toHaveBeenCalled();
    // The call is already over at Twilio: no REST hang-up is attempted.
    expect(hangUpRest).not.toHaveBeenCalled();
  });
});
