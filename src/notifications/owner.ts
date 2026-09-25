import { config } from '../config/index.js';
import type { NotificationChannel } from './channel.js';
import { PushoverNotificationChannel, sendPushover } from './pushover.js';
import { NoopNotificationChannel, sendOwnerSms, TwilioSmsNotificationChannel } from './twilioSms.js';

/**
 * Tells the owner something directly, over whichever NOTIFICATION_CHANNEL is
 * configured — for events with no Task outcome to report: inbound bookings
 * and reschedules, an inbound call flagged for attention, a booking written
 * after its call was already reported. A no-op for NOTIFICATION_CHANNEL=none.
 * `urgent` raises the Pushover priority past quiet hours; SMS has no
 * equivalent, so it's ignored there.
 */
export async function sendOwnerMessage(body: string, { urgent = false }: { urgent?: boolean } = {}): Promise<void> {
  switch (config.NOTIFICATION_CHANNEL) {
    case 'twilio_sms':
      return sendOwnerSms(body);
    case 'pushover':
      return sendPushover({ message: body, urgent });
    case 'none':
      return;
  }
}

let instance: NotificationChannel | null = null;

/** The channel for end-of-call outcome summaries, per NOTIFICATION_CHANNEL. */
export function createNotificationChannel(): NotificationChannel {
  if (instance) return instance;
  switch (config.NOTIFICATION_CHANNEL) {
    case 'twilio_sms':
      instance = new TwilioSmsNotificationChannel();
      break;
    case 'pushover':
      instance = new PushoverNotificationChannel();
      break;
    case 'none':
      instance = new NoopNotificationChannel();
      break;
  }
  return instance;
}
