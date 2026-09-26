import { describe, expect, it } from 'vitest';
import type { Contact } from '../../src/contacts/schema.js';
import { buildOutcomeSummary } from '../../src/notifications/channel.js';

const contact = { displayName: 'Alex' } as Contact;

describe('buildOutcomeSummary', () => {
  it('summarizes a conversation_completed outcome', () => {
    const summary = buildOutcomeSummary(contact, {
      kind: 'conversation_completed',
      summary: 'Thanked them for hosting; said the visit was great.',
    });
    expect(summary).toContain('Alex');
    expect(summary).toContain('Thanked them for hosting; said the visit was great.');
  });

  it('still summarizes a confirmed outcome (existing behavior unchanged)', () => {
    const summary = buildOutcomeSummary(contact, {
      kind: 'confirmed',
      start: '2026-08-05T14:00:00Z',
      durationMinutes: 30,
    });
    expect(summary).toContain('Booked with Alex');
  });

  it("gives a booking's time in the calendar timezone, not the server's", () => {
    // The SMS for a real 4pm booking read "9/24/2026, 8:00:00 PM": the
    // container runs in UTC and the summary used toLocaleString().
    const summary = buildOutcomeSummary({ displayName: 'John Federico' } as Contact, {
      kind: 'confirmed',
      start: '2026-09-24T20:00:00.000Z',
      durationMinutes: 30,
    });
    expect(summary).toContain('Thursday, September 24 at 4:00 PM');
    expect(summary).not.toContain('8:00');
  });

  it('summarizes a transfer (#7)', () => {
    const summary = buildOutcomeSummary({ displayName: "Luigi's" } as Contact, { kind: 'transferred', reason: 'they need a card number' });
    expect(summary).toBe("Transferred Luigi's to you — they need a card number.");
  });
});
