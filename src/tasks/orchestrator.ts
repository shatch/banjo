import { createCalendarProvider } from '../calendar/factory.js';
import type { CalendarProvider } from '../calendar/types.js';
import { config } from '../config/index.js';
import { getContact } from '../contacts/service.js';
import { logger } from '../lib/logger.js';
import { needsScreeningWhenDue, screenWhenDue } from '../screening/due.js';
import { CallSession } from '../session/callSession.js';
import { createTelephonyProvider } from '../telephony/factory.js';
import { callCapLimit, checkCallCap, describeCallCapRefusal, withContactDialLock } from './callCap.js';
import { buildOutboundCallSessionOptions, notifyTaskOutcome } from './callSessionAdapter.js';
import { buildCallFrontendPrompt, buildCallSystemPrompt } from './promptBuilder.js';
import { readOwnerProfile } from './ownerProfile.js';
import { getLiveCall, registerLiveCall, unregisterLiveCall } from './liveCalls.js';
import {
  createCallAttempt,
  expireApprovalRequests,
  getTask,
  isTaskDue,
  latestCallAttemptFor,
  listNonTerminalTasks,
  listStartableTasks,
  transitionTask,
  type TransitionGuard,
} from './service.js';
import type { TimeWindow } from './schema.js';
import { modeRules } from './modes.js';
import { isAwaitingApproval } from './approval.js';

/** Asked for on each use rather than once at import, so the simulator's overrideCalendarProvider() (scripts/sim.ts) takes effect. */
function getCalendar(): CalendarProvider {
  return createCalendarProvider();
}

// Tracks tasks currently being driven, so a duplicate poller tick (or a
// duplicate MCP place_call for the same task) can't kick off two orchestration
// runs for the same task concurrently.
const inFlightTaskIds = new Set<string>();

/**
 * Fire-and-forget entrypoint called by the MCP place_call tool right after
 * creating a Task row. Deliberately not awaited by the caller — a phone call
 * can run for real wall-clock minutes, and the MCP tool must return
 * immediately with an ack.
 */
export function triggerOrchestration(taskId: string): void {
  if (inFlightTaskIds.has(taskId)) return;
  inFlightTaskIds.add(taskId);
  runTask(taskId)
    .catch((err) => logger.error({ err, taskId }, 'Task orchestration failed'))
    .finally(() => inFlightTaskIds.delete(taskId));
}

