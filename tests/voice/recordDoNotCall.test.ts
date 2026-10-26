import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallContext } from '../../src/session/types.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';

// record_do_not_call (#150): the do-not-call memory call screening reads.
const { markDoNotCall } = vi.hoisted(() => ({ markDoNotCall: vi.fn(async () => true) }));
vi.mock('../../src/contacts/service.js', () => ({ markDoNotCall }));
vi.mock('../../src/tasks/service.js', () => ({
  transitionTask: vi.fn(),
  isTerminalStatus: () => false,
}));

const { commonCallTools, recordDoNotCallTool } = await import('../../src/voice/tools/callTools.js');

beforeEach(() => vi.clearAllMocks());

function ctx(hangUp: TelephonyProvider['hangUp'] = vi.fn()): CallContext {
  return {
    task: { id: 'task-1', contactId: 'contact-1', status: 'negotiating', mode: 'conversation' } as Task,
    callAttempt: { id: 'call-attempt-1' } as CallAttempt,
    callId: 'call-attempt-1',
    telephony: { hangUp } as unknown as TelephonyProvider,
    calendar: {} as CallContext['calendar'],
    estimatedAudioDoneAt: Date.now(),
  };
}

describe('record_do_not_call (#150)', () => {
  it("isn't on every call: the session adds it only with SCREEN_CALLS on", () => {
    expect(commonCallTools.some((t) => t.name === 'record_do_not_call')).toBe(false);
    expect(recordDoNotCallTool.endsCall).toBeFalsy();
    expect(recordDoNotCallTool.verbatimMessage).toBeUndefined();
    expect(recordDoNotCallTool.replyOnlyIfSilent).toBe(true);
  });

  it("records it on the call's contact, without ending the call, and says how to close", async () => {
    const hangUp = vi.fn(async () => {});
    const result = await recordDoNotCallTool.handler({}, ctx(hangUp));
    expect(markDoNotCall).toHaveBeenCalledWith('contact-1');
    expect(hangUp).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, next: expect.stringMatching(/say goodbye/) });
  });

  it('says so when it could not be saved', async () => {
    markDoNotCall.mockResolvedValueOnce(false);
    await expect(recordDoNotCallTool.handler({}, ctx())).resolves.toMatchObject({ ok: false, error: 'not_saved' });
  });
});
