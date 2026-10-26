import type { Task } from './schema.js';

// Pure reads of a task's approval columns (MCP_AGENT_API_KEY calls), kept out
// of ./service.ts so callers don't need the database to use them. The writes
// (approveTask, expireApprovalRequests) are in ./service.ts.

/** A call waiting for the owner's approval (an agent's request, or one screening held): never dialed in this state. */
export function isAwaitingApproval(task: Pick<Task, 'approvalExpiresAt' | 'approvedAt'>): boolean {
  return task.approvalExpiresAt !== null && task.approvedAt === null;
}

/** A call asked for with the agent key: the only calls that key may cancel or hang up (cancel_task, stop_call). */
export function askedByAgent(task: Pick<Task, 'requestedByAgent'>): boolean {
  return task.requestedByAgent;
}

/** The refusal cancel_task and stop_call give the agent key for any other call. */
export const NOT_AGENTS_CALL = "The agent key can only cancel or stop calls it asked for. This one is the owner's.";

/** For get_task_status and list_recent_tasks: undefined on a task that never needed approval. */
export function approvalState(
  task: Pick<Task, 'approvalExpiresAt' | 'approvedAt' | 'status'>,
): 'waiting' | 'approved' | 'not_approved' | undefined {
  if (!task.approvalExpiresAt) return undefined;
  if (task.approvedAt) return 'approved';
  return task.status === 'pending' ? 'waiting' : 'not_approved';
}
