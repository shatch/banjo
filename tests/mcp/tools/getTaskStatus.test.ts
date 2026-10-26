import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTask } = vi.hoisted(() => ({ getTask: vi.fn() }));
vi.mock('../../../src/tasks/service.js', () => ({ getTask }));

const { getTaskStatusHandler } = await import('../../../src/mcp/tools/getTaskStatus.js');

const TASK_ID = '22222222-2222-2222-2222-222222222222';

function task(overrides: Record<string, unknown>) {
  return {
    id: TASK_ID,
    mode: 'booking',
    status: 'confirmed',
    outcome: null,
    questions: null,
    collectedAnswers: null,
    followUps: null,
    scheduledFor: null,
    updatedAt: new Date('2026-10-13T17:25:09Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mcp: get_task_status', () => {
  it("returns an ask task's answers saved during the call, with the question text, whatever it ended as (#148 review)", async () => {
    // A transfer, escalation, voicemail or hold limit keeps its own outcome,
    // so the answers gathered before it are only visible here.
    const outcome = { kind: 'escalated', reason: 'Waited on hold too long.', stuckAt: 'hold_limit' };
    getTask.mockResolvedValue(
      task({
        mode: 'ask',
        status: 'escalated',
        outcome,
        questions: ['Q1?', 'Q2?'],
        collectedAnswers: { '1': { question: 1, answered: true, answer: '6pm.' } },
      }),
    );

    const result = await getTaskStatusHandler({ taskId: TASK_ID });

    expect(result).toMatchObject({
      found: true,
      status: 'escalated',
      outcome,
      collectedAnswers: [
        { question: 'Q1?', answered: true, answer: '6pm.' },
        { question: 'Q2?', answered: false },
      ],
    });
  });

  it('returns every question unanswered for an ask task with nothing saved yet', async () => {
    getTask.mockResolvedValue(task({ mode: 'ask', status: 'negotiating', questions: ['Q1?'] }));
    expect(await getTaskStatusHandler({ taskId: TASK_ID })).toMatchObject({ collectedAnswers: [{ question: 'Q1?', answered: false }] });
  });

  it('leaves collectedAnswers out for a task that is not an ask', async () => {
    getTask.mockResolvedValue(task({}));
    expect(await getTaskStatusHandler({ taskId: TASK_ID })).not.toHaveProperty('collectedAnswers');
  });
});

describe('mcp: get_task_status, approval of an agent\'s call', () => {
  const expiresAt = new Date('2026-10-15T01:30:00Z');
  it('returns what the other party asked to have passed on, in any mode (#160)', async () => {
    getTask.mockResolvedValue(task({ mode: 'conversation', status: 'conversation_completed', followUps: ['Events in San Juan.'] }));
    expect(await getTaskStatusHandler({ taskId: TASK_ID })).toMatchObject({ followUps: ['Events in San Juan.'] });
  });

  it('leaves followUps out when there are none', async () => {
    getTask.mockResolvedValue(task({}));
    expect(await getTaskStatusHandler({ taskId: TASK_ID })).not.toHaveProperty('followUps');
  });

  it('leaves approval out of a call that never needed it', async () => {
    getTask.mockResolvedValue(task({ approvalExpiresAt: null, approvedAt: null }));
    expect(await getTaskStatusHandler({ taskId: TASK_ID })).not.toHaveProperty('approval');
  });
  it.each([
    ['waiting', { status: 'pending', approvedAt: null }],
    ['approved', { status: 'calling', approvedAt: new Date() }],
    ['not_approved', { status: 'cancelled', approvedAt: null }],
  ])('reports %s', async (state, fields) => {
    getTask.mockResolvedValue(task({ approvalExpiresAt: expiresAt, ...fields }));
    expect(await getTaskStatusHandler({ taskId: TASK_ID })).toMatchObject({ approval: state });
  });
});
