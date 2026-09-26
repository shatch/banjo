import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import {
  callAttempts,
  tasks,
  type CallAttempt,
  type Task,
  type TaskConstraints,
  type TaskOutcome,
  type TimeWindow,
  type TransferResult,
} from './schema.js';

/**
 * The only module that writes Task.status/outcome — keeps orchestration code
 * from racing on updatedAt, and gives us one place to log every transition.
 */

/** Non-terminal statuses the orchestration poller should pick up (see src/tasks/orchestrator.ts). Every other status is terminal. */
export const NON_TERMINAL_STATUSES: Task['status'][] = ['pending', 'checking_availability', 'calling', 'negotiating'];

/** The one definition of "terminal": anything not in NON_TERMINAL_STATUSES, so a status added to the enum later is terminal by default. */
export function isTerminalStatus(status: Task['status']): boolean {
  return !NON_TERMINAL_STATUSES.includes(status);
}

export async function createTask(input: {
  contactId: string;
  channel: 'phone' | 'online';
  goalDescription: string;
  constraints: TaskConstraints;
  mode?: 'booking' | 'conversation';
  /** Phone path: place the call no earlier than this instant. Omit to call as soon as possible. */
  scheduledFor?: Date;
}): Promise<Task> {
  const [row] = await db
    .insert(tasks)
    .values({
      contactId: input.contactId,
      channel: input.channel,
      goalDescription: input.goalDescription,
      constraints: input.constraints,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    })
    .returning();
  if (!row) throw new Error('Failed to insert task');
  return row;
}

export async function getTask(id: string): Promise<Task | undefined> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row;
}

/**
 * The statuses a task may move INTO any status from: only the non-terminal
 * ones. A terminal status is final, including after the owner has been
 * notified of it. There used to be one exception, 'confirmed' over 'failed',
 * for a booking that finished writing after a hang-up had already failed the
 * task; CallSession's end()/fail() now wait for running tools within each
 * tool's own budget, so that race can't happen by ordinary means, and the
 * leftover case texts the owner instead of rewriting the record (#3,
 * confirm_appointment in voice/tools/callTools.ts).
 */
function allowedFromStatuses(): Task['status'][] {
  return NON_TERMINAL_STATUSES;
}

type TransitionPatch = Partial<{
  candidateWindows: TimeWindow[];
  // Nullable so a transition can CLEAR them, not only set them — undoing a
  // confirmed booking mid-call has to leave no trace of the event it removed,
  // and both columns are nullable in the schema.
  outcome: TaskOutcome | null;
  calendarEventId: string | null;
}>;

/**
 * Returns the row as it stands afterwards. When the transition isn't allowed
 * (see allowedFromStatuses) the task is left unchanged and returned as-is —
 * compare the returned status to the requested one to tell.
 *
 * With `options.from`, the transition applies only if the task is currently
 * in one of those statuses, and resolves undefined when it didn't apply — a
 * compare-and-set. The orchestrator claims a pending task this way, so two
 * processes polling the same database can't both place its call (the loser
 * would otherwise see the winner's 'checking_availability' as its own).
 */
export async function transitionTask(id: string, status: Task['status'], patch?: TransitionPatch): Promise<Task>;
export async function transitionTask(
  id: string,
  status: Task['status'],
  patch: TransitionPatch | undefined,
  options: { from: Task['status'][] },
): Promise<Task | undefined>;
export async function transitionTask(
  id: string,
  status: Task['status'],
  patch?: TransitionPatch,
  options?: { from: Task['status'][] },
): Promise<Task | undefined> {
  // Checked in the UPDATE itself rather than read-then-write, so two outcome
  // tools racing on one call can't both land.
  const [row] = await db
    .update(tasks)
    .set({ status, ...patch, updatedAt: new Date() })
    .where(and(eq(tasks.id, id), inArray(tasks.status, options?.from ?? allowedFromStatuses())))
    .returning();
  if (row) return row;
  if (options) return undefined;
  const current = await getTask(id);
  if (!current) throw new Error(`Task not found: ${id}`);
  logger.warn(
    { taskId: id, currentStatus: current.status, attemptedStatus: status },
    'ignored transition: task already has a terminal status',
  );
  return current;
}

/**
 * Cancels a phone task whose call hasn't been placed yet — typically one
 * scheduled for later with place_call's scheduledFor. A task already on a
 * call (or finished) is left as-is. Returns the task as it stands afterwards
 * (status 'cancelled' on success), or undefined if it doesn't exist. The
 * orchestrator re-checks the status its own transitions return, so a cancel
 * racing a just-starting run still stops it before dialing.
 */
export async function cancelPendingTask(id: string): Promise<Task | undefined> {
  const row = await transitionTask(id, 'cancelled', undefined, { from: ['pending', 'checking_availability'] });
  return row ?? getTask(id);
}

