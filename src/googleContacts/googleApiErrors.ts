import { logger } from '../lib/logger.js';

export const MISSING_CONTACTS_SCOPE_MESSAGE =
  'GOOGLE_OAUTH_REFRESH_TOKEN lacks the contacts.readonly scope — re-mint it with both the calendar and contacts.readonly scopes (docs/RUNBOOKS.md, "Minting GOOGLE_OAUTH_REFRESH_TOKEN")';

/**
 * True for Google's 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT: the refresh token is
 * valid, but was minted without contacts.readonly (typically a Calendar-only
 * token). Seen for real on 2026-09-12 — every sync and lookup failed with a
 * ~100-line GaxiosError dump that never said what to do about it.
 */
export function isInsufficientScopeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    response?: { data?: { error?: { details?: Array<{ reason?: unknown } | null> } } };
  };
  if ((e.status ?? e.code) !== 403) return false;
  const details = e.response?.data?.error?.details ?? [];
  if (details.some((detail) => detail?.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')) return true;
  return typeof e.message === 'string' && e.message.includes('insufficient authentication scopes');
}

/** Logs a Google Contacts failure: one actionable line for a missing scope, the full error for anything else. */
export function logGoogleContactsError(err: unknown, message: string): void {
  if (isInsufficientScopeError(err)) {
    logger.error(`${message}: ${MISSING_CONTACTS_SCOPE_MESSAGE}`);
    return;
  }
  logger.error({ err }, message);
}
