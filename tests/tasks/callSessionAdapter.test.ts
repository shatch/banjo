import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProvider } from '../../src/calendar/types.js';
import type { Contact } from '../../src/contacts/schema.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';

// buildOutboundCallSessionOptions's onStatusChange/onFailure call through to
// tasks/service.js (getTask/transitionTask/updateCallAttempt) — stub the
// whole persistence layer so those closures can be exercised directly,
// matching the pattern used in tests/voice/callTools.test.ts.
const { getTask, transitionTask, updateCallAttempt } = vi.hoisted(() => ({
  getTask: vi.fn(async () => undefined as Task | undefined),
  transitionTask: vi.fn(async () => {}),
  updateCallAttempt: vi.fn(async () => {}),
}));
vi.mock('../../src/tasks/service.js', () => ({
  getTask,
  transitionTask,
  updateCallAttempt,
}));

const { buildOutboundCallSessionOptions } = await import('../../src/tasks/callSessionAdapter.js');

// Minimal fakes mirroring tests/session/callSession.test.ts's style — only
// the shape needed to construct buildOutboundCallSessionOptions's params;
// none of these fakes' methods are actually invoked by this test since we
// only inspect the returned options object, not any of its closures.
const fakeTask = { id: 'task-1' } as Task;
const fakeCallAttempt = { id: 'call-attempt-1' } as CallAttempt;
const fakeContact = { id: 'contact-1', phoneNumber: '+15555550100' } as Contact;

const fakeTelephony: TelephonyProvider = {
  name: 'fake-telephony',
  nativeAudioFormat: 'g711_ulaw_8k',
  originateCall: vi.fn(async () => ({ providerCallId: 'CA-fake-sid' })),
  sendAudio: vi.fn(),
  sendDigits: vi.fn(async () => {}),
  interrupt: vi.fn(),
  hangUp: vi.fn(async () => {}),
  on: vi.fn(),
  off: vi.fn(),
};

const fakeCalendar: CalendarProvider = {
  computeCandidateWindows: vi.fn(async () => []),
  isFree: vi.fn(async () => true),
  createEventIdempotent: vi.fn(async () => ({
    eventId: 'evt-1',
    confirmedStart: '2026-08-04T18:00:00.000Z',
    confirmedEnd: '2026-08-04T18:30:00.000Z',
  })),
  deleteEvent: vi.fn(async () => {}),
};

describe('buildOutboundCallSessionOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wires up the base outbound tool set (press_digits + callTools) for a booking-mode task', () => {
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

    expect(options.tools.some((t) => t.name === 'press_digits')).toBe(true);
    expect(options.tools.length).toBeGreaterThan(1);
    expect(options.tools.some((t) => t.name === 'end_conversation_call')).toBe(false);
  });

  it('adds end_conversation_call to the tool set for a conversation-mode task, without removing anything', () => {
    const bookingOptions = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });
    const conversationOptions = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'conversation' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

    expect(conversationOptions.tools.some((t) => t.name === 'end_conversation_call')).toBe(true);
    expect(conversationOptions.tools.length).toBe(bookingOptions.tools.length + 1);
    // Everything in the booking-mode list is still present in the conversation-mode list.
    for (const t of bookingOptions.tools) {
      expect(conversationOptions.tools.some((c) => c.name === t.name)).toBe(true);
    }
  });

  it("onStatusChange('ended'): marks a still-non-terminal task 'failed' instead of leaving it orphaned — a real call ended (far end hung up / socket closed) before the model ever called an outcome tool, and the task was left stuck at its in-progress status forever with no outcome recorded and no notification ever sent (notifyIfTerminal is a no-op without an outcome)", async () => {
    getTask.mockResolvedValueOnce({ id: 'task-1', status: 'negotiating' } as unknown as Task);
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'conversation' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

    await options.onStatusChange({ kind: 'ended', reason: 'stop' });

    expect(getTask).toHaveBeenCalledWith('task-1');
    expect(transitionTask).toHaveBeenCalledWith('task-1', 'failed', {
      outcome: { kind: 'failed', reason: 'stop' },
    });
  });

  it("onStatusChange('ended'): does not touch a task that already reached a terminal status (e.g. confirm_appointment already ran) before the call ended", async () => {
    getTask.mockResolvedValueOnce({ id: 'task-1', status: 'confirmed' } as unknown as Task);
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'irrelevant for this test',
    });

    await options.onStatusChange({ kind: 'ended', reason: 'stop' });

    expect(transitionTask).not.toHaveBeenCalled();
  });

  it('passes frontendSystemPrompt through, and puts a verbatim delivery report on the tool context for the voicemail handler', async () => {
    const options = buildOutboundCallSessionOptions({
      task: { ...fakeTask, mode: 'booking' } as Task,
      callAttempt: fakeCallAttempt,
      contact: fakeContact,
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      systemPrompt: 'full prompt',
      frontendSystemPrompt: 'voice prompt',
    });
    expect(options.frontendSystemPrompt).toBe('voice prompt');

    const report = { intended: 'call back at 555-1234', spoken: 'call back', matched: false };
    const ctx = await options.buildToolContext(123, report);
    expect(ctx.verbatimDelivery).toBe(report);
    expect(ctx.estimatedAudioDoneAt).toBe(123);
  });
});