async function runTask(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) {
    logger.warn({ taskId }, 'triggerOrchestration called for a task that does not exist');
    return;
  }
  if (task.channel !== 'phone') {
    // Online-path tasks are handled entirely by the schedule-appointment
    // skill and logged via record_task_outcome — nothing for the backend to
    // drive here.
    return;
  }
  if (!isTaskDue(task)) {
    // Scheduled for later (place_call's scheduledFor). Left 'pending' — the
    // poller below starts it once it's due.
    return;
  }
  if (isAwaitingApproval(task)) {
    // An agent's request (MCP_AGENT_API_KEY): placed only once the owner
    // approves it (src/approvals/), which runs this again.
    return;
  }

  const contact = await getContact(task.contactId);
  if (!contact) {
    await transitionTask(task.id, 'failed', { outcome: { kind: 'failed', reason: 'Contact not found' } });
    return;
  }

  // Call screening (#150): a scheduled call is screened again when it comes
  // due, before anything claims it. A held one waits for the owner's
  // approval, which the check above then waits on.
  if (config.SCREEN_CALLS && task.status === 'pending' && needsScreeningWhenDue(task, contact) && (await screenWhenDue(task, contact))) {
    logger.info({ taskId }, 'call screening held a scheduled call that came due');
    return;
  }

  // transitionTask leaves a terminal task unchanged and returns it as-is, so
  // each step checks it actually moved: a cancel_task landing between the
  // read above and these writes must stop the run before it dials.
  //
  // Every step up to dialing is a compare-and-set, chained off the row the
  // step before it wrote, so only one process can get a task through to
  // 'calling' (#64). With scheduled calls, every process polling this
  // database finds the same due task on the same tick. A pending task is
  // claimed from 'pending'. A task already in 'checking_availability' (a
  // restart resume) is claimed only if nothing has written it since we read
  // it; claiming it bumps updatedAt, so a process that was still working on
  // it loses its own next step instead of dialing too.
  const checking =
    task.status === 'pending'
      ? await transitionTask(task.id, 'checking_availability', undefined, { from: ['pending'] })
      : await transitionTask(task.id, 'checking_availability', undefined, {
          from: ['checking_availability'],
          ifUpdatedAt: task.updatedAt,
        });
  if (checking?.status !== 'checking_availability') {
    logger.info(
      { taskId, status: checking?.status ?? 'claimed by another process or cancelled' },
      'task can no longer be started — not placing the call',
    );
    return;
  }
  // Only this run's own claim may move the task on from here.
  const stillOurs = { from: ['checking_availability'], ifUpdatedAt: checking.updatedAt } satisfies TransitionGuard;

  // Only a call that can book has windows to check (tasks/modes.ts): an
  // 'ask' call (#148) once failed here over times it never used.
  const books = modeRules(task).books;
  // Every requested window can be over by the time a scheduled call runs.
  // Calling anyway used to go ahead with no pre-checked windows at all, so
  // the model could book any free time (#3) — fail and tell the owner instead.
  const requestedWindows = task.constraints.dateWindows ?? [];
  const dateWindows = requestedWindows.length ? clipWindowsToFuture(requestedWindows) : defaultLookaheadWindow();
  if (books && !dateWindows.length) {
    const failed = await transitionTask(
      task.id,
      'failed',
      { outcome: { kind: 'failed', reason: 'Every time requested for this call had already passed by the time it was due, so no call was placed.' } },
      stillOurs,
    );
    if (failed) await notifyTaskOutcome(task.id);
    return;
  }
  // An early, unlocked look at the call cap, so a call that can't be placed
  // fails before spending a calendar lookup. The check that counts is the
  // locked one below.
  const earlyCap = await checkCallCap(task.contactId, new Date(), { limit: callCapLimit(task, contact) });
  if (!earlyCap.allowed) {
    await failOverCallCap(task.id, describeCallCapRefusal(earlyCap), stillOurs);
    return;
  }
  // A call that can't book has no free time to look up.
  const candidateWindows = !books
    ? []
    : await getCalendar().computeCandidateWindows({
        dateWindows,
        durationMinutes: task.constraints.durationMinutes ?? 30,
      });
  // The per-number call cap, checked again right before dialing: place_call
  // checked it when the call was requested, but a scheduled call can come due
  // after other calls to the same number. Held under a per-contact lock until
  // the call attempt is recorded, so two due calls can't both pass the check.
  const dial = await withContactDialLock(task.contactId, async () => {
    const cap = await checkCallCap(task.contactId, new Date(), { limit: callCapLimit(task, contact) });
    if (!cap.allowed) return { kind: 'refused', reason: describeCallCapRefusal(cap) } as const;
    const calling = await transitionTask(task.id, 'calling', { candidateWindows }, stillOurs);
    if (!calling) return { kind: 'stopped' } as const;
    try {
      return { kind: 'dialing', callAttempt: await createCallAttempt(task.id) } as const;
    } catch (err) {
      // Otherwise the task sits in 'calling' with no call attempt forever: the
      // poller doesn't resume 'calling', and the stale-call sweep skips a task
      // with no attempt.
      logger.error({ err, taskId }, 'could not record the call attempt — failing the task instead of dialing');
      return { kind: 'unrecorded' } as const;
    }
  });
  if (dial.kind === 'refused') {
    await failOverCallCap(task.id, dial.reason, stillOurs);
    return;
  }
  if (dial.kind === 'unrecorded') {
    const failed = await transitionTask(
      task.id,
      'failed',
      { outcome: { kind: 'failed', reason: 'The call could not be started: recording the call attempt failed. No call was placed.' } },
      // Status only: this run holds 'calling' exclusively, and a stricter
      // guard that missed would strand the task there with no attempt.
      { from: ['calling'] },
    );
    if (failed) await notifyTaskOutcome(task.id);
    return;
  }
  if (dial.kind === 'stopped') {
    logger.info(
      { taskId },
      'task was cancelled or taken over by another process before dialing — not placing the call',
    );
    return;
  }

  const { callAttempt } = dial;
  const telephony = createTelephonyProvider();
  const ownerProfile = readOwnerProfile();
  const systemPrompt = buildCallSystemPrompt(task, contact, candidateWindows, ownerProfile);
  const frontendSystemPrompt = buildCallFrontendPrompt(task, contact, ownerProfile);

  const session = new CallSession(
    buildOutboundCallSessionOptions({
      task,
      callAttempt,
      contact,
      telephony,
      calendar: getCalendar(),
      systemPrompt,
      frontendSystemPrompt,
    }),
  );
  // Registered for as long as the call runs: stop_call needs a handle on it,
  // and the stale-call sweep uses membership here to tell a live call apart
  // from one whose process died mid-conversation.
  //
  // Deliberately NOT unregistered when start() returns. start() resolves once
  // the call is SET UP — originated, voice AI connected — and the conversation
  // then runs on event handlers for however long it lasts. Clearing the entry
  // here (the first cut did, in a `finally`) meant it vanished the moment the
  // phone began ringing, so stop_call could never find a live call: caught on a
  // real call that had been answered and was still reported as unreachable.
  // The adapter clears it on the real end-of-call signals instead.
  registerLiveCall({ taskId: task.id, callAttemptId: callAttempt.id, session });
  try {
    await session.start();
  } catch (err) {
    // start() threw outright, so no end-of-call signal will ever fire for this
    // session and nothing else would ever clear it.
    unregisterLiveCall(task.id);
    throw err;
  }
}

