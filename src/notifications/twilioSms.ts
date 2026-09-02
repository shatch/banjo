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
 * on the inbound side, just individual booking/reschedule events). A no-op
 * (not an error) when NOTIFICATION_CHANNEL isn't 'twilio_sms', matching
 * NoopNotificationChannel's behavior for the Task-shaped path below.
 */
export async function sendOwnerSms(body: string): Promise<void> {
  if (config.NOTIFICATION_CHANNEL !== 'twilio_sms') return;
  try {
    await getSmsClient().messages.create({
      to: config.NOTIFY_TO_PHONE_NUMBER!,
      from: config.NOTIFY_FROM_PHONE_NUMBER!,
      body,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to send notification SMS');
  }
}

export class TwilioSmsNotificationChannel implements NotificationChannel {
  async notify(taskId: string, outcome: TaskOutcome, summary: string): Promise<void> {
    try {
      await getSmsClient().messages.create({
        to: config.NOTIFY_TO_PHONE_NUMBER!,
        from: config.NOTIFY_FROM_PHONE_NUMBER!,
        body: summary,
      });
    } catch (err) {
      logger.error({ err, taskId, outcome }, 'Failed to send notification SMS');
    }
  }
}

export class NoopNotificationChannel implements NotificationChannel {
  async notify(): Promise<void> {
    // NOTIFICATION_CHANNEL=none — used in local dev / tests.
  }
}

let instance: NotificationChannel | null = null;

export function createNotificationChannel(): NotificationChannel {
  if (instance) return instance;
  instance = config.NOTIFICATION_CHANNEL === 'twilio_sms' ? new TwilioSmsNotificationChannel() : new NoopNotificationChannel();
  return instance;
}