/** Used by the schedule-appointment skill to log a synchronous online-booking outcome. */
export async function recordTaskOutcome(input: {
  contactId: string;
  goalDescription: string;
  outcome: TaskOutcome;
  calendarEventId?: string;
}): Promise<Task> {
  const status: Task['status'] = input.outcome.kind;
  const [row] = await db
    .insert(tasks)
    .values({
      contactId: input.contactId,
      channel: 'online',
      goalDescription: input.goalDescription,
      constraints: {},
      status,
      outcome: input.outcome,
      calendarEventId: input.calendarEventId,
    })
    .returning();
  if (!row) throw new Error('Failed to insert task outcome');
  return row;
}

export async function listRecentTasks(limit = 20): Promise<Task[]> {
  return db.select().from(tasks).orderBy(desc(tasks.updatedAt)).limit(limit);
}

export async function listNonTerminalTasks(): Promise<Task[]> {
  return db.select().from(tasks).where(inArray(tasks.status, NON_TERMINAL_STATUSES));
}

/**
 * Tasks the orchestration poller should start now: not yet on a call
 * ('pending', or 'checking_availability' left behind by a restart) and due
 * (isTaskDue, as SQL). Filtered in the query so a 15s tick doesn't load every
 * call in progress and every call scheduled for next week.
 */
export async function listStartableTasks(now: Date = new Date()): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ['pending', 'checking_availability']),
        or(isNull(tasks.scheduledFor), lte(tasks.scheduledFor, now)),
      ),
    );
}

/**
 * Whether a task's scheduled time (place_call's scheduledFor), if any, has
 * arrived. Checked by both the in-process trigger and the orchestration
 * poller, so a scheduled call starts on the first poller tick at or after its
 * time — within POLL_INTERVAL_MS (src/tasks/orchestrator.ts) of it.
 */
export function isTaskDue(task: Pick<Task, 'scheduledFor'>, now: Date = new Date()): boolean {
  return !task.scheduledFor || task.scheduledFor.getTime() <= now.getTime();
}

/**
 * Start times of the outbound calls placed to a contact since `since`,
 * oldest first — for the per-number call cap (./callCap.ts), which needs to
 * know when enough of them leave the window. Phone numbers are stored in
 * E.164 and unique (contacts/service.ts's addContact), so per contact is
 * per number.
 */
export async function callsPlacedToContactSince(contactId: string, since: Date): Promise<Date[]> {
  const rows = await db
    .select({ startedAt: callAttempts.startedAt })
    .from(callAttempts)
    .innerJoin(tasks, eq(callAttempts.taskId, tasks.id))
    .where(and(eq(tasks.contactId, contactId), gte(callAttempts.startedAt, since)))
    .orderBy(callAttempts.startedAt);
  return rows.map((row) => row.startedAt);
}

/**
 * Runs `work` holding a Postgres advisory lock for this contact, so dials to
 * one number are serialized across every process on this database — e.g.
 * `npm run test:call` alongside `npm run dev` — not just within one. The lock
 * lives for the transaction; `work` itself may use other connections, and its
 * writes commit on their own before the lock is released.
 */
export async function withContactAdvisoryLock<T>(contactId: string, work: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`call-cap:${contactId}`}))`);
    return work();
  });
}

/** Phone tasks for a contact that are due and about to dial but haven't yet — counted by place_call's cap check. */
export async function dueQueuedCallsForContact(contactId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.contactId, contactId),
        eq(tasks.channel, 'phone'),
        inArray(tasks.status, ['pending', 'checking_availability']),
        or(isNull(tasks.scheduledFor), lte(tasks.scheduledFor, now)),
      ),
    );
  return row?.count ?? 0;
}

// --- Call attempts (phone path only) ---

export async function createCallAttempt(taskId: string): Promise<CallAttempt> {
  const [row] = await db.insert(callAttempts).values({ taskId }).returning();
  if (!row) throw new Error('Failed to insert call attempt');
  return row;
}

/** The most recent call attempt for a task, or undefined if it never reached the phone. */
export async function latestCallAttemptFor(taskId: string): Promise<CallAttempt | undefined> {
  const [row] = await db
    .select()
    .from(callAttempts)
    .where(eq(callAttempts.taskId, taskId))
    .orderBy(desc(callAttempts.startedAt))
    .limit(1);
  return row;
}

export async function updateCallAttempt(
  id: string,
  patch: Partial<Pick<CallAttempt, 'status' | 'providerCallId' | 'answeredBy' | 'endedAt' | 'errorDetail' | 'disclosed' | 'recordingSid'>>,
): Promise<CallAttempt> {
  const [row] = await db.update(callAttempts).set(patch).where(eq(callAttempts.id, id)).returning();
  if (!row) throw new Error(`Call attempt not found: ${id}`);
  return row;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records how a transfer_to_owner dial ended (#7). `callId` is whatever the
 * transfer callback was given: a call attempt id for an outbound call, or a
 * Twilio CallSid for an inbound one, which has no call attempt. Returns
 * whether a call attempt was updated.
 */
export async function recordTransferResult(callId: string, result: TransferResult): Promise<boolean> {
  if (!UUID_PATTERN.test(callId)) return false;
  const rows = await db.update(callAttempts).set({ transferResult: result }).where(eq(callAttempts.id, callId)).returning({ id: callAttempts.id });
  return rows.length > 0;
}
