import { config } from '../config/index.js';
import { callsPlacedToContactSince, dueQueuedCallsForContact } from './service.js';

/**
 * The per-number call cap: at most MAX_CALLS_PER_NUMBER_PER_DAY outbound calls
 * to one phone number in any rolling 24 hours. Checked twice: by place_call
 * when a call is requested (mcp/tools/placeCall.ts), and by the orchestrator
 * right before it dials (./orchestrator.ts), so a call scheduled earlier can't
 * slip past it. There is no override — each call is an AI calling a real
 * person, and five in one evening to one friend is how this came about.
 */
export const CALL_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CallCapResult {
  allowed: boolean;
  /** Calls counted against the cap (placed in the window, plus due queued calls when includeQueued). */
  count: number;
  /** When refused: the earliest moment another call fits, i.e. when the oldest counted call leaves the window. */
  nextAllowedAt?: Date;
}

/**
 * `includeQueued` also counts this contact's calls that are due and about to
 * dial but haven't yet — place_call passes it, so a burst of requests can't
 * queue past the cap. The orchestrator doesn't: the task it's about to dial
 * is itself queued.
 */
export async function checkCallCap(
  contactId: string,
  now: Date = new Date(),
  options: { includeQueued?: boolean } = {},
): Promise<CallCapResult> {
  const placed = await callsPlacedToContactSince(contactId, new Date(now.getTime() - CALL_CAP_WINDOW_MS));
  const queued = options.includeQueued ? await dueQueuedCallsForContact(contactId, now) : 0;
  const total = placed.count + queued;
  if (total < config.MAX_CALLS_PER_NUMBER_PER_DAY) return { allowed: true, count: total };
  // Queued calls haven't started, so they can't say when the window frees up;
  // with no placed call to go by, the earliest honest answer is a full window.
  const nextAllowedAt = new Date((placed.oldestStartedAt ?? now).getTime() + CALL_CAP_WINDOW_MS);
  return { allowed: false, count: total, nextAllowedAt };
}

const dialLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `work` with no other dial to the same contact in progress in this
 * process, so two due tasks can't both pass the cap check before either has
 * recorded its call attempt. (Several processes on one database aren't
 * covered — see #64.)
 */
export async function withContactDialLock<T>(contactId: string, work: () => Promise<T>): Promise<T> {
  const previous = dialLocks.get(contactId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  const settled = run.catch(() => {});
  dialLocks.set(contactId, settled);
  try {
    return await run;
  } finally {
    if (dialLocks.get(contactId) === settled) dialLocks.delete(contactId);
  }
}

/** The refusal, worded for whoever reads it: place_call's error, or a failed task's outcome reason. */
export function describeCallCapRefusal(result: CallCapResult): string {
  const next = result.nextAllowedAt
    ? ` Next call allowed after ${result.nextAllowedAt.toLocaleString('en-US', { timeZone: config.CALENDAR_TIMEZONE, dateStyle: 'medium', timeStyle: 'short' })} (${config.CALENDAR_TIMEZONE}).`
    : '';
  return `Call limit reached: this number was already called ${result.count} times in the last 24 hours (max ${config.MAX_CALLS_PER_NUMBER_PER_DAY}).${next}`;
}
