import type { Contact } from '../contacts/schema.js';
import { logger } from '../lib/logger.js';
import type { Task } from '../tasks/schema.js';
import { recentTasksForContact } from '../tasks/service.js';
import { screenCallRequest, type ScreenResult } from './screen.js';

/** How far back screening looks at calls to the same contact. */
const LOOKBACK_MS = 30 * 86_400_000;

/**
 * Screens one call (#150) for place_call, and for a scheduled call again
 * when it comes due (tasks/orchestrator.ts). Logs the result's kind only:
 * the reason can hold the model's words about what the agent wrote.
 */
export async function screenCall(
  contact: Contact,
  call: { mode: Task['mode']; goal: string; questions?: string[] | null; notes?: string },
): Promise<ScreenResult> {
  const recent = await recentTasksForContact(contact.id, new Date(Date.now() - LOOKBACK_MS)).catch((err: unknown) => {
    logger.error({ err, contactId: contact.id }, 'call screening could not read past calls');
    return null;
  });
  const result: ScreenResult = recent
    ? await screenCallRequest({ contact, mode: call.mode, goal: call.goal, questions: call.questions ?? undefined, notes: call.notes, recent })
    : { held: true, kind: 'check_failed', reason: "Banjo's screening check couldn't run on this request." };
  logger.info({ contactId: contact.id, held: result.held, ...(result.held && { kind: result.kind }) }, 'screened a call request');
  return result;
}

/** What place_call tells the agent about a held request: Banjo's words only, never the model's reason. */
export function heldForAgent(result: Extract<ScreenResult, { held: true }>): string {
  switch (result.kind) {
    case 'do_not_call':
      return 'They asked on an earlier call not to be called again.';
    case 'flagged':
      return 'Call screening flagged this request.';
    case 'check_failed':
      return "Call screening couldn't check this request.";
  }
}
