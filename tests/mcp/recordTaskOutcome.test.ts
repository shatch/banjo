import { describe, expect, it } from 'vitest';
import { recordTaskOutcomeInputSchema, taskOutcomeSchema } from '../../src/mcp/tools/recordTaskOutcome.js';

describe('mcp: record_task_outcome schema', () => {
  it('accepts a confirmed outcome', () => {
    const result = taskOutcomeSchema.safeParse({
      kind: 'confirmed',
      start: '2026-08-05T14:00:00Z',
      durationMinutes: 45,
    });
    expect(result.success).toBe(true);
  });

  it('accepts each of the 5 outcome kinds mirrored from tasks/schema.ts', () => {
    const cases = [
      { kind: 'confirmed', start: '2026-08-05T14:00:00Z', durationMinutes: 30 },
      { kind: 'voicemail_left', message: 'Please call back to confirm.' },
      { kind: 'negotiation_failed', reason: 'No slots available this week.' },
      { kind: 'escalated', reason: 'Site required a login Steve needs to set up.' },
      { kind: 'failed', reason: 'Booking page errored out.' },
    ];
    for (const c of cases) {
      expect(taskOutcomeSchema.safeParse(c).success, JSON.stringify(c)).toBe(true);
    }
  });

  it('rejects an outcome with an unknown kind', () => {
    const result = taskOutcomeSchema.safeParse({ kind: 'something_else', reason: 'nope' });
    expect(result.success).toBe(false);
  });

  it('requires a valid contactId (uuid) on the full input', () => {
    const result = recordTaskOutcomeInputSchema.safeParse({
      contactId: 'not-a-uuid',
      goalDescription: 'Book a haircut',
      outcome: { kind: 'confirmed', start: '2026-08-05T14:00:00Z', durationMinutes: 30 },
    });
    expect(result.success).toBe(false);
  });
});
