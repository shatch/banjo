import { z } from 'zod';
import { listRecentTasks } from '../../tasks/service.js';
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

export async function listRecentTasksHandler(input: z.infer<typeof listRecentTasksInputSchema>): Promise<Task[]> {
  return listRecentTasks(input.limit ?? 20);
}
