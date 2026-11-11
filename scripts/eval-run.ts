#!/usr/bin/env -S npx tsx
/**
 * One live eval run (#188), in a process of its own: config is read once per
 * process, and each scenario needs its own (transfer, ask_owner). Started by
 * scripts/eval.ts; runnable alone to debug one scenario.
 *
 *   npx tsx scripts/eval-run.ts --scenario evals/scenarios/<id>.yaml --out <file.json> [--run N] [--record <dir>] [--verbose]
 *
 * The environment is the evals' fixed one (src/evals/env.ts): everything else
 * in the caller's environment is dropped, and .env is read only for
 * OPENAI_API_KEY and DATABASE_URL, so no real name or profile reaches the
 * prompt. Writes a RunResult to --out; with --record, a recording too, if
 * every check passed. Exits 0 whether or not checks passed, 1 only if the run
 * couldn't happen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { callerBase, gitSha } from '../src/evals/caller.js';
import { evalEnv, OWNER_ANSWERS } from '../src/evals/env.js';
import { loadScenario } from '../src/evals/scenario.js';
import type { RunResult } from '../src/evals/summary.js';
import { ensureSimDatabase, emptySimDatabase } from '../src/sim/db.js';

/** Kept from the caller's environment: what the process itself needs, nothing the app reads. */
const KEEP = new Set(['PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER', 'LANG', 'TERM']);
/** A run that hasn't ended by then is hung up on; one that still hasn't, 30s later, failed. */
const RUN_LIMIT_MS = 8 * 60_000;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
      out: { type: 'string' },
      run: { type: 'string', default: '1' },
      record: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      spoken: { type: 'boolean', default: false },
    },
  });
  if (!values.scenario || !values.out) fail('--scenario and --out are required.');
  const scenario = loadScenario(values.scenario);
  const base = callerBase();
  if (!base.OPENAI_API_KEY) fail('OPENAI_API_KEY is not set. Add it to .env or the environment: live evals talk to OpenAI Realtime.');

  for (const key of Object.keys(process.env)) if (!KEEP.has(key)) delete process.env[key];
  // DOTENV_CONFIG_PATH: config's `import 'dotenv/config'` must not fill in the rest of .env.
  Object.assign(process.env, evalEnv(base, { ...scenario.flags, env: scenario.env }), { DOTENV_CONFIG_PATH: '/dev/null' });

  await ensureSimDatabase(process.env.DATABASE_URL!);
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  await emptySimDatabase();

  const { config } = await import('../src/config/index.js');
  const { OpenAIRealtimeProvider } = await import('../src/voice/providers/openai.js');
  const { startSimCall } = await import('../src/sim/simCall.js');
  const { renderDates, runScript } = await import('../src/sim/script.js');
  const { RecordingVoiceAI } = await import('../src/evals/recorder.js');
  const { buildRunRecord } = await import('../src/evals/runRecord.js');
  const { runChecks } = await import('../src/evals/checks.js');
  const { estimateCost } = await import('../src/evals/cost.js');
  const { fingerprint, scenarioHash, writeRecording } = await import('../src/evals/recording.js');

  const print = values.verbose ? (line: string) => console.log(line) : () => {};
  const windowStart = new Date();
  let recorder: InstanceType<typeof RecordingVoiceAI> | undefined;
  const call = await startSimCall({
    business: scenario.task.business,
    category: scenario.task.category,
    goal: scenario.task.goal,
    mode: scenario.task.mode,
    questions: scenario.task.questions,
    durationMinutes: scenario.task.durationMinutes,
    windowDays: scenario.task.windowDays,
    windowStart,
    relationshipTier: scenario.task.relationshipTier,
    owner: OWNER_ANSWERS[scenario.flags.owner],
    ...(scenario.flags.askOwner !== undefined && { ownerAnswer: scenario.flags.askOwner }),
    createVoiceAI: () => (recorder = new RecordingVoiceAI(new OpenAIRealtimeProvider({ textOnly: true, spokenReplies: values.spoken }))),
    print,
  });

  // The other party's hang-up isn't a voice call, so it's logged here, for a replay to play back.
  const hangUp = call.telephony.calleeHangsUp.bind(call.telephony);
  call.telephony.calleeHangsUp = () => {
    recorder?.noteCalleeHangsUp();
    hangUp();
  };
  const voice = await call.ready;
  if (voice) void runScript(renderDates(scenario.script, windowStart, config.CALENDAR_TIMEZONE), voice, call.telephony, print);
  const limit = setTimeout(() => {
    print('[Eval run limit reached: hanging up.]');
    call.telephony.calleeHangsUp();
  }, RUN_LIMIT_MS);
  const task = await Promise.race([
    call.finished,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the call never finished')), RUN_LIMIT_MS + 30_000).unref()),
  ]);
  clearTimeout(limit);
  if (!recorder) throw new Error('the voice session was never created');

  const record = buildRunRecord(
    recorder.log,
    { status: task.status, outcome: task.outcome, collectedAnswers: task.collectedAnswers },
    call.calendar.events,
    config.CALENDAR_TIMEZONE,
    windowStart.toISOString(),
  );
  const checks = runChecks(record, scenario);
  const usage = recorder.usageTotals?.();
  const connect = recorder.log.find((e) => e.dir === 'in' && e.call === 'connect');
  const result: RunResult = {
    scenarioId: scenario.id,
    run: Number(values.run),
    checks,
    pass: checks.every((c) => c.pass),
    rescues: record.rescues,
    status: task.status,
    durationMs: Date.now() - windowStart.getTime(),
    ...(usage && { usage }),
    costUsd: usage ? estimateCost(config.OPENAI_REALTIME_MODEL, usage) : null,
    transcript: record.lines,
    toolCalls: record.toolCalls,
    ...(connect && connect.dir === 'in' && connect.call === 'connect' && { fingerprint: fingerprint(connect.config) }),
  };
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);

  if (values.record && result.pass && result.fingerprint) {
    writeRecording(values.record, {
      version: 1,
      scenarioId: scenario.id,
      scenarioHash: scenarioHash(values.scenario),
      fingerprint: result.fingerprint,
      recordedAt: windowStart.toISOString(),
      windowStart: windowStart.toISOString(),
      gitSha: gitSha(),
      model: config.OPENAI_REALTIME_MODEL,
      log: recorder.log,
    });
  }
  process.exit(0);
}

function fail(message: string): never {
  console.error(`eval: ${message}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('eval run failed:', err);
  process.exit(1);
});
