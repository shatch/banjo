import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import type { TaskOutcome } from '../tasks/schema.js';
import type { NotificationChannel } from './channel.js';

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';
// Pushover's documented limits; longer messages are rejected, not truncated.
const MAX_MESSAGE_CHARS = 1024;
const MAX_TITLE_CHARS = 250;
const REQUEST_TIMEOUT_MS = 10_000;
/** Pushover asks clients to wait at least 5 seconds before retrying a 5xx. */
export const RETRY_DELAY_MS = 5_000;

export interface PushoverMessage {
  message: string;
  title?: string;
  /** Pushover priority 1 bypasses the owner's quiet hours; 0 is normal. */
  urgent?: boolean;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formBody({ message, title, urgent }: PushoverMessage): URLSearchParams {
  const body = new URLSearchParams({
    token: config.PUSHOVER_APP_TOKEN!,
    user: config.PUSHOVER_USER_KEY!,
    message: truncate(message, MAX_MESSAGE_CHARS),
    title: truncate(title ?? 'Banjo', MAX_TITLE_CHARS),
    priority: urgent ? '1' : '0',
  });
  if (config.PUSHOVER_DEVICE) body.set('device', config.PUSHOVER_DEVICE);
  return body;
}

type Attempt = { ok: true } | { ok: false; retryable: boolean; detail: Record<string, unknown> };

async function attempt(body: URLSearchParams): Promise<Attempt> {
  try {
    const response = await fetch(PUSHOVER_URL, { method: 'POST', body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.ok) {
      await response.body?.cancel();
      return { ok: true };
    }
    // 4xx carries an `errors` array saying what's wrong (bad token, unknown
    // user). It's safe to log: it never echoes the token or the message.
    const payload = (await response.json().catch(() => ({}))) as { errors?: unknown };
    return { ok: false, retryable: response.status >= 500, detail: { status: response.status, errors: payload.errors } };
  } catch (err) {
    // Network failure or timeout — worth one retry, like a 5xx.
    return { ok: false, retryable: true, detail: { err } };
  }
}

/**
 * Sends one Pushover notification. Never throws: a notification problem
 * must not reach the call. Retries once after RETRY_DELAY_MS on a network
 * error or 5xx, per Pushover's API guidance; a 4xx is a configuration
 * problem and is logged, not retried.
 */
export async function sendPushover(msg: PushoverMessage, logContext: Record<string, unknown> = {}): Promise<void> {
  const body = formBody(msg);
  let result = await attempt(body);
  if (!result.ok && result.retryable) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    result = await attempt(body);
  }
  if (!result.ok) logger.error({ ...logContext, ...result.detail }, 'Failed to send Pushover notification');
}

const NEEDS_ATTENTION: ReadonlySet<TaskOutcome['kind']> = new Set(['negotiation_failed', 'escalated', 'failed']);

const TITLES: Record<TaskOutcome['kind'], string> = {
  confirmed: 'Banjo: booked',
  voicemail_left: 'Banjo: left a voicemail',
  negotiation_failed: 'Banjo: needs your attention',
  escalated: 'Banjo: needs your attention',
  failed: 'Banjo: call failed',
  conversation_completed: 'Banjo: call finished',
};

export class PushoverNotificationChannel implements NotificationChannel {
  async notify(taskId: string, outcome: TaskOutcome, summary: string): Promise<void> {
    // The kind only in logs: a voicemail_left outcome carries the message
    // spoken to the other party (#8).
    await sendPushover(
      { message: summary, title: TITLES[outcome.kind], urgent: NEEDS_ATTENTION.has(outcome.kind) },
      { taskId, outcomeKind: outcome.kind },
    );
  }
}
