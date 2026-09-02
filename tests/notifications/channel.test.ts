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
});
