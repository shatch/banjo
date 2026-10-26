import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLiveCall, unregisterLiveCall, listLiveCalls } from '../../../src/tasks/liveCalls.js';

const getTask = vi.fn();
vi.mock('../../../src/tasks/service.js', () => ({ getTask }));

const { stopCallHandler } = await import('../../../src/mcp/tools/stopCall.js');

beforeEach(() => {
  vi.clearAllMocks();
  for (const c of listLiveCalls()) unregisterLiveCall(c.taskId);
});

describe('stop_call', () => {
  it('stops a call this process is driving, through the session teardown', async () => {
    const stop = vi.fn(async () => {});
    registerLiveCall({ taskId: 'task-1', callAttemptId: 'attempt-1', session: { stop } });

    const result = await stopCallHandler({ taskId: 'task-1', reason: 'wrong number' }, { role: 'owner' });

    expect(stop).toHaveBeenCalledWith('wrong number');
    expect(result).toMatchObject({ taskId: 'task-1', stopped: true });
  });

  it('supplies a default reason when none is given', async () => {
    const stop = vi.fn(async () => {});
    registerLiveCall({ taskId: 'task-1', callAttemptId: 'attempt-1', session: { stop } });

    await stopCallHandler({ taskId: 'task-1' }, { role: 'owner' });

    expect(stop).toHaveBeenCalledWith(expect.stringContaining('stopped'));
  });

  it('says plainly that there is no live call, rather than pretending it stopped one', async () => {
    // Same honesty as cancel_task: a call that already finished, or one being
    // driven by a different process, is not something this can reach.
    getTask.mockResolvedValueOnce({ id: 'task-1', status: 'confirmed' });

    const result = await stopCallHandler({ taskId: 'task-1' }, { role: 'owner' });

    expect(result).toMatchObject({ taskId: 'task-1', stopped: false, status: 'confirmed' });
    expect(result.message).toMatch(/no live call/i);
  });

  it('throws for a task that does not exist at all', async () => {
    getTask.mockResolvedValueOnce(undefined);
    await expect(stopCallHandler({ taskId: 'missing' }, { role: 'owner' })).rejects.toThrow(/not found/i);
  });

  describe('with the agent key', () => {
    const agent = { role: 'agent' as const };

    it('stops a call the agent asked for', async () => {
      const stop = vi.fn(async () => {});
      registerLiveCall({ taskId: 'task-1', callAttemptId: 'attempt-1', session: { stop } });
      getTask.mockResolvedValueOnce({ id: 'task-1', status: 'calling', approvalExpiresAt: new Date(), requestedByAgent: true });
      await expect(stopCallHandler({ taskId: 'task-1' }, agent)).resolves.toMatchObject({ stopped: true });
      expect(stop).toHaveBeenCalled();
    });

    it("refuses to hang up the owner's own call", async () => {
      const stop = vi.fn(async () => {});
      registerLiveCall({ taskId: 'task-1', callAttemptId: 'attempt-1', session: { stop } });
      getTask.mockResolvedValueOnce({ id: 'task-1', status: 'calling', approvalExpiresAt: null, requestedByAgent: false });
      await expect(stopCallHandler({ taskId: 'task-1' }, agent)).rejects.toThrow(/only.*calls it asked for/);
      expect(stop).not.toHaveBeenCalled();
    });
  });
});

