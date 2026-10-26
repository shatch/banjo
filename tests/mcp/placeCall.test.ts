import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// placeCallHandler writes a Task row and triggers orchestration — stub both so
// the scheduling behavior can be exercised without a DB or a real call.
const { createTask, triggerOrchestration, countOpenApprovalRequests, cancelPendingTask, getContact, sendOwnerMessage } = vi.hoisted(() => ({
  createTask: vi.fn(async (input: Record<string, unknown>) => ({
    id: 'task-1',
    goalDescription: input.goalDescription,
    mode: input.mode ?? 'booking',
    questions: input.questions ?? null,
    scheduledFor: input.scheduledFor ?? null,
    approvalExpiresAt: input.approvalExpiresAt ?? null,
    requestedByAgent: input.requestedByAgent ?? false,
    screenFlag: input.screenFlag ?? null,
  })),
  triggerOrchestration: vi.fn(),
  countOpenApprovalRequests: vi.fn(async () => 0),
  cancelPendingTask: vi.fn(async () => ({})),
  getContact: vi.fn(
    async (): Promise<{ id: string; displayName: string; phoneNumber: string; relationshipTier: 'family' | 'friend' | null } | undefined> => ({
      id: '11111111-1111-1111-1111-111111111111',
      displayName: 'Salon',
      phoneNumber: '+15550001111',
      relationshipTier: null,
    }),
  ),
  sendOwnerMessage: vi.fn(async () => true),
}));
const { lockLog, withApprovalRequestLock } = vi.hoisted(() => {
  const lockLog: string[] = [];
  return {
    lockLog,
    withApprovalRequestLock: vi.fn(async <T,>(work: () => Promise<T>) => {
      lockLog.push('lock');
      try {
        return await work();
      } finally {
        lockLog.push('unlock');
      }
    }),
  };
});
vi.mock('../../src/tasks/service.js', () => ({ createTask, countOpenApprovalRequests, cancelPendingTask, withApprovalRequestLock }));
vi.mock('../../src/contacts/service.js', () => ({ getContact }));
const { addressBookNameFor } = vi.hoisted(() => ({ addressBookNameFor: vi.fn(async (): Promise<string | undefined> => undefined) }));
vi.mock('../../src/googleContacts/lookup.js', () => ({ addressBookNameFor }));
vi.mock('../../src/notifications/owner.js', () => ({ sendOwnerMessage }));
vi.mock('../../src/tasks/orchestrator.js', () => ({ triggerOrchestration }));
const { screenCall } = vi.hoisted(() => ({
  screenCall: vi.fn(async (): Promise<{ held: false } | { held: true; kind: 'do_not_call' | 'flagged' | 'check_failed'; reason: string }> => ({ held: false })),
}));
vi.mock('../../src/screening/request.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/screening/request.js')>()),
  screenCall,
}));
const { checkCallCap } = vi.hoisted(() => ({
  checkCallCap: vi.fn(
    async () => ({ allowed: true, placed: 0, queued: 0, limit: 3 }) as { allowed: boolean; placed: number; queued: number; nextAllowedAt?: Date; limit: number },
  ),
}));
vi.mock('../../src/tasks/callCap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tasks/callCap.js')>()),
  checkCallCap,
}));

const { placeCallHandler, placeCallInputSchema } = await import('../../src/mcp/tools/placeCall.js');
const { config } = await import('../../src/config/index.js');

const CONTACT_ID = '11111111-1111-1111-1111-111111111111';