async function failOverCallCap(taskId: string, reason: string, guard: TransitionGuard): Promise<void> {
  logger.warn({ taskId }, 'per-number call cap reached — not placing the call');
  const failed = await transitionTask(taskId, 'failed', { outcome: { kind: 'failed', reason } }, guard);
  if (failed) await notifyTaskOutcome(taskId);
}

/**
 * Drops whatever part of each window is already over by the time the call
 * runs. A scheduled call's windows are usually written relative to when it
 * was scheduled, and computeCandidateWindows doesn't filter out past
 * intervals — so without this the model could offer a time that has passed.
 */
export function clipWindowsToFuture(windows: TimeWindow[], now: Date = new Date()): TimeWindow[] {
  const nowMs = now.getTime();
  return windows
    .filter((window) => Date.parse(window.end) > nowMs)
    .map((window) => (Date.parse(window.start) < nowMs ? { start: now.toISOString(), end: window.end } : window));
}

function defaultLookaheadWindow(): TimeWindow[] {
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return [{ start: now.toISOString(), end: end.toISOString() }];
}

const POLL_INTERVAL_MS = 15_000;

/**
 * How long a call attempt may sit unfinished before the sweep treats it as
 * abandoned. Generous on purpose: the registry check below is the real
 * safeguard for calls this process is driving, and this floor only has to
 * outlast any plausible real conversation. Sweeping a live call would hang up
 * on someone mid-sentence, which is far worse than reporting a dead one late.
 */
const STALE_CALL_AFTER_MS = 15 * 60 * 1000;

const MS_PER_MINUTE = 60_000;

/**
 * Closes out calls whose process died mid-conversation.
 *
 * `calling`/`negotiating` tasks are deliberately never redialed — redialing a
 * business because our process crashed is worse than not. But nothing moved
 * them either, and notifyIfTerminal only fires on a terminal status, so the
 * user asked for a booking and then simply never heard anything. The silence
 * was the bug, not the missing retry.
 *
 * Reconciles against the calendar before deciding: confirm_appointment writes
 * the event BEFORE marking the task confirmed, so a crash in that window
 * leaves a real booking attached to a task that never reached 'confirmed'.
 * Reporting that as "failed, nothing happened" would be a lie the user acts on.
 */
