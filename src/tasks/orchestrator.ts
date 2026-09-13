import { GoogleCalendarProvider } from '../calendar/googleCalendarProvider.js';
import { getContact } from '../contacts/service.js';
import { logger } from '../lib/logger.js';
import { CallSession } from '../session/callSession.js';
import { createTelephonyProvider } from '../telephony/factory.js';
import { buildOutboundCallSessionOptions } from './callSessionAdapter.js';
import { buildCallFrontendPrompt, buildCallSystemPrompt } from './promptBuilder.js';
import { createCallAttempt, getTask, listNonTerminalTasks, transitionTask } from './service.js';
import type { TimeWindow } from './schema.js';

const calendar = new GoogleCalendarProvider();

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

  const contact = await getContact(task.contactId);
  if (!contact) {
    await transitionTask(task.id, 'failed', { outcome: { kind: 'failed', reason: 'Contact not found' } });
    return;
  }

  await transitionTask(task.id, 'checking_availability');
  const candidateWindows = await calendar.computeCandidateWindows({
    dateWindows: task.constraints.dateWindows?.length ? task.constraints.dateWindows : defaultLookaheadWindow(),
    durationMinutes: task.constraints.durationMinutes ?? 30,
  });
  await transitionTask(task.id, 'calling', { candidateWindows });

  const callAttempt = await createCallAttempt(task.id);
  const telephony = createTelephonyProvider();
  const systemPrompt = buildCallSystemPrompt(task, contact, candidateWindows);
  const frontendSystemPrompt = buildCallFrontendPrompt(task, contact);

  const session = new CallSession(
    buildOutboundCallSessionOptions({ task, callAttempt, contact, telephony, calendar, systemPrompt, frontendSystemPrompt }),
  );
  await session.start();
}

function defaultLookaheadWindow(): TimeWindow[] {
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return [{ start: now.toISOString(), end: end.toISOString() }];
}

const POLL_INTERVAL_MS = 15_000;

/**
 * Restart-safety net: an in-process trigger is the primary hand-off
 * mechanism (see triggerOrchestration above), but a container restart could
 * leave a task stuck in a pre-calling status with no in-memory trigger left
 * to resume it. This poller re-picks-up anything not yet on a live call —
 * tasks already 'calling'/'negotiating' at restart time are NOT auto-resumed
 * (their call is already gone; v1 just leaves them for Steve to notice via
 * list_recent_tasks rather than guessing at a retry).
 */
export function startOrchestrationPoller(): void {
  setInterval(() => {
    listNonTerminalTasks()
      .then((pending) => {
        for (const t of pending) {
          if (t.status === 'pending' || t.status === 'checking_availability') {
            triggerOrchestration(t.id);
          }
        }
      })
      .catch((err) => logger.error({ err }, 'Orchestration poller failed'));
  }, POLL_INTERVAL_MS);
}
