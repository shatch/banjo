import { describe, expect, it } from 'vitest';
import { placeCallInputSchema } from '../../src/mcp/tools/placeCall.js';

describe('mcp: place_call schema', () => {
  it('accepts mode omitted, "booking", and "conversation"', () => {
    const base = { contactId: '11111111-1111-1111-1111-111111111111', taskDescription: 'Call and chat' };
    expect(placeCallInputSchema.safeParse(base).success).toBe(true);
    expect(placeCallInputSchema.safeParse({ ...base, mode: 'booking' }).success).toBe(true);
    expect(placeCallInputSchema.safeParse({ ...base, mode: 'conversation' }).success).toBe(true);
  });

  it('rejects an invalid mode value', () => {
    const result = placeCallInputSchema.safeParse({
      contactId: '11111111-1111-1111-1111-111111111111',
      taskDescription: 'Call and chat',
      mode: 'something_else',
    });
    expect(result.success).toBe(false);
  });
});
