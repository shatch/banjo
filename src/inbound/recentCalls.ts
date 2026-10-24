import { and, desc, eq, gte, max } from 'drizzle-orm';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { callAttempts, tasks, type Task, type TaskOutcome } from '../tasks/schema.js';

/** How far back a returning caller's calls from Banjo are looked up (#129). */
export const RETURN_CALL_WINDOW_HOURS = 48;
const MAX_RECENT_CALLS = 3;

export interface RecentOutboundCall {
  taskId: string;
  /** When Banjo last dialed them for this task. */
  calledAt: Date;
  mode: Task['mode'];
  /** The owner's instructions for the call. */
  goal: string;
  status: Task['status'];
  outcome: TaskOutcome | null;
}

/**
 * Banjo's outbound calls to this contact dialed in the last 48 hours, newest
 * first (#129): so a caller returning one of them gets that call, not the
 * booking script. Counted from the dial, so a missed call counts too. Only
 * ever this contact's own calls, and only once caller ID has resolved them to
 * a contact. Fails closed to none: it runs while answering a call.
 */
export async function recentOutboundCalls(contactId: string, now = new Date()): Promise<RecentOutboundCall[]> {
  try {
    const since = new Date(now.getTime() - RETURN_CALL_WINDOW_HOURS * 3_600_000);
    const calledAt = max(callAttempts.startedAt);
    const rows = await db
      .select({ taskId: tasks.id, calledAt, mode: tasks.mode, goal: tasks.goalDescription, status: tasks.status, outcome: tasks.outcome })
      .from(tasks)
      .innerJoin(callAttempts, eq(callAttempts.taskId, tasks.id))
      .where(and(eq(tasks.contactId, contactId), gte(callAttempts.startedAt, since)))
      .groupBy(tasks.id)
      .orderBy(desc(calledAt))
      .limit(MAX_RECENT_CALLS);
    return rows.map((r) => ({ ...r, calledAt: new Date(r.calledAt!) }));
  } catch (err) {
    logger.error({ err, contactId }, 'recent outbound calls lookup failed');
    return [];
  }
}
