import { config } from '../config/index.js';
import { callsPlacedToContactSince, dueQueuedCallsForContact, withContactAdvisoryLock } from './service.js';

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
  /** Calls placed to this number in the last 24 hours. */
  placed: number;
  /** Calls due and about to dial, not yet placed — counted only with includeQueued. */
  queued: number;
  /**
   * When refused: when enough placed calls have left the window for one more
   * to fit. Undefined when queued calls alone fill the cap — they haven't
   * started, so there's no time to count from.
   */
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
  const startedAts = await callsPlacedToContactSince(contactId, new Date(now.getTime() - CALL_CAP_WINDOW_MS));
  const placed = startedAts.length;
  const queued = options.includeQueued ? await dueQueuedCallsForContact(contactId, now) : 0;
  const cap = config.MAX_CALLS_PER_NUMBER_PER_DAY;
  if (placed + queued < cap) return { allowed: true, placed, queued };
  // One more call fits once placed + queued - (calls that left) < cap, i.e.
  // after the k-th oldest placed call leaves the window. More than `cap` can be
  // counted (the cap was lowered, or calls queued before it existed).
  const mustLeave = placed + queued - cap + 1;
  const kthOldest = startedAts[mustLeave - 1];
  const nextAllowedAt = kthOldest ? new Date(kthOldest.getTime() + CALL_CAP_WINDOW_MS) : undefined;
  return { allowed: false, placed, queued, nextAllowedAt };
}

const dialLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `work` with no other dial to the same contact in progress, so two due
 * tasks can't both pass the cap check before either has recorded its call
 * attempt. Chained in-process first, so only one database connection per
 * contact waits on the advisory lock, which covers other processes on the
 * same database.
 */
export async function withContactDialLock<T>(contactId: string, work: () => Promise<T>): Promise<T> {
  const previous = dialLocks.get(contactId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => withContactAdvisoryLock(contactId, work));
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
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const counted = `${plural(result.placed, 'call')} placed in the last 24 hours${result.queued ? ` and ${result.queued} more queued` : ''}`;
  const next = result.nextAllowedAt
    ? ` Next call allowed after ${result.nextAllowedAt.toLocaleString('en-US', { timeZone: config.CALENDAR_TIMEZONE, dateStyle: 'medium', timeStyle: 'short' })} (${config.CALENDAR_TIMEZONE}).`
    : ' The next call is allowed once the queued calls have gone out and 24 hours have passed since them.';
  return `Call limit reached for this number: ${counted} (max ${config.MAX_CALLS_PER_NUMBER_PER_DAY} per 24 hours).${next}`;
}
