import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callsPlacedToContactSince, dueQueuedCallsForContact } = vi.hoisted(() => ({
  callsPlacedToContactSince: vi.fn(),
  dueQueuedCallsForContact: vi.fn(async () => 0),
}));
vi.mock('../../src/tasks/service.js', () => ({ callsPlacedToContactSince, dueQueuedCallsForContact }));

const { config } = await import('../../src/config/index.js');
const { checkCallCap, CALL_CAP_WINDOW_MS, withContactDialLock } = await import('../../src/tasks/callCap.js');

const now = new Date('2026-09-26T20:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  config.MAX_CALLS_PER_NUMBER_PER_DAY = 3;
});

describe('checkCallCap (at most MAX_CALLS_PER_NUMBER_PER_DAY calls per number per rolling 24h)', () => {
  it('allows a call while fewer than the cap were placed in the last 24 hours', async () => {
    callsPlacedToContactSince.mockResolvedValue({ count: 2, oldestStartedAt: new Date('2026-09-26T10:00:00.000Z') });
    expect((await checkCallCap('c1', now)).allowed).toBe(true);
    expect(callsPlacedToContactSince).toHaveBeenCalledWith('c1', new Date(now.getTime() - CALL_CAP_WINDOW_MS));
  });

  it('refuses at the cap, and says when the oldest call leaves the window', async () => {
    callsPlacedToContactSince.mockResolvedValue({ count: 3, oldestStartedAt: new Date('2026-09-26T10:00:00.000Z') });
    const result = await checkCallCap('c1', now);
    expect(result.allowed).toBe(false);
    expect(result.nextAllowedAt?.toISOString()).toBe('2026-09-27T10:00:00.000Z');
  });

  it('counts due queued calls too when asked (place_call), so queued calls cannot all go out', async () => {
    callsPlacedToContactSince.mockResolvedValue({ count: 1, oldestStartedAt: new Date('2026-09-26T10:00:00.000Z') });
    dueQueuedCallsForContact.mockResolvedValue(2);
    expect((await checkCallCap('c1', now, { includeQueued: true })).allowed).toBe(false);
    expect((await checkCallCap('c1', now)).allowed).toBe(true);
  });

  it('follows the configured cap', async () => {
    config.MAX_CALLS_PER_NUMBER_PER_DAY = 1;
    callsPlacedToContactSince.mockResolvedValue({ count: 1, oldestStartedAt: new Date('2026-09-26T10:00:00.000Z') });
    expect((await checkCallCap('c1', now)).allowed).toBe(false);
  });
});

describe('withContactDialLock', () => {
  it('runs dials to the same contact one at a time, so two cannot both pass the cap check', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withContactDialLock('c1', async () => {
      order.push('first start');
      await new Promise<void>((r) => (release = r));
      order.push('first end');
    });
    const second = withContactDialLock('c1', async () => {
      order.push('second');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'first end', 'second']);
  });

  it('releases the lock when the work throws', async () => {
    await expect(withContactDialLock('c2', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withContactDialLock('c2', async () => 'ok')).resolves.toBe('ok');
  });
});
