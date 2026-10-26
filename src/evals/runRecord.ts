/**
 * What an eval run's checks grade (#188): the call as the other party had it
 * (the lines, the tools Banjo used and what came back), how it ended, and the
 * rescues it took. Built from the boundary log plus the task row and the sim
 * calendar, so a live run and its replay are graded the same way.
 */
import type { CollectedAnswer } from '../tasks/schema.js';
import type { AnswerVerdict } from '../voice/types.js';
import type { LogEntry } from './recorder.js';
import { findRescues, type Rescue } from './rescues.js';
import type { TaskStatus } from './scenario.js';

export interface RunRecord {
  lines: { role: 'user' | 'assistant'; text: string; t: number }[];
  /** `spokenAt`: for a tool whose message is said word for word (a voicemail), when that speech began (#198). */
  toolCalls: { name: string; args: Record<string, unknown>; result?: unknown; isError?: boolean; t: number; spokenAt?: number }[];
  /** How many times a live person picked up after a hold: each allows one more opener. */
  holdPickups: number;
  rescues: Rescue[];
  status: TaskStatus;
  outcome: unknown;
  /** Answers record_answer saved mid-call, which an ask call that ends early has instead of an outcome's. */
  collectedAnswers: Record<string, CollectedAnswer> | null;
  bookedStarts: string[];
  /** Each verdict the first-line judge gave, in order (#187): the last is what the call recorded. */
  answeredBy: AnswerVerdict[];
  timeZone: string;
  windowStart: string;
}

// personPickedUpNote's fixed opening: the note CallSession adds when a person picks up after a hold.
const PICKED_UP_PREFIX = 'You were waiting on hold, and a live person has just picked up;';

export function buildRunRecord(
  log: LogEntry[],
  task: { status: TaskStatus; outcome: unknown; collectedAnswers?: Record<string, CollectedAnswer> | null },
  calendarEvents: { startMs: number }[],
  timeZone: string,
  windowStart: string,
): RunRecord {
  const lines: RunRecord['lines'] = [];
  const toolCalls: RunRecord['toolCalls'] = [];
  const byId = new Map<string, RunRecord['toolCalls'][number]>();
  let holdPickups = 0;
  const answeredBy: AnswerVerdict[] = [];
  for (const entry of log) {
    if (entry.dir === 'out') {
      const { event } = entry;
      if (event.type === 'transcript' && event.isFinal && event.text.trim()) {
        lines.push({ role: event.role, text: event.text.trim(), t: entry.t });
      } else if (event.type === 'tool_call') {
        const call = { name: event.call.name, args: event.call.arguments, t: entry.t };
        toolCalls.push(call);
        byId.set(event.call.id, call);
      }
    } else if (entry.call === 'sayVerbatim') {
      // Forced speech belongs to the tool call it follows: a voicemail's message, or a fixed goodbye before an ending.
      const last = toolCalls.at(-1);
      if (last && last.spokenAt === undefined) last.spokenAt = entry.t;
    } else if (entry.call === 'sendToolResult') {
      const call = byId.get(entry.toolCallId);
      if (call) Object.assign(call, { result: entry.result, ...(entry.isError && { isError: true }) });
    } else if (entry.call === 'judgeFirstLine') {
      answeredBy.push(entry.verdict);
    } else if (entry.call === 'addContext') {
      holdPickups += entry.items.filter((item) => item.role === 'system' && item.text.startsWith(PICKED_UP_PREFIX)).length;
    }
  }
  return {
    lines,
    toolCalls,
    holdPickups,
    rescues: findRescues(log),
    status: task.status,
    outcome: task.outcome,
    collectedAnswers: task.collectedAnswers ?? null,
    bookedStarts: calendarEvents.map((e) => new Date(e.startMs).toISOString()),
    answeredBy,
    timeZone,
    windowStart,
  };
}
