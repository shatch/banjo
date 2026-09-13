import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({ logger: log }));

const { isInsufficientScopeError, logGoogleContactsError, MISSING_CONTACTS_SCOPE_MESSAGE } = await import(
  '../../src/googleContacts/googleApiErrors.js'
);

/** The GaxiosError shape Google actually returned on 2026-09-12 for a Calendar-only refresh token. */
function scopeError(): Error {
  return Object.assign(new Error('Request had insufficient authentication scopes.'), {
    code: 403,
    status: 403,
    response: {
      data: {
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          status: 'PERMISSION_DENIED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
              domain: 'googleapis.com',
              metadata: { service: 'people.googleapis.com', method: 'google.people.v1.PeopleService.ListContactGroups' },
            },
          ],
        },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isInsufficientScopeError', () => {
  it("recognizes Google's 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT", () => {
    expect(isInsufficientScopeError(scopeError())).toBe(true);
  });

  it('recognizes the 403 by message when the details array is missing', () => {
    expect(isInsufficientScopeError(Object.assign(new Error('Request had insufficient authentication scopes.'), { status: 403 }))).toBe(true);
  });

  it('does not match other failures', () => {
    expect(isInsufficientScopeError(Object.assign(new Error('invalid_grant'), { status: 400 }))).toBe(false);
    expect(isInsufficientScopeError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe(false);
    expect(
      isInsufficientScopeError(
        Object.assign(new Error('People API has not been used in project'), {
          status: 403,
          response: { data: { error: { details: [{ reason: 'SERVICE_DISABLED' }] } } },
        }),
      ),
    ).toBe(false);
    expect(isInsufficientScopeError(new Error('boom'))).toBe(false);
    expect(isInsufficientScopeError(undefined)).toBe(false);
    expect(isInsufficientScopeError('403')).toBe(false);
  });
});

describe('logGoogleContactsError', () => {
  it('logs one actionable line — no error dump — for a missing contacts.readonly scope', () => {
    logGoogleContactsError(scopeError(), 'Google Contacts sync failed');

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(`Google Contacts sync failed: ${MISSING_CONTACTS_SCOPE_MESSAGE}`);
    expect(MISSING_CONTACTS_SCOPE_MESSAGE).toContain('contacts.readonly');
    expect(MISSING_CONTACTS_SCOPE_MESSAGE).toContain('docs/RUNBOOKS.md');
  });

  it('logs the full error for anything else, as before', () => {
    const err = new Error('boom');
    logGoogleContactsError(err, 'Google Contacts live lookup failed');

    expect(log.error).toHaveBeenCalledWith({ err }, 'Google Contacts live lookup failed');
  });
});
