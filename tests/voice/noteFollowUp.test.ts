import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallContext } from '../../src/session/types.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';

// Same persistence stub as tests/voice/reportAnswers.test.ts.
const { transitionTask, saveFollowUp } = vi.hoisted(() => ({
  transitionTask: vi.fn(async (id: string, status: string) => ({ id, status }) as unknown as Task),
  saveFollowUp: vi.fn(async () => true),
}));
vi.mock('../../src/tasks/service.js', () => ({
  transitionTask,
  saveFollowUp,
  MAX_FOLLOW_UPS: 5,
  isTerminalStatus: (status: string) => !['pending', 'checking_availability', 'calling', 'negotiating'].includes(status),
}));

const { commonCallTools, noteFollowUpTool } = await import('../../src/voice/tools/callTools.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function ctx(hangUp: TelephonyProvider['hangUp'] = vi.fn()): CallContext {
  return {
    task: { id: 'task-1', status: 'negotiating', mode: 'conversation', followUps: null } as Task,
    callAttempt: { id: 'call-attempt-1' } as CallAttempt,
    callId: 'call-attempt-1',
    telephony: { hangUp } as unknown as TelephonyProvider,
    calendar: {} as CallContext['calendar'],
    estimatedAudioDoneAt: Date.now(),
  };
}

describe('note_follow_up (#160)', () => {
  it('is on every outbound call, and does not end the call', () => {
    expect(commonCallTools.some((t) => t.name === 'note_follow_up')).toBe(true);
    expect(noteFollowUpTool.endsCall).toBeFalsy();
    expect(noteFollowUpTool.requiresGoodbye).toBeFalsy();
    expect(noteFollowUpTool.startsHold).toBeFalsy();
    expect(noteFollowUpTool.verbatimMessage).toBeUndefined();
    expect(noteFollowUpTool.replyOnlyIfSilent).toBe(true);
  });

  it('saves the request straight away, trimmed, without touching the task status', async () => {
    const hangUp = vi.fn(async () => {});
    const result = await noteFollowUpTool.handler({ request: '  Events in San Juan the week of the 9th.  ' }, ctx(hangUp));

    expect(result).toMatchObject({ ok: true });
    expect(saveFollowUp).toHaveBeenCalledWith('task-1', 'Events in San Juan the week of the 9th.');
    expect(transitionTask).not.toHaveBeenCalled();
    expect(hangUp).not.toHaveBeenCalled();
  });

  it('tells the model to say it will pass it on, and to promise nothing more', async () => {
    const result = await noteFollowUpTool.handler({ request: 'The restaurant name.' }, ctx());
    expect(result).toMatchObject({ ok: true, next: expect.stringMatching(/pass it on/) });
    expect((result as { next: string }).next).toMatch(/never say when or how/i);
  });

  it('refuses a blank request, saving nothing', async () => {
    const result = await noteFollowUpTool.handler({ request: '   ' }, ctx());
    expect(result).toMatchObject({ ok: false, error: 'empty_request' });
    expect(saveFollowUp).not.toHaveBeenCalled();
  });

  it('says so when the call already has the most requests it can carry', async () => {
    saveFollowUp.mockResolvedValueOnce(false);
    const result = await noteFollowUpTool.handler({ request: 'One more thing.' }, ctx());
    expect(result).toMatchObject({ ok: false, error: 'not_saved' });
  });

  it('caps the request length in its schema', () => {
    expect(noteFollowUpTool.schema.safeParse({ request: 'x'.repeat(301) }).success).toBe(false);
    expect(noteFollowUpTool.schema.safeParse({ request: 'x'.repeat(300) }).success).toBe(true);
  });
});