describe('mcp: place_call schema', () => {
  it('accepts mode omitted, "booking", and "conversation"', () => {
    const base = { contactId: CONTACT_ID, taskDescription: 'Call and chat' };
    expect(placeCallInputSchema.safeParse(base).success).toBe(true);
    expect(placeCallInputSchema.safeParse({ ...base, mode: 'booking' }).success).toBe(true);
    expect(placeCallInputSchema.safeParse({ ...base, mode: 'conversation' }).success).toBe(true);
  });

  it("accepts mode 'ask' with up to 5 questions, and rejects more, or an empty one (#148)", () => {
    const base = { contactId: CONTACT_ID, taskDescription: 'Find out their Saturday hours', mode: 'ask' };
    expect(placeCallInputSchema.safeParse({ ...base, questions: ['When do you close Saturday?'] }).success).toBe(true);
    expect(placeCallInputSchema.safeParse({ ...base, questions: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false);
    expect(placeCallInputSchema.safeParse({ ...base, questions: ['  '] }).success).toBe(false);
    expect(placeCallInputSchema.safeParse({ ...base, questions: [] }).success).toBe(false);
  });

  it('rejects a question with a line break in it, which would break the numbering answers are matched by (#148 review)', () => {
    const base = { contactId: CONTACT_ID, taskDescription: 'Find out their Saturday hours', mode: 'ask' };
    for (const question of ['Hours?\n2. Walk-ins?', 'Hours?\r\nWalk-ins?', 'Hours?\rWalk-ins?']) {
      const result = placeCallInputSchema.safeParse({ ...base, questions: [question] });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toMatch(/one line/i);
    }
    // Only the ends are trimmed, so a trailing newline is fine.
    expect(placeCallInputSchema.safeParse({ ...base, questions: ['Hours?\n'] }).success).toBe(true);
  });

  it('accepts a per-call hold limit of 1 to 45 minutes (#151)', () => {
    const base = { contactId: CONTACT_ID, taskDescription: 'Ask about my refill' };
    expect(placeCallInputSchema.safeParse({ ...base, constraints: { maxHoldMinutes: 30 } }).success).toBe(true);
    expect(placeCallInputSchema.safeParse({ ...base, constraints: { maxHoldMinutes: 0 } }).success).toBe(false);
    expect(placeCallInputSchema.safeParse({ ...base, constraints: { maxHoldMinutes: 46 } }).success).toBe(false);
  });

  it('rejects an invalid mode value', () => {
    const result = placeCallInputSchema.safeParse({
      contactId: CONTACT_ID,
      taskDescription: 'Call and chat',
      mode: 'something_else',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional scheduledFor local date-time', () => {
    expect(
      placeCallInputSchema.safeParse({ contactId: CONTACT_ID, taskDescription: 'Call later', scheduledFor: '2026-09-13T09:00:00' }).success,
    ).toBe(true);
  });
});

describe("mcp: place_call, mode 'ask'", () => {
  it('refuses date windows, which an ask call never uses (#148 review)', async () => {
    await expect(
      placeCallHandler({
        contactId: CONTACT_ID,
        taskDescription: 'Find out their Saturday hours',
        mode: 'ask',
        questions: ['When do you close Saturday?'],
        constraints: { dateWindows: [{ start: '2026-10-20T09:00:00', end: '2026-10-20T17:00:00' }] },
      }, { role: 'owner' }),
    ).rejects.toThrow(/dateWindows/);
  });
});

describe('mcp: place_call scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T04:30:00.000Z')); // 12:30am in America/New_York (the vitest default zone)
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls right away when scheduledFor is omitted', async () => {
    const result = await placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call and chat' }, { role: 'owner' });

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ scheduledFor: undefined }));
    expect(triggerOrchestration).toHaveBeenCalledWith('task-1');
    expect(result.ackMessage).toContain('Started calling');
  });

  it('stores a future scheduledFor interpreted in CALENDAR_TIMEZONE, and does not start the call yet', async () => {
    const result = await placeCallHandler({
      contactId: CONTACT_ID,
      taskDescription: 'Ask about breakfast',
      scheduledFor: '2026-09-13T09:00:00',
    }, { role: 'owner' });

    // 9:00am America/New_York in September is EDT (UTC-4) — never the server's own zone.
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ scheduledFor: new Date('2026-09-13T13:00:00.000Z') }));
    expect(triggerOrchestration).not.toHaveBeenCalled();
    expect(result.ackMessage).toContain('Scheduled a call');
    expect(result.ackMessage).toContain('9:00');
  });

  it('calls right away when scheduledFor is only a few minutes in the past', async () => {
    // 12:27am America/New_York — 3 minutes before the fake "now" of 12:30am.
    await placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call now', scheduledFor: '2026-09-13T00:27:00' }, { role: 'owner' });

    expect(triggerOrchestration).toHaveBeenCalledWith('task-1');
  });

  it('rejects a scheduledFor well in the past — a wrong date or year must not dial immediately', async () => {
    await expect(placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call later', scheduledFor: '2025-09-13T09:00:00' }, { role: 'owner' })).rejects.toThrow(
      /already in the past/,
    );
    await expect(placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call later', scheduledFor: '2026-09-12T20:00:00' }, { role: 'owner' })).rejects.toThrow(
      /already in the past/,
    );
    expect(createTask).not.toHaveBeenCalled();
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });

  it('rejects a date-only scheduledFor, which would otherwise place the call at midnight, without creating a task', async () => {
    await expect(placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call tomorrow', scheduledFor: '2026-09-14' }, { role: 'owner' })).rejects.toThrow(
      /must include a time of day/,
    );
    expect(createTask).not.toHaveBeenCalled();
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });

  it('rejects an unparseable scheduledFor without creating a task', async () => {
    await expect(placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call later', scheduledFor: '2026-02-30Tnoon:00' }, { role: 'owner' })).rejects.toThrow(
      /scheduledFor/,
    );
    expect(createTask).not.toHaveBeenCalled();
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });
});