export async function sweepStaleCalls(): Promise<void> {
  const tasks = await listNonTerminalTasks();
  for (const task of tasks) {
    if (task.status !== 'calling' && task.status !== 'negotiating') continue;
    // Running right here — however long it has been going.
    if (getLiveCall(task.id)) continue;

    const attempt = await latestCallAttemptFor(task.id);
    if (!attempt || attempt.endedAt) continue;
    if (Date.now() - attempt.startedAt.getTime() < STALE_CALL_AFTER_MS) continue;

    // A Calendar outage must not stall the sweep — an honest "we don't know"
    // still beats leaving the task in limbo, which is the bug being fixed.
    // Only a call that can book can have left a booking behind (#148 review r2).
    const books = modeRules(task).books;
    let booked: Awaited<ReturnType<CalendarProvider['findEventByIdempotencyKey']>>;
    let calendarChecked = true;
    try {
      if (books) booked = await getCalendar().findEventByIdempotencyKey(`confirm:${attempt.id}`);
    } catch (err) {
      calendarChecked = false;
      logger.error({ err, taskId: task.id }, 'stale-call sweep could not reach the calendar — reporting outcome as unknown');
    }

    // An ask call that saved answers before it died reports them, as one
    // that ended early on a live process does (#148 review). How many times
    // they replied died with the process, so a conversation still fails here (#179).
    const unfinished = modeRules(task).unfinishedCallOutcome(task, { theirReplies: 0 });

    if (booked) {
      logger.warn(
        { taskId: task.id, callAttemptId: attempt.id, eventId: booked.eventId },
        'stale call had already written its calendar event — recording it as confirmed',
      );
      await transitionTask(
        task.id,
        'confirmed',
        {
          calendarEventId: booked.eventId,
          outcome: {
            kind: 'confirmed',
            start: new Date(booked.confirmedStart).toISOString(),
            durationMinutes: Math.round((Date.parse(booked.confirmedEnd) - Date.parse(booked.confirmedStart)) / MS_PER_MINUTE),
            details: 'Recovered after the call was interrupted — the calendar event was already written.',
          },
        },
        { from: ['calling', 'negotiating'] },
      );
    } else if (unfinished) {
      const { status, outcome } = unfinished;
      logger.warn({ taskId: task.id, callAttemptId: attempt.id }, 'stale call swept — recording the answers it saved');
      await transitionTask(task.id, status, { outcome }, { from: ['calling', 'negotiating'] });
    } else {
      logger.warn({ taskId: task.id, callAttemptId: attempt.id }, 'stale call swept — no calendar event found');
      await transitionTask(
        task.id,
        'failed',
        {
          outcome: {
            kind: 'failed',
            // Only claim the calendar was empty when it was actually read — a
            // failed lookup says nothing about whether a booking exists.
            reason: !books
              ? 'The call was interrupted before it finished, and no answers were saved. Its outcome is unknown.'
              : calendarChecked
              ? 'The call was interrupted before it finished, and no booking was found on the calendar. Its outcome is unknown.'
              : 'The call was interrupted before it finished, and the calendar could not be checked for a booking — check it by hand. Its outcome is unknown.',
          },
        },
        { from: ['calling', 'negotiating'] },
      );
    }

    await notifyTaskOutcome(task.id);
  }
}

/**
 * Restart-safety net: an in-process trigger is the primary hand-off
 * mechanism (see triggerOrchestration above), but a container restart could
 * leave a task stuck in a pre-calling status with no in-memory trigger left
 * to resume it. This poller re-picks-up anything not yet on a live call —
 * tasks already 'calling'/'negotiating' at restart time are NOT auto-resumed
 * (their call is already gone; v1 just leaves them for Steve to notice via
 * list_recent_tasks rather than guessing at a retry).
 *
 * It's also what starts a scheduled call (place_call's scheduledFor): a task
 * isn't picked up until isTaskDue, so it starts within POLL_INTERVAL_MS of
 * its scheduled time. And it cancels the calls agents asked for that the owner
 * didn't approve in time.
 */
export function startOrchestrationPoller(): void {
  setInterval(() => {
    listStartableTasks()
      .then((startable) => {
        for (const t of startable) triggerOrchestration(t.id);
      })
      .catch((err) => logger.error({ err }, 'Orchestration poller failed'));

    sweepStaleCalls().catch((err) => logger.error({ err }, 'Stale-call sweep failed'));

    expireApprovalRequests()
      .then((ids) => {
        if (ids.length) logger.info({ taskIds: ids }, 'cancelled call requests the owner did not approve in time');
      })
      .catch((err) => logger.error({ err }, 'Approval expiry sweep failed'));
  }, POLL_INTERVAL_MS);
}
