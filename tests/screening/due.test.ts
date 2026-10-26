import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../src/contacts/schema.js';
import type { Task } from '../../src/tasks/schema.js';

// A scheduled call screened again when it comes due (#150).
const { screenCall, holdForScreening, cancelPendingTask, sendOwnerMessage } = vi.hoisted(() => ({
  screenCall: vi.fn(async (): Promise<{ held: false } | { held: true; kind: 'do_not_call' | 'flagged' | 'check_failed'; reason: string }> => ({ held: false })),
  holdForScreening: vi.fn(
    async (id: string, reason: string, approvalExpiresAt: Date) =>
      ({ id, goalDescription: 'Check in', mode: 'conversation', questions: null, scheduledFor: null, constraints: {}, screenFlag: reason, approvalExpiresAt, requestedByAgent: false }) as unknown as Task,
  ),
  cancelPendingTask: vi.fn(async () => undefined),
  sendOwnerMessage: vi.fn(async () => true),
}));
vi.mock('../../src/screening/request.js', () => ({ screenCall }));
vi.mock('../../src/tasks/service.js', () => ({ holdForScreening, cancelPendingTask }));
vi.mock('../../src/notifications/owner.js', () => ({ sendOwnerMessage }));
vi.mock('../../src/googleContacts/lookup.js', () => ({ addressBookNameFor: vi.fn(async () => undefined) }));

const { needsScreeningWhenDue, screenWhenDue } = await import('../../src/screening/due.js');
const { config } = await import('../../src/config/index.js');
config.PUBLIC_HOSTNAME = 'banjo.example.com';

const contact = { id: 'contact-1', displayName: 'Robin', phoneNumber: '+15550001111', doNotCallAt: null } as Contact;
const task = {
  id: 'task-1',
  mode: 'conversation',
  goalDescription: 'Check in',
  questions: null,
  constraints: {},
  scheduledFor: new Date('2026-10-26T15:00:00Z'),
  approvedAt: null,
  requestedByAgent: false,
} as unknown as Task;

beforeEach(() => vi.clearAllMocks());

describe('needsScreeningWhenDue', () => {
  it('screens a scheduled call the owner has not approved', () => {
    expect(needsScreeningWhenDue(task, contact)).toBe(true);
    expect(needsScreeningWhenDue({ ...task, scheduledFor: null }, contact)).toBe(false);
  });

  it('skips one the owner approved, unless they asked not to be called after that', () => {
    const approvedAt = new Date('2026-10-25T12:00:00Z');
    expect(needsScreeningWhenDue({ ...task, approvedAt }, contact)).toBe(false);
    expect(needsScreeningWhenDue({ ...task, approvedAt }, { ...contact, doNotCallAt: new Date('2026-10-24T12:00:00Z') })).toBe(false);
    expect(needsScreeningWhenDue({ ...task, approvedAt }, { ...contact, doNotCallAt: new Date('2026-10-25T18:00:00Z') })).toBe(true);
  });
});

describe('screenWhenDue', () => {
  it('lets a call that passes go ahead', async () => {
    await expect(screenWhenDue(task, contact)).resolves.toBe(false);
    expect(holdForScreening).not.toHaveBeenCalled();
  });

  it('holds a call that no longer passes, and asks the owner', async () => {
    screenCall.mockResolvedValueOnce({ held: true, kind: 'do_not_call', reason: 'They asked not to be called again.' });
    await expect(screenWhenDue(task, contact)).resolves.toBe(true);
    expect(holdForScreening).toHaveBeenCalledWith('task-1', 'They asked not to be called again.', expect.any(Date));
    const [message] = sendOwnerMessage.mock.calls[0]! as unknown as [string];
    expect(message).toContain('Held by call screening: They asked not to be called again.');
    expect(cancelPendingTask).not.toHaveBeenCalled();
  });

  it("cancels it when the owner can't be reached, and never dials", async () => {
    screenCall.mockResolvedValueOnce({ held: true, kind: 'check_failed', reason: "couldn't run" });
    sendOwnerMessage.mockResolvedValueOnce(false);
    await expect(screenWhenDue(task, contact)).resolves.toBe(true);
    expect(cancelPendingTask).toHaveBeenCalledWith('task-1');
  });

  it('does not dial a task that stopped being pending while it was screened', async () => {
    screenCall.mockResolvedValueOnce({ held: true, kind: 'flagged', reason: 'x' });
    holdForScreening.mockResolvedValueOnce(undefined as unknown as Task);
    await expect(screenWhenDue(task, contact)).resolves.toBe(true);
    expect(sendOwnerMessage).not.toHaveBeenCalled();
  });
});