describe('mcp: place_call per-number call cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks the cap for this contact, counting queued calls, before creating anything', async () => {
    await placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call and chat' }, { role: 'owner' });
    expect(checkCallCap).toHaveBeenCalledWith(CONTACT_ID, expect.any(Date), { includeQueued: true, includeAwaitingApproval: false, limit: 3 });
    expect(createTask).toHaveBeenCalled();
  });

  it('refuses a call over the cap without creating a task, and says when the next call is allowed', async () => {
    checkCallCap.mockResolvedValueOnce({ allowed: false, placed: 3, queued: 0, nextAllowedAt: new Date('2026-09-27T01:23:44.000Z'), limit: 3 });
    await expect(placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call again' }, { role: 'owner' })).rejects.toThrow(
      /call limit reached.*next call allowed/i,
    );
    expect(createTask).not.toHaveBeenCalled();
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });

  it("leaves a call scheduled for later to the check at dial time — tonight's calls may be out of the window by then", async () => {
    checkCallCap.mockResolvedValueOnce({ allowed: false, placed: 3, queued: 0, nextAllowedAt: new Date('2026-09-27T01:23:44.000Z'), limit: 3 });
    await placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Call later', scheduledFor: '2099-09-13T09:00:00' }, { role: 'owner' });
    expect(checkCallCap).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalled();
  });
});

