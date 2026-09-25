import twilioLib from 'twilio';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import type { TaskOutcome } from '../tasks/schema.js';
import type { NotificationChannel } from './channel.js';

let smsClient: ReturnType<typeof twilioLib> | null = null;
function getSmsClient(): ReturnType<typeof twilioLib> {
  if (!smsClient) smsClient = twilioLib(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  return smsClient;
}

/**
 * Texts the assistant's owner a plain message, outside the Task/TaskOutcome-shaped
 * NotificationChannel interface below — used by src/inbound/tools.ts, which
 * has no Task to report an outcome for (there's no per-call outcome model
 * on the inbound side, just individual booking/reschedule events). Callers
 * go through sendOwnerMessage (./owner.ts), which picks the channel. A no-op
 * (not an error) when NOTIFICATION_CHANNEL isn't 'twilio_sms', matching
 * NoopNotificationChannel's behavior for the Task-shaped path below.
 */
export async function sendOwnerSms(body: string): Promise<void> {
  if (config.NOTIFICATION_CHANNEL !== 'twilio_sms') return;
  await sendSms(body, {});
}

/**
 * How long after sending to check whether the text actually arrived. Twilio
 * accepting a message is not delivery: a carrier can still block it, and
 * messages.create() has already succeeded by then.
 */
export const DELIVERY_CHECK_DELAY_MS = 30_000;

const DELIVERY_FAILED = new Set(['undelivered', 'failed']);

/** What an operator should do about a carrier error code. */
function deliveryHint(errorCode: number | null): string {
  if (errorCode === 30034) {
    return 'notification SMS blocked by the carrier: NOTIFY_FROM_PHONE_NUMBER is not registered for US A2P 10DLC — see docs/RUNBOOKS.md, "SMS notifications aren\'t arriving"';
  }
  return 'notification SMS was not delivered — see the Twilio error code';
}

/**
 * Sends, then checks delivery once after DELIVERY_CHECK_DELAY_MS. Every
 * notification for a week was accepted by Twilio and then blocked by the
 * carrier (error 30034) with nothing logged, because the send itself had
 * succeeded. Never throws: a notification problem must not reach the call.
 */
async function sendSms(body: string, logContext: Record<string, unknown>): Promise<void> {
  let messageSid: string;
  try {
    const message = await getSmsClient().messages.create({
      to: config.NOTIFY_TO_PHONE_NUMBER!,
      from: config.NOTIFY_FROM_PHONE_NUMBER!,
      body,
    });
    messageSid = message.sid;
  } catch (err) {
    logger.error({ err, ...logContext }, 'Failed to send notification SMS');
    return;
  }
  setTimeout(() => {
    getSmsClient()
      .messages(messageSid)
      .fetch()
      .then(({ status, errorCode }) => {
        if (DELIVERY_FAILED.has(status)) logger.error({ ...logContext, messageSid, status, errorCode }, deliveryHint(errorCode));
      })
      .catch((err) => logger.warn({ err, messageSid }, 'could not check notification SMS delivery'));
  }, DELIVERY_CHECK_DELAY_MS).unref();
}

export class TwilioSmsNotificationChannel implements NotificationChannel {
  async notify(taskId: string, outcome: TaskOutcome, summary: string): Promise<void> {
    // The kind only: a voicemail_left outcome carries the message spoken to
    // the other party (#8). The logger redacts it too; this doesn't rely on that.
    await sendSms(summary, { taskId, outcomeKind: outcome.kind });
  }
}

export class NoopNotificationChannel implements NotificationChannel {
  async notify(): Promise<void> {
    // NOTIFICATION_CHANNEL=none — used in local dev / tests.
  }
}
