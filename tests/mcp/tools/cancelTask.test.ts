import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cancelPendingTask, getTask } = vi.hoisted(() => ({ cancelPendingTask: vi.fn(), getTask: vi.fn() }));
vi.mock('../../../src/tasks/service.js', () => ({ cancelPendingTask, getTask }));

const { cancelTaskHandler, cancelTaskInputSchema } = await import('../../../src/mcp/tools/cancelTask.js');

const TASK_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mcp: cancel_task', () => {
  it('requires a uuid taskId', () => {
    expect(cancelTaskInputSchema.safeParse({ taskId: 'not-a-uuid' }).success).toBe(false);
    expect(cancelTaskInputSchema.safeParse({ taskId: TASK_ID }).success).toBe(true);
  });

  it('reports a pending task as cancelled', async () => {
    cancelPendingTask.mockResolvedValue({ id: TASK_ID, status: 'cancelled' });
    await expect(cancelTaskHandler({ taskId: TASK_ID }, { role: 'owner' })).resolves.toMatchObject({ cancelled: true, status: 'cancelled' });
    expect(cancelPendingTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('reports a task already on a call or finished as not cancelled, with its status', async () => {
    cancelPendingTask.mockResolvedValue({ id: TASK_ID, status: 'calling' });
    const result = await cancelTaskHandler({ taskId: TASK_ID }, { role: 'owner' });
    expect(result).toMatchObject({ cancelled: false, status: 'calling' });
    expect(result.message).toContain('calling');
  });

  it('throws for a task that does not exist', async () => {
    cancelPendingTask.mockResolvedValue(undefined);
    await expect(cancelTaskHandler({ taskId: TASK_ID }, { role: 'owner' })).rejects.toThrow(/Task not found/);
  });

  describe('with the agent key', () => {
    const agent = { role: 'agent' as const };

    it('cancels a call the agent asked for', async () => {
      getTask.mockResolvedValue({ id: TASK_ID, status: 'pending', approvalExpiresAt: new Date(), requestedByAgent: true });
      cancelPendingTask.mockResolvedValue({ id: TASK_ID, status: 'cancelled' });
      await expect(cancelTaskHandler({ taskId: TASK_ID }, agent)).resolves.toMatchObject({ cancelled: true });
    });

    it("refuses the owner's own calls, without touching them", async () => {
      getTask.mockResolvedValue({ id: TASK_ID, status: 'pending', approvalExpiresAt: null, requestedByAgent: false });
      await expect(cancelTaskHandler({ taskId: TASK_ID }, agent)).rejects.toThrow(/only.*calls it asked for/);
      expect(cancelPendingTask).not.toHaveBeenCalled();
    });

    it("refuses an owner's call that screening held for approval: waiting isn't the agent's (#150)", async () => {
      getTask.mockResolvedValue({ id: TASK_ID, status: 'pending', approvalExpiresAt: new Date(), requestedByAgent: false, screenFlag: 'x' });
      await expect(cancelTaskHandler({ taskId: TASK_ID }, agent)).rejects.toThrow(/only.*calls it asked for/);
      expect(cancelPendingTask).not.toHaveBeenCalled();
    });

    it('throws for a task that does not exist', async () => {
      getTask.mockResolvedValue(undefined);
      await expect(cancelTaskHandler({ taskId: TASK_ID }, agent)).rejects.toThrow(/Task not found/);
      expect(cancelPendingTask).not.toHaveBeenCalled();
    });
  });
});
