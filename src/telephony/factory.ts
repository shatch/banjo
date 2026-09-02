import { TwilioProvider } from './providers/twilio.js';
import type { TelephonyProvider } from './providers/types.js';

let instance: TelephonyProvider | null = null;

/**
 * Singleton by design — a single running ea process holds one active
 * telephony account connection for the process lifetime, reused across
 * calls (the telephony SDK client itself is stateless/reusable; per-call
 * state lives inside the provider keyed by callId).
 *
 * Twilio is the only implementation — a LiveKit adapter was scaffolded
 * early on but never got past non-functional placeholders for audio I/O
 * (see docs/ARCHITECTURE.md's Open Risks history) and carried zero live
 * traffic, so it was removed rather than kept as unmaintained dead code.
 * Kept as a function (not a bare `new TwilioProvider()` export) so a future
 * second provider can still be added here without changing call sites.
 */
export function createTelephonyProvider(): TelephonyProvider {
  if (!instance) instance = new TwilioProvider();
  return instance;
}
