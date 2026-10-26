import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listRecentTasks } = vi.hoisted(() => ({ listRecentTasks: vi.fn() }));
vi.mock('../../../src/tasks/service.js', () => ({ listRecentTasks }));

const { listRecentTasksHandler } = await import('../../../src/mcp/tools/listRecentTasks.js');

// A week of half-hour slots, as the default lookahead stores for a call
// with no dateWindows (#120).
const WEEK_OF_SLOTS = Array.from({ length: 336 }, (_, i) => ({
  start: new Date(Date.UTC(2026, 9, 6) + i * 1_800_000).toISOString(),
  end: new Date(Date.UTC(2026, 9, 6) + (i + 1) * 1_800_000).toISOString(),
}));

const TASK = {
  id: '22222222-2222-2222-2222-222222222222',
  contactId: '33333333-3333-3333-3333-333333333333',
  channel: 'phone',
  mode: 'conversation',
  goalDescription: 'Thank her for the ticket.',
  constraints: {},
  status: 'voicemail_left',
  candidateWindows: WEEK_OF_SLOTS,
  outcome: { kind: 'voicemail_left', message: 'Thanks for the ticket. Bye!' },
  calendarEventId: null,
  scheduledFor: null,
  createdAt: new Date('2026-10-06T17:23:00Z'),
  updatedAt: new Date('2026-10-06T17:25:09Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mcp: list_recent_tasks', () => {
  it('leaves out candidateWindows and keeps everything else', async () => {
    listRecentTasks.mockResolvedValue([TASK]);
    const [summary] = await listRecentTasksHandler({});
    expect(summary).not.toHaveProperty('candidateWindows');
    const { candidateWindows: _omitted, ...rest } = TASK;
    expect(summary).toEqual(rest);
  });

  it("leaves out an ask task's saved answers, which get_task_status pairs with their questions (#148 review)", async () => {
    const askTask = {
      ...TASK,
      mode: 'ask',
      status: 'escalated',
      candidateWindows: [],
      questions: ['Open Sunday?', 'Walk-ins?'],
      collectedAnswers: { '1': { question: 1, answered: true, answer: 'No, closed Sundays.' } },
      outcome: { kind: 'escalated', reason: 'They asked for a card number.' },
    };
    listRecentTasks.mockResolvedValue([askTask]);
    const [summary] = await listRecentTasksHandler({});
    expect(summary).not.toHaveProperty('collectedAnswers');
    expect(summary).toMatchObject({ mode: 'ask', status: 'escalated', questions: ['Open Sunday?', 'Walk-ins?'] });
  });

  it("says screening held a call, without the screening model's words (#150)", async () => {
    listRecentTasks.mockResolvedValue([{ ...TASK, status: 'pending', screenFlag: "Banjo's screening flagged it: secret", approvalExpiresAt: new Date(), approvedAt: null }]);
    const [summary] = await listRecentTasksHandler({});
    expect(summary).not.toHaveProperty('screenFlag');
    expect(summary).toMatchObject({ heldByScreening: true, approval: 'waiting' });
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('asks for 20 tasks by default, or the limit given', async () => {
    listRecentTasks.mockResolvedValue([]);
    await listRecentTasksHandler({});
    expect(listRecentTasks).toHaveBeenLastCalledWith(20);
    await listRecentTasksHandler({ limit: 5 });
    expect(listRecentTasks).toHaveBeenLastCalledWith(5);
  });
});

describe('mcp: list_recent_tasks, approval of an agent\'s call', () => {
  it('adds approval only to tasks that needed it', async () => {
    listRecentTasks.mockResolvedValue([
      { ...TASK, approvalExpiresAt: null, approvedAt: null },
      { ...TASK, id: 'waiting', status: 'pending', approvalExpiresAt: new Date('2026-10-15T01:30:00Z'), approvedAt: null },
    ]);
    const [plain, waiting] = await listRecentTasksHandler({});
    expect(plain).not.toHaveProperty('approval');
    expect(waiting).toMatchObject({ approval: 'waiting' });
  });
});
