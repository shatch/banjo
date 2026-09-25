import { createCalendarProvider } from '../calendar/factory.js';
import { getContact } from '../contacts/service.js';
import { logger } from '../lib/logger.js';
import { CallSession } from '../session/callSession.js';
import { createTelephonyProvider } from '../telephony/factory.js';
import { buildOutboundCallSessionOptions, notifyTaskOutcome } from './callSessionAdapter.js';
import { buildCallFrontendPrompt, buildCallSystemPrompt } from './promptBuilder.js';
import { readOwnerProfile } from './ownerProfile.js';
import { getLiveCall, registerLiveCall, unregisterLiveCall } from './liveCalls.js';
import {
  createCallAttempt,
  getTask,
  isTaskDue,
  latestCallAttemptFor,
  listNonTerminalTasks,
  listStartableTasks,
  transitionTask,
} from './service.js';
import type { TimeWindow } from './schema.js';

const calendar = createCalendarProvider();

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

  const contact = await getContact(task.contactId);
  if (!contact) {
    await transitionTask(task.id, 'failed', { outcome: { kind: 'failed', reason: 'Contact not found' } });
    return;
  }

  // transitionTask leaves a terminal task unchanged and returns it as-is, so
  // each step checks it actually moved: a cancel_task landing between the
  // read above and these writes must stop the run before it dials.
  //
  // A pending task is claimed with a compare-and-set (only from 'pending'):
  // with scheduled calls, every process polling this database finds the same
  // due task on the same tick, and without an exclusive claim each one would
  // place the call. A task already in 'checking_availability' is a restart
  // resume and keeps the plain transition.
  const checking =
    task.status === 'pending'
      ? await transitionTask(task.id, 'checking_availability', undefined, { from: ['pending'] })
      : await transitionTask(task.id, 'checking_availability');
  if (checking?.status !== 'checking_availability') {
    logger.info(
      { taskId, status: checking?.status ?? 'claimed by another process or cancelled' },
      'task can no longer be started — not placing the call',
    );
    return;
  }
  // Every requested window can be over by the time a scheduled call runs.
  // Calling anyway used to go ahead with no pre-checked windows at all, so
  // the model could book any free time (#3) — fail and tell the owner instead.
  const requestedWindows = task.constraints.dateWindows ?? [];
  const dateWindows = requestedWindows.length ? clipWindowsToFuture(requestedWindows) : defaultLookaheadWindow();
  if (!dateWindows.length) {
    const failed = await transitionTask(task.id, 'failed', {
      outcome: { kind: 'failed', reason: 'Every time requested for this call had already passed by the time it was due, so no call was placed.' },
    });
    if (failed.status === 'failed') await notifyTaskOutcome(task.id);
    return;
  }
  const candidateWindows = await calendar.computeCandidateWindows({
    dateWindows,
    durationMinutes: task.constraints.durationMinutes ?? 30,
  });
  const calling = await transitionTask(task.id, 'calling', { candidateWindows });
  if (calling.status !== 'calling') {
    logger.info({ taskId, status: calling.status }, 'task can no longer be started — not placing the call');
    return;
  }

  const callAttempt = await createCallAttempt(task.id);
  const telephony = createTelephonyProvider();
  const ownerProfile = readOwnerProfile();
  const systemPrompt = buildCallSystemPrompt(task, contact, candidateWindows, ownerProfile);
  const frontendSystemPrompt = buildCallFrontendPrompt(task, contact, ownerProfile);

  const session = new CallSession(
    buildOutboundCallSessionOptions({ task, callAttempt, contact, telephony, calendar, systemPrompt, frontendSystemPrompt }),
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
    let booked: Awaited<ReturnType<typeof calendar.findEventByIdempotencyKey>>;
    try {
      booked = await calendar.findEventByIdempotencyKey(`confirm:${attempt.id}`);
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'stale-call sweep could not reach the calendar — reporting outcome as unknown');
    }

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
    } else {
      logger.warn({ taskId: task.id, callAttemptId: attempt.id }, 'stale call swept — no calendar event found');
      await transitionTask(
        task.id,
        'failed',
        {
          outcome: {
            kind: 'failed',
            reason: 'The call was interrupted before it finished, and no booking was found on the calendar. Its outcome is unknown.',
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
 * its scheduled time.
 */
export function startOrchestrationPoller(): void {
  setInterval(() => {
    listStartableTasks()
      .then((startable) => {
        for (const t of startable) triggerOrchestration(t.id);
      })
      .catch((err) => logger.error({ err }, 'Orchestration poller failed'));

    sweepStaleCalls().catch((err) => logger.error({ err }, 'Stale-call sweep failed'));
  }, POLL_INTERVAL_MS);
}
