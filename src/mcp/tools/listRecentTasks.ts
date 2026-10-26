import { z } from 'zod';
import { listRecentTasks } from '../../tasks/service.js';
import { approvalState } from '../../tasks/approval.js';
import type { Task } from '../../tasks/schema.js';

export const listRecentTasksInputSchema = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Maximum number of tasks to return, most recently updated first. Defaults to 20.'),
});

/**
 * A task without its candidateWindows: the free slots the call prompt is built
 * from, internal to the call and a week of half-hour slots by default. Whole
 * rows put hundreds of them per task into the calling agent's context (#120).
 *
 * Also without collectedAnswers, the answers an ask call saved as it went: the
 * raw map is keyed by question number, without the questions. get_task_status
 * returns them paired with their questions (#148 review), so they have one
 * shape and one place to be read from.
 *
 * And without screenFlag (#150): why call screening held a call can be the
 * screening model's words about the agent's own request, which go to the
 * owner only. heldByScreening says that it did.
 */
export type TaskSummary = Omit<Task, 'candidateWindows' | 'collectedAnswers' | 'screenFlag'> & {
  /** Only on a call that needed approval: see get_task_status. */
  approval?: 'waiting' | 'approved' | 'not_approved';
  /** Call screening held this call for the owner's approval (#150). */
  heldByScreening?: true;
};

export async function listRecentTasksHandler(input: z.infer<typeof listRecentTasksInputSchema>): Promise<TaskSummary[]> {
  const tasks = await listRecentTasks(input.limit ?? 20);
  return tasks.map(({ candidateWindows: _candidateWindows, collectedAnswers: _collectedAnswers, screenFlag, ...summary }) => {
    const approval = approvalState(summary);
    return { ...summary, ...(approval ? { approval } : {}), ...(screenFlag ? { heldByScreening: true as const } : {}) };
  });
}
