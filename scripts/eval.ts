#!/usr/bin/env -S npx tsx
/**
 * Live scenario evals (#188): each scenario in evals/scenarios, k times,
 * against the real OpenAI model through the text-mode sim. Prints each
 * scenario's pass rate, rescues, cost and time, flags anything worse than the
 * baseline, and saves every run under evals/results/<time>/. Warn only: exits 0
 * whenever the suite ran, failed checks or not.
 *
 * Needs OPENAI_API_KEY and Postgres (docker compose up -d postgres), like
 * `npm run sim`. Costs money: see the summary's total.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { callerBase, gitSha } from '../src/evals/caller.js';
import { EVAL_FIXED_ENV } from '../src/evals/env.js';
import { loadScenarios, type Scenario } from '../src/evals/scenario.js';
import { compareToBaseline, formatSummary, readBaseline, saveBaseline, summarize, type RunResult } from '../src/evals/summary.js';
import { ensureSimDatabase } from '../src/sim/db.js';
import { simDatabaseUrl } from '../src/sim/env.js';

const USAGE = `Usage: npm run eval -- [options]

Runs the scenario evals live against OpenAI (costs money), through the
text-mode simulator. Nothing real is called, booked or sent.

Options:
  --scenario <id>    Run only this scenario. Repeat for more than one.
  --runs <k>         Runs per scenario. Default: 3.
  --record           Save a passing run as the scenario's recording (evals/recordings/),
                     which npm test replays.
  --save-baseline    Save this run's results as the baseline (evals/baseline.json) that
                     later runs are compared with. Not from a run stopped early.
  --verbose          Show each run's call as it happens.
  --spoken           Banjo's replies are spoken (audio out, checked by their transcript), as on
                     a call; the other party still types. Costs more: audio output is priced
                     higher than the text rate the cost column uses.
  -h, --help         Show this.`;

const RECORDINGS_DIR = 'evals/recordings';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', multiple: true },
      runs: { type: 'string', default: '3' },
      record: { type: 'boolean', default: false },
      'save-baseline': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      spoken: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const k = Number.parseInt(values.runs, 10);
  if (!Number.isInteger(k) || k < 1 || k > 20) fail(`--runs must be a whole number from 1 to 20 (got "${values.runs}").`);

  const base = callerBase();
  if (!base.OPENAI_API_KEY) fail('OPENAI_API_KEY is not set. Add it to .env or the environment: live evals talk to OpenAI Realtime.');
  await ensureSimDatabase(simDatabaseUrl(base.DATABASE_URL)).catch((err: Error) => fail(err.message));

  let scenarios: Scenario[];
  try {
    scenarios = loadScenarios();
  } catch (err) {
    fail((err as Error).message);
  }
  if (values.scenario) {
    const unknown = values.scenario.filter((id) => !scenarios.some((s) => s.id === id));
    if (unknown.length) fail(`no such scenario: ${unknown.join(', ')}. Known: ${scenarios.map((s) => s.id).join(', ')}`);
    scenarios = scenarios.filter((s) => values.scenario!.includes(s.id));
  }
  if (!scenarios.length) fail('no scenarios in evals/scenarios.');

  const startedAt = new Date();
  const dir = join('evals', 'results', startedAt.toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  console.log(`Running ${scenarios.length} scenario(s) × ${k} against ${EVAL_FIXED_ENV.OPENAI_REALTIME_MODEL}. Results: ${dir}\n`);

  const results: RunResult[] = [];
  let current: ChildProcess | undefined;
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    current?.kill('SIGTERM');
  });

  outer: for (const scenario of scenarios) {
    for (let n = 1; n <= k; n++) {
      if (stopped) break outer;
      const out = join(dir, `${scenario.id}-${n}.json`);
      const args = ['tsx', 'scripts/eval-run.ts', '--scenario', scenario.path, '--out', out, '--run', String(n)];
      if (values.record) args.push('--record', RECORDINGS_DIR);
      if (values.verbose) args.push('--verbose');
      if (values.spoken) args.push('--spoken');
      const started = Date.now();
      const log = createWriteStream(join(dir, `${scenario.id}-${n}.log`));
      const child = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      current = child;
      child.stdout!.on('data', (chunk) => {
        log.write(chunk);
        if (values.verbose) process.stdout.write(chunk);
      });
      child.stderr!.pipe(log);
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      current = undefined;
      log.end();
      if (stopped) break outer;
      const result = existsSync(out) && code === 0 ? (JSON.parse(readFileSync(out, 'utf8')) as RunResult) : errored(scenario.id, n, started, code, dir);
      results.push(result);
      console.log(`${scenario.id} ${n}/${k}: ${describe(result)}`);
    }
  }

  const fingerprints = [...new Set(results.map((r) => r.fingerprint).filter(Boolean))].sort();
  const summary = summarize(results, {
    startedAt: startedAt.toISOString(),
    gitSha: gitSha(),
    model: EVAL_FIXED_ENV.OPENAI_REALTIME_MODEL!,
    fingerprint: createHash('sha256').update(fingerprints.join('\n')).digest('hex'),
    k,
    partial: stopped,
  });
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const flags = compareToBaseline(summary, readBaseline());
  console.log(`\n${formatSummary(summary, flags)}`);
  for (const r of results.filter((r) => !r.pass)) {
    const failed = r.error ? r.error : r.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.reason ?? 'failed'}`).join('; ');
    console.log(`  ✗ ${r.scenarioId} #${r.run}: ${failed}`);
  }
  if (values['save-baseline']) {
    if (summary.partial) console.log('\nNot saving the baseline: the run was stopped early.');
    else {
      saveBaseline(summary);
      console.log('\nSaved the baseline: evals/baseline.json.');
    }
  }
  process.exit(stopped ? 130 : 0);
}

function errored(scenarioId: string, run: number, started: number, code: number | null, dir: string): RunResult {
  return {
    scenarioId,
    run,
    checks: [],
    pass: false,
    rescues: [],
    status: 'error',
    durationMs: Date.now() - started,
    costUsd: null,
    transcript: [],
    toolCalls: [],
    error: `the run exited ${code ?? 'on a signal'}: see ${join(dir, `${scenarioId}-${run}.log`)}`,
  };
}

function describe(r: RunResult): string {
  if (r.error) return `error (${r.error})`;
  const passed = r.checks.filter((c) => c.pass).length;
  const rescues = r.rescues.length ? `, ${r.rescues.length} rescue(s)` : '';
  const cost = r.costUsd === null ? '' : `, $${r.costUsd.toFixed(3)}`;
  return `${r.pass ? 'pass' : 'FAIL'} (${passed}/${r.checks.length} checks, ${r.status}${rescues}${cost}, ${Math.round(r.durationMs / 1000)}s)`;
}

function fail(message: string): never {
  console.error(`eval: ${message}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('eval failed:', err);
  process.exit(1);
});
