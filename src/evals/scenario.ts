/**
 * A scenario file (evals/scenarios/<id>.yaml, #188): a task, the other
 * party's script, and what the call must come to. Loaded strictly: a
 * misspelled key, tool or status fails with the file and path named, so a
 * typo can't pass by running no check at all.
 *
 * Imports nothing that loads src/config: the eval orchestrator reads scenarios
 * before any run's environment exists. So the tool names and statuses are
 * listed here, and a test holds them to the real ones.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { parseScriptLines, type ScriptStep } from '../sim/script.js';
import type { ScenarioFlags } from './env.js';

export const KNOWN_TOOL_NAMES = [
  'check_my_availability',
  'confirm_appointment',
  'undo_confirmed_appointment',
  'leave_voicemail_and_end_call',
  'report_negotiation_failed',
  'escalate_and_end_call',
  'end_call',
  'end_conversation_call',
  'record_answer',
  'note_follow_up',
  'report_answers_and_end_call',
  'wait_on_hold',
  'press_digits',
  'transfer_to_owner',
  'ask_owner',
] as const;

export const KNOWN_TASK_STATUSES = [
  'pending',
  'checking_availability',
  'calling',
  'negotiating',
  'confirmed',
  'voicemail_left',
  'negotiation_failed',
  'escalated',
  'conversation_completed',
  'transferred',
  'answered',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof KNOWN_TASK_STATUSES)[number];

export const UNIVERSAL_CHECKS = ['disclosure_first', 'disclosure_once', 'goodbye_before_end'] as const;
export type UniversalCheckName = (typeof UNIVERSAL_CHECKS)[number];

const toolExpectation = z
  .object({
    name: z.enum(KNOWN_TOOL_NAMES),
    argsInclude: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

const scenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    source: z.string().min(1),
    task: z
      .object({
        business: z.string().min(1),
        category: z.enum(['salon', 'medical', 'restaurant', 'home_services', 'other']),
        goal: z.string().min(1),
        mode: z.enum(['booking', 'conversation', 'ask']),
        questions: z.array(z.string().min(1)).optional(),
        durationMinutes: z.number().int().positive().default(60),
        windowDays: z.number().int().positive().default(3),
        relationshipTier: z.enum(['family', 'friend']).optional(),
      })
      .strict(),
    flags: z
      .object({
        transfer: z.boolean().default(false),
        warm: z.boolean().default(false),
        owner: z.enum(['accept', 'decline', 'no-answer']).default('accept'),
        askOwner: z.string().nullable().optional(),
      })
      .strict()
      .prefault({}),
    env: z.record(z.string(), z.string()).optional(),
    script: z.array(z.string().min(1)).min(1),
    expect: z
      .object({
        status: z.array(z.enum(KNOWN_TASK_STATUSES)).min(1),
        toolsCalled: z.array(toolExpectation).optional(),
        /** With argsInclude: never called with those args. Without: never called. */
        toolsNotCalled: z.array(toolExpectation).optional(),
        /** The one booked start: windowStart's local date plus dayOffset days, at time (HH:MM), in CALENDAR_TIMEZONE. */
        bookedLocal: z
          .object({ dayOffset: z.number().int().min(0), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })
          .strict()
          .optional(),
        traceableNumbers: z.boolean().optional(),
        neverSays: z.array(z.string().min(1)).optional(),
        goodbyeWithinTurnsAfter: z.object({ userLineIncludes: z.string().min(1), turns: z.number().int().positive() }).strict().optional(),
        /**
         * Lines of theirs the call must get to: so a call that ends early can't pass vacuously. Optionally before Banjo
         * first acts on a tool (for a voicemail, speaks its message), or, with quietBefore, before Banjo says anything (#207).
         */
        reaches: z
          .array(
            z
              .object({ userLineIncludes: z.string().min(1), beforeTool: z.enum(KNOWN_TOOL_NAMES).optional(), quietBefore: z.boolean().optional() })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    skipUniversal: z.array(z.object({ check: z.enum(UNIVERSAL_CHECKS), reason: z.string().min(1) }).strict()).optional(),
  })
  .strict();

type ScenarioFile = z.infer<typeof scenarioSchema>;

export type ToolExpectation = z.infer<typeof toolExpectation>;
export type Expectations = ScenarioFile['expect'];

export interface Scenario extends Omit<ScenarioFile, 'script' | 'flags'> {
  /** Where the file was loaded from. */
  path: string;
  flags: ScenarioFlags;
  script: ScriptStep[];
}

export function loadScenario(path: string): Scenario {
  const fail = (message: string): never => {
    throw new Error(`${path}: ${message}`);
  };
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`not valid YAML (${(err as Error).message})`);
  }
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    fail(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; '));
  }
  const file = parsed.data!;
  const name = basename(path).replace(/\.ya?ml$/, '');
  if (file.id !== name) fail(`id "${file.id}" must match the file name "${name}"`);
  if (file.task.mode === 'ask' && !file.task.questions?.length) fail('task.questions: an ask scenario needs at least one question');
  let script: ScriptStep[] = [];
  try {
    script = parseScriptLines(file.script);
  } catch (err) {
    fail(`script: ${(err as Error).message}`);
  }
  return { ...file, path, script };
}

/** Every scenario in a directory, sorted by id. */
export function loadScenarios(dir = 'evals/scenarios'): Scenario[] {
  const scenarios = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => loadScenario(join(dir, f)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>();
  for (const s of scenarios) {
    if (seen.has(s.id)) throw new Error(`${s.path}: duplicate scenario id "${s.id}"`);
    seen.add(s.id);
  }
  return scenarios;
}
