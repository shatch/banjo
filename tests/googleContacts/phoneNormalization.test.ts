import { describe, expect, it } from 'vitest';
import { normalizePhoneNumber } from '../../src/googleContacts/phoneNormalization.js';

describe('normalizePhoneNumber', () => {
  it('normalizes a US number with no country code to E.164, using DEFAULT_PHONE_REGION', () => {
    expect(normalizePhoneNumber('(555) 123-4567')).toBe('+15551234567');
  });

  it('leaves an already-E.164 number unchanged', () => {
    expect(normalizePhoneNumber('+15551234567')).toBe('+15551234567');
  });

  it('normalizes a number with an explicit country code regardless of DEFAULT_PHONE_REGION', () => {
    expect(normalizePhoneNumber('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('returns undefined for unparseable input', () => {
    expect(normalizePhoneNumber('not a phone number')).toBeUndefined();
  });

  it('returns undefined for a too-short number', () => {
    expect(normalizePhoneNumber('555')).toBeUndefined();
  });
});
