import { describe, expect, it, vi } from 'vitest';

const insertValues = vi.fn();
const insertReturning = vi.fn();
insertValues.mockImplementation(() => ({ returning: insertReturning }));
const insertMock = vi.fn(() => ({ values: insertValues }));

vi.mock('../../src/db/index.js', () => ({
  db: { insert: insertMock },
}));

const { createTask } = await import('../../src/tasks/service.js');

describe('createTask', () => {
  it('defaults mode to "booking" when omitted', async () => {
    insertReturning.mockResolvedValue([{ id: 'task-1', mode: 'booking' }]);

    await createTask({
      contactId: 'contact-1',
      channel: 'phone',
      goalDescription: 'Book a haircut',
      constraints: {},
    });

    expect(insertValues).toHaveBeenCalledWith(expect.not.objectContaining({ mode: expect.anything() }));
  });

  it('passes mode: "conversation" through to the insert when given explicitly', async () => {
    insertReturning.mockResolvedValue([{ id: 'task-2', mode: 'conversation' }]);

    await createTask({
      contactId: 'contact-1',
      channel: 'phone',
      goalDescription: 'Call and say thanks',
      constraints: {},
      mode: 'conversation',
    });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ mode: 'conversation' }));
  });
});