describe('mcp: place_call date windows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps queued once-values — drop the refusal the call-cap
    // block's scheduled-for-later test queues but never consumes.
    checkCallCap.mockReset();
    checkCallCap.mockResolvedValue({ allowed: true, placed: 0, queued: 0, limit: 3 });
  });

  it('stores offset-less window times as UTC instants read in CALENDAR_TIMEZONE, never the server zone', async () => {
    await placeCallHandler({
      contactId: CONTACT_ID,
      taskDescription: 'Book a haircut',
      constraints: { dateWindows: [{ start: '2026-10-01T15:00:00', end: '2026-10-01T18:00:00' }], durationMinutes: 30 },
    }, { role: 'owner' });

    // 3pm-6pm America/New_York in October is EDT (UTC-4).
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: {
          dateWindows: [{ start: '2026-10-01T19:00:00.000Z', end: '2026-10-01T22:00:00.000Z' }],
          durationMinutes: 30,
        },
      }),
    );
  });

  it('keeps a window time that already carries an offset at the instant it names', async () => {
    await placeCallHandler({
      contactId: CONTACT_ID,
      taskDescription: 'Book a haircut',
      constraints: { dateWindows: [{ start: '2026-10-01T15:00:00-07:00', end: '2026-10-01T18:00:00Z' }] },
    }, { role: 'owner' });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: { dateWindows: [{ start: '2026-10-01T22:00:00.000Z', end: '2026-10-01T18:00:00.000Z' }] },
      }),
    );
  });

  it('rejects an unparseable window time without creating a task', async () => {
    await expect(
      placeCallHandler({
        contactId: CONTACT_ID,
        taskDescription: 'Book a haircut',
        constraints: { dateWindows: [{ start: 'next tuesday', end: '2026-10-01T18:00:00' }] },
      }, { role: 'owner' }),
    ).rejects.toThrow(/dateWindows/);
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("mcp: place_call with mode 'ask' (#148)", () => {
  beforeEach(() => {
    createTask.mockClear();
    triggerOrchestration.mockClear();
  });

  it('stores the questions on the task and starts the call', async () => {
    await placeCallHandler({
      contactId: CONTACT_ID,
      taskDescription: 'Find out their Saturday hours',
      mode: 'ask',
      questions: ['When do you close Saturday?'],
    }, { role: 'owner' });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ask', questions: ['When do you close Saturday?'] }));
    expect(triggerOrchestration).toHaveBeenCalledWith('task-1');
  });

  it('refuses an ask call with no questions, before creating anything', async () => {
    await expect(placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Find out their hours', mode: 'ask' }, { role: 'owner' })).rejects.toThrow(
      "mode 'ask' needs at least one question",
    );
    expect(createTask).not.toHaveBeenCalled();
  });

  it('refuses questions on a booking call', async () => {
    await expect(
      placeCallHandler({ contactId: CONTACT_ID, taskDescription: 'Book a haircut', questions: ['Any openings?'] }, { role: 'owner' }),
    ).rejects.toThrow("`questions` is only for mode 'ask'");
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('mcp: place_call with the agent key (owner approval)', () => {
  const agent = { role: 'agent' as const };
  const input = { contactId: CONTACT_ID, taskDescription: 'Book a trim' };
  const originalHost = config.PUBLIC_HOSTNAME;
  beforeEach(() => {
    vi.clearAllMocks();
    checkCallCap.mockReset();
    checkCallCap.mockResolvedValue({ allowed: true, placed: 0, queued: 0, limit: 3 });
    config.PUBLIC_HOSTNAME = 'banjo.example.com';
  });
  afterEach(() => {
    config.PUBLIC_HOSTNAME = originalHost;
  });

  it('creates a task that waits 30 minutes for approval, sends one approval message, and does not dial', async () => {
    const before = Date.now();
    const result = await placeCallHandler(input, agent);
    const created = (createTask.mock.calls.at(-1) as unknown as [{ approvalExpiresAt: Date }])[0];
    expect(created.approvalExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(created.approvalExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(triggerOrchestration).not.toHaveBeenCalled();
    expect(sendOwnerMessage).toHaveBeenCalledTimes(1);
    expect((sendOwnerMessage.mock.calls[0] as unknown as [string])[0]).toContain('/approve/task-1?sig=');
    expect(addressBookNameFor).toHaveBeenCalled();
    expect(result.ackMessage).toMatch(/approve/i);
    expect(JSON.stringify(result)).not.toContain('sig=');
  });

  it("counts other requests still waiting for approval toward the cap, which the owner's own calls don't", async () => {
    await placeCallHandler(input, agent);
    expect(checkCallCap).toHaveBeenCalledWith(CONTACT_ID, expect.any(Date), { includeQueued: true, includeAwaitingApproval: true, limit: 3 });
  });

  it('checks the waiting limit and creates the task inside one lock, so simultaneous requests cannot all pass', async () => {
    lockLog.length = 0;
    countOpenApprovalRequests.mockImplementationOnce(async () => {
      lockLog.push('count');
      return 0;
    });
    createTask.mockImplementationOnce(async (input: Record<string, unknown>) => {
      lockLog.push('create');
      return { id: 'task-1', goalDescription: input.goalDescription, mode: 'booking', questions: null, scheduledFor: null, approvalExpiresAt: input.approvalExpiresAt ?? null, requestedByAgent: true, screenFlag: null };
    });
    await placeCallHandler(input, agent);
    expect(lockLog).toEqual(['lock', 'count', 'create', 'unlock']);
  });

  it('refuses once 3 requests are already waiting, before creating anything', async () => {
    countOpenApprovalRequests.mockResolvedValueOnce(3);
    await expect(placeCallHandler(input, agent)).rejects.toThrow(/already waiting/);
    expect(createTask).not.toHaveBeenCalled();
    expect(sendOwnerMessage).not.toHaveBeenCalled();
  });

  it('cancels the task when the owner could not be reached', async () => {
    sendOwnerMessage.mockResolvedValueOnce(false);
    await expect(placeCallHandler(input, agent)).rejects.toThrow(/Couldn't reach the owner/);
    expect(cancelPendingTask).toHaveBeenCalledWith('task-1');
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });

  it('refuses overrideCallCap, even for family', async () => {
    getContact.mockResolvedValueOnce({ id: CONTACT_ID, displayName: 'Mom', phoneNumber: '+15550002222', relationshipTier: 'family' });
    await expect(placeCallHandler({ ...input, overrideCallCap: true }, agent)).rejects.toThrow(/owner's own key/);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('still applies the call cap', async () => {
    checkCallCap.mockResolvedValueOnce({ allowed: false, placed: 3, queued: 0, limit: 3 });
    await expect(placeCallHandler(input, agent)).rejects.toThrow(/Call limit reached/);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('refuses an unknown contact without asking the owner', async () => {
    getContact.mockResolvedValueOnce(undefined);
    await expect(placeCallHandler(input, agent)).rejects.toThrow(/Contact not found/);
    expect(sendOwnerMessage).not.toHaveBeenCalled();
  });
});

describe('mcp: place_call with the owner key', () => {
  const input = { contactId: CONTACT_ID, taskDescription: 'Test call' };
  beforeEach(() => {
    vi.clearAllMocks();
    checkCallCap.mockReset();
    checkCallCap.mockResolvedValue({ allowed: true, placed: 0, queued: 0, limit: 3 });
  });

  it('dials with no approval step, as before', async () => {
    await placeCallHandler(input, { role: 'owner' });
    expect((createTask.mock.calls.at(-1) as unknown as [{ approvalExpiresAt?: Date }])[0].approvalExpiresAt).toBeUndefined();
    expect(triggerOrchestration).toHaveBeenCalledWith('task-1');
    expect(sendOwnerMessage).not.toHaveBeenCalled();
  });

  it('overrides the cap for family, up to twice it', async () => {
    getContact.mockResolvedValueOnce({ id: CONTACT_ID, displayName: 'Mom', phoneNumber: '+15550002222', relationshipTier: 'family' });
    const result = await placeCallHandler({ ...input, overrideCallCap: true }, { role: 'owner' });
    expect(checkCallCap).toHaveBeenCalledWith(CONTACT_ID, expect.any(Date), { includeQueued: true, includeAwaitingApproval: false, limit: 6 });
    expect((createTask.mock.calls.at(-1) as unknown as [{ callCapOverride?: boolean }])[0].callCapOverride).toBe(true);
    expect(result.ackMessage).toMatch(/call cap overridden/i);
  });

  it("overrides the cap for the owner's own number", async () => {
    getContact.mockResolvedValueOnce({ id: CONTACT_ID, displayName: 'Me', phoneNumber: config.NOTIFY_TO_PHONE_NUMBER!, relationshipTier: null });
    await placeCallHandler({ ...input, overrideCallCap: true }, { role: 'owner' });
    expect(checkCallCap).toHaveBeenCalledWith(CONTACT_ID, expect.any(Date), { includeQueued: true, includeAwaitingApproval: false, limit: 6 });
  });

  it('refuses the override for anyone but the owner or family', async () => {
    await expect(placeCallHandler({ ...input, overrideCallCap: true }, { role: 'owner' })).rejects.toThrow(/only be overridden for the owner or family/);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('stops at the ceiling even with the override', async () => {
    getContact.mockResolvedValueOnce({ id: CONTACT_ID, displayName: 'Mom', phoneNumber: '+15550002222', relationshipTier: 'family' });
    checkCallCap.mockResolvedValueOnce({ allowed: false, placed: 6, queued: 0, limit: 6 });
    await expect(placeCallHandler({ ...input, overrideCallCap: true }, { role: 'owner' })).rejects.toThrow(/max 6/);
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('mcp: place_call with call screening (#150)', () => {
  const input = { contactId: CONTACT_ID, taskDescription: 'Book a groom' };
  const flagged = { held: true as const, kind: 'flagged' as const, reason: "Banjo's screening flagged it: It asks for a one-time code." };
  beforeEach(() => {
    vi.clearAllMocks();
    config.SCREEN_CALLS = true;
    config.PUBLIC_HOSTNAME = 'banjo.example.com';
  });
  afterEach(() => {
    config.SCREEN_CALLS = false;
  });

  it('screens nothing when SCREEN_CALLS is off', async () => {
    config.SCREEN_CALLS = false;
    await placeCallHandler(input, { role: 'owner' });
    expect(screenCall).not.toHaveBeenCalled();
    expect(triggerOrchestration).toHaveBeenCalledWith('task-1');
  });

  it("places an owner's request that passes, as before", async () => {
    await placeCallHandler(input, { role: 'owner' });
    expect(screenCall).toHaveBeenCalledWith(expect.objectContaining({ id: CONTACT_ID }), { mode: 'booking', goal: 'Book a groom', questions: undefined, notes: undefined });
    expect(createTask).toHaveBeenCalledWith(expect.not.objectContaining({ approvalExpiresAt: expect.anything() }));
    expect(triggerOrchestration).toHaveBeenCalledWith('task-1');
  });

  it("holds an owner's flagged request for approval, with the reason, and doesn't dial", async () => {
    screenCall.mockResolvedValueOnce(flagged);
    const result = await placeCallHandler(input, { role: 'owner' });

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ approvalExpiresAt: expect.any(Date), screenFlag: flagged.reason }));
    expect(createTask).toHaveBeenCalledWith(expect.not.objectContaining({ requestedByAgent: true }));
    expect(triggerOrchestration).not.toHaveBeenCalled();
    const [message] = sendOwnerMessage.mock.calls[0]! as unknown as [string];
    expect(message).toMatch(/^Banjo was asked, with your own key, to call/);
    expect(message).toContain(`Held by call screening: ${flagged.reason}`);
    expect(result.ackMessage).toMatch(/held it for the owner's approval/);
  });

  it("tells an agent its request was held by screening, but not the model's words", async () => {
    screenCall.mockResolvedValueOnce(flagged);
    const result = await placeCallHandler(input, { role: 'agent' });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ requestedByAgent: true, screenFlag: flagged.reason }));
    expect(result.ackMessage).toMatch(/Call screening flagged this request/);
    expect(result.ackMessage).not.toContain('one-time code');
  });

  it('cancels a held request when the owner cannot be reached', async () => {
    screenCall.mockResolvedValueOnce({ held: true, kind: 'check_failed', reason: "Banjo's screening check couldn't run on this request." });
    sendOwnerMessage.mockResolvedValueOnce(false);
    await expect(placeCallHandler(input, { role: 'owner' })).rejects.toThrow(/Couldn't reach the owner/);
    expect(cancelPendingTask).toHaveBeenCalledWith('task-1');
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });
});
