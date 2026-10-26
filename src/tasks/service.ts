import { and, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import {
  callAttempts,
  tasks,
  type CallAttempt,
  type CollectedAnswer,
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
  mode?: Task['mode'];
  /** 'ask' tasks only (#148): the questions to put to the other party, in order. */
  questions?: string[];
  /** Phone path: place the call no earlier than this instant. Omit to call as soon as possible. */
  scheduledFor?: Date;
  /** A call an agent asked for: not placed until the owner approves it, and cancelled if they haven't by then. */
  approvalExpiresAt?: Date;
  /** Asked for with the agent key: what lets that key cancel or stop it (./approval.ts's askedByAgent). */
  requestedByAgent?: boolean;
  /** Why call screening held it for the owner's approval (#150). */
  screenFlag?: string;
  /** The owner let this call past the per-number cap, up to twice it (./callCap.ts). */
  callCapOverride?: boolean;
}): Promise<Task> {
  const [row] = await db
    .insert(tasks)
    .values({
      contactId: input.contactId,
      channel: input.channel,
      goalDescription: input.goalDescription,
      constraints: input.constraints,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.questions ? { questions: input.questions } : {}),
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
      ...(input.approvalExpiresAt ? { approvalExpiresAt: input.approvalExpiresAt } : {}),
      ...(input.requestedByAgent ? { requestedByAgent: true } : {}),
      ...(input.screenFlag ? { screenFlag: input.screenFlag } : {}),
      ...(input.callCapOverride ? { callCapOverride: true } : {}),
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

/**
 * transitionTask's compare-and-set: current status in `from`, and (optionally) the row unchanged since `ifUpdatedAt`.
 * `unapproved` also requires that the owner hasn't approved the task, so expiring an agent's request can't land
 * after an approval.
 */
export type TransitionGuard = { from: Task['status'][]; ifUpdatedAt?: Date; unapproved?: true };

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
 *
 * `options.ifUpdatedAt` narrows it further: the row must also be unchanged
 * since that write — pass the `updatedAt` of the row a previous step
 * returned. A status alone can't tell two processes apart when both resume
 * the same 'checking_availability' task (#64); the last write can.
 */
export async function transitionTask(id: string, status: Task['status'], patch?: TransitionPatch): Promise<Task>;
export async function transitionTask(
  id: string,
  status: Task['status'],
  patch: TransitionPatch | undefined,
  options: TransitionGuard,
): Promise<Task | undefined>;
export async function transitionTask(
  id: string,
  status: Task['status'],
  patch?: TransitionPatch,
  options?: TransitionGuard,
): Promise<Task | undefined> {
  // Checked in the UPDATE itself rather than read-then-write, so two outcome
  // tools racing on one call can't both land.
  const [row] = await db
    .update(tasks)
    // Always strictly later than the row's last write, even within the same
    // millisecond: ifUpdatedAt (#64) relies on every transition changing
    // updatedAt, or a second resume from the same read could still match.
    .set({ status, ...patch, updatedAt: sql`greatest(${new Date().toISOString()}::timestamptz, ${tasks.updatedAt} + interval '1 millisecond')` })
    .where(
      and(
        eq(tasks.id, id),
        inArray(tasks.status, options?.from ?? allowedFromStatuses()),
        // Truncated to milliseconds: a JS Date carries no more, and a row
        // created with defaultNow() is stored to the microsecond.
        options?.ifUpdatedAt
          ? sql`date_trunc('milliseconds', ${tasks.updatedAt}) = ${options.ifUpdatedAt.toISOString()}::timestamptz`
          : undefined,
        options?.unapproved ? isNull(tasks.approvedAt) : undefined,
      ),
    )
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
 * Saves one of an ask call's answers mid-call (record_answer, #148 review),
 * replacing any earlier one for the same question number. Resolves false if
 * the task doesn't exist or its answers are already in its outcome ('answered').
 *
 * Not a transition, so not through transitionTask: its compare-and-set
 * would drop an answer saved as the call ends, and the answers have to
 * outlast whatever ends it (they are how a call that ended early still
 * reports what it found out). For the same reason it doesn't touch
 * updatedAt, which ifUpdatedAt reads as "no transition since". Merged in the
 * UPDATE itself, so two answers saved at once both land.
 */
export async function saveCollectedAnswer(taskId: string, answer: CollectedAnswer): Promise<boolean> {
  const entry = { [String(answer.question)]: answer };
  const rows = await db
    .update(tasks)
    .set({ collectedAnswers: sql`coalesce(${tasks.collectedAnswers}, '{}'::jsonb) || ${JSON.stringify(entry)}::jsonb` })
    // Not once the answers are in the outcome (#148 review r2): a late save
    // would make get_task_status's collectedAnswers disagree with it. Other
    // terminal statuses still take one, since there the saved answers are
    // the only record.
    .where(and(eq(tasks.id, taskId), ne(tasks.status, 'answered')))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/** Phone tasks to a contact updated since `since`, newest first: what call screening sees of past calls (#150). */
export async function recentTasksForContact(contactId: string, since: Date): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.contactId, contactId), eq(tasks.channel, 'phone'), gte(tasks.updatedAt, since)))
    .orderBy(desc(tasks.updatedAt));
}

/**
 * Holds a pending task for the owner's approval (#150): call screening
 * flagged it when it came due. Clears an earlier approval, since what the
 * owner approved was the call before this flag. Resolves the task, or
 * undefined if it's no longer pending.
 */
export async function holdForScreening(taskId: string, reason: string, approvalExpiresAt: Date): Promise<Task | undefined> {
  const [row] = await db
    .update(tasks)
    .set({ approvalExpiresAt, approvedAt: null, screenFlag: reason })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')))
    .returning();
  return row;
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
        // An agent's request waits for the owner (isAwaitingApproval).
        or(isNull(tasks.approvalExpiresAt), isNotNull(tasks.approvedAt)),
      ),
    );
}

