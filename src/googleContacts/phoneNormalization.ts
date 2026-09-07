import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { config } from '../config/index.js';

/**
 * Normalizes a raw phone number string (as stored in Google Contacts, in
 * whatever format the principal typed it) to E.164, so it can be compared
 * directly against Twilio's E.164 caller ID. Returns undefined for input
 * that can't be parsed as a valid phone number — callers should skip that
 * number for matching purposes rather than treat it as an error, since
 * Google Contacts commonly has partial/malformed entries.
 */
export function normalizePhoneNumber(raw: string): string | undefined {
  const parsed = parsePhoneNumberFromString(raw, config.DEFAULT_PHONE_REGION as CountryCode);
  return parsed?.isPossible() ? parsed.number : undefined;
}
