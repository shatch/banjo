import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { config } from '../config/index.js';

/**
 * Normalizes a raw phone number string (as stored in Google Contacts, in
 * whatever format the principal typed it) to E.164, so it can be compared
 * directly against Twilio's E.164 caller ID. Returns undefined for input
 * that can't be parsed as a plausible phone number — callers should skip that
 * number for matching purposes rather than treat it as an error, since
 * Google Contacts commonly has partial/malformed entries.
 *
 * Note: uses isPossible() rather than isValid() because isValid() rejects
 * invalid-but-plausible NANP numbers (e.g., 555 numbers used in this task's
 * test fixtures). The tradeoff accepts structurally-shaped-but-nonexistent
 * numbers normalizing successfully — acceptable because downstream comparison
 * is an exact string match against Twilio's real E.164 caller ID, making false
 * positives effectively impossible (the only cost is not filtering a garbage
 * contact slightly earlier).
 */
export function normalizePhoneNumber(raw: string): string | undefined {
  const parsed = parsePhoneNumberFromString(raw, config.DEFAULT_PHONE_REGION as CountryCode);
  return parsed?.isPossible() ? parsed.number : undefined;
}