/**
 * The owner's Approve (src/approvals/routes.ts). Not a status change, so not
 * transitionTask: a compare-and-set on approved_at. The expiry sweep's own
 * compare-and-set (from pending, unapproved) conditions on the same row, so
 * only one of them can win.
 */
export async function approveTask(
  id: string,
  now: Date = new Date(),
): Promise<'approved' | 'already_approved' | 'expired' | 'not_waiting' | 'not_found'> {
  const [row] = await db
    .update(tasks)
    .set({ approvedAt: now, updatedAt: sql`greatest(${now.toISOString()}::timestamptz, ${tasks.updatedAt} + interval '1 millisecond')` })
    .where(and(eq(tasks.id, id), eq(tasks.status, 'pending'), isNull(tasks.approvedAt), gt(tasks.approvalExpiresAt, now)))
    .returning({ id: tasks.id });
  if (row) return 'approved';
  const task = await getTask(id);
  if (!task) return 'not_found';
  if (task.approvedAt) return 'already_approved';
  if (task.status === 'pending' && task.approvalExpiresAt && task.approvalExpiresAt <= now) return 'expired';
  return 'not_waiting';
}

/** Cancels agent requests nobody approved in time; returns the ids it cancelled. Run by the orchestration poller. */
export async function expireApprovalRequests(now: Date = new Date()): Promise<string[]> {
  const due = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.status, 'pending'), isNull(tasks.approvedAt), lte(tasks.approvalExpiresAt, now)));
  const cancelled: string[] = [];
  for (const { id } of due) {
    if (await transitionTask(id, 'cancelled', undefined, { from: ['pending'], unapproved: true })) cancelled.push(id);
  }
  return cancelled;
}

/**
 * Agent requests the owner hasn't approved whose window is still open, in any
 * status: place_call allows only a few at once. A request the agent cancelled
 * keeps its slot until its window would have ended, so cancelling and asking
 * again can't send the owner an endless run of messages.
 */
export async function countOpenApprovalRequests(now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(tasks)
    .where(and(isNull(tasks.approvedAt), gt(tasks.approvalExpiresAt, now)));
  return row?.count ?? 0;
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

let approvalRequestChain: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` with no other agent call request between its waiting-limit
 * check and its insert, so simultaneous requests can't all pass the check
 * (place_call's MAX_WAITING_APPROVALS). Chained in-process first, so only one
 * connection here waits on the advisory lock, which covers other processes.
 */
export async function withApprovalRequestLock<T>(work: () => Promise<T>): Promise<T> {
  const run = approvalRequestChain
    .catch(() => {})
    .then(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('approval-requests'))`);
        return work();
      }),
    );
  approvalRequestChain = run.catch(() => {});
  return run;
}

/**
 * Phone tasks for a contact that are due and about to dial but haven't yet — counted by place_call's cap check.
 * `includeAwaitingApproval: false` leaves out agent requests the owner hasn't approved, so an agent's requests
 * can't use up the owner's own calls to a number. The check before dialing still counts every call placed.
 */
export async function dueQueuedCallsForContact(
  contactId: string,
  now: Date = new Date(),
  { includeAwaitingApproval = true }: { includeAwaitingApproval?: boolean } = {},
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.contactId, contactId),
        eq(tasks.channel, 'phone'),
        inArray(tasks.status, ['pending', 'checking_availability']),
        or(isNull(tasks.scheduledFor), lte(tasks.scheduledFor, now)),
        includeAwaitingApproval ? undefined : or(isNull(tasks.approvalExpiresAt), isNotNull(tasks.approvedAt)),
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
