/**
 * Re-records README's simulator GIF (assets/sim-hold.gif): `npm run readme:gif`.
 * Run it after changing what the sim prints; nothing checks that the GIF is
 * current (it went two releases showing output the sim no longer printed).
 *
 * It plays scripts/readme-gif/hold.txt against the sim with stock settings
 * (no .env, so "Alex" and no owner profile), records the terminal with
 * asciinema and renders it with agg. Needs both on PATH (`brew install
 * asciinema agg`), Postgres running, and OPENAI_API_KEY in the environment or
 * .env. It is a real model run, so the wording differs each time: read the
 * transcript it prints, and open the GIF, before committing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

const SCRIPT = 'scripts/readme-gif/hold.txt';
const OUTPUT = 'assets/sim-hold.gif';
const SIM_ARGS = ['--business', 'Riverside Auto Care', '--category', 'other', '--goal', 'Book an oil change for my car.', '--script', SCRIPT];
/** What the GIF shows as the command: the flags that matter to a reader. */
const SHOWN_COMMAND = "$ npm run sim -- --business 'Riverside Auto Care' --goal 'Book an oil change for my car.' --script hold.txt";
const COLS = 112;
const ROWS = 30;

function fail(message: string): never {
  console.error(`readme:gif: ${message}`);
  process.exit(1);
}

for (const tool of ['asciinema', 'agg']) {
  if (spawnSync(tool, ['--version'], { stdio: 'ignore' }).error) fail(`${tool} is not installed. Install both with: brew install asciinema agg`);
}

// Only the key comes from .env. The sim itself is kept away from it (DOTENV_CONFIG_PATH), so the
// recording shows what a first-time visitor gets, not this machine's principal name or profile.
const fromFile = existsSync('.env') ? dotenv.parse(readFileSync('.env')) : {};
const apiKey = process.env.OPENAI_API_KEY || fromFile.OPENAI_API_KEY;
if (!apiKey) fail('OPENAI_API_KEY is not set in the environment or .env.');

const work = mkdtempSync(join(tmpdir(), 'banjo-readme-gif-'));
const raw = join(work, 'raw.cast');
const clean = join(work, 'clean.cast');
const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

console.log('Recording the call (about 30 seconds)...');
const rec = spawnSync('asciinema', ['rec', '--overwrite', '-q', '-c', `npx tsx scripts/sim.ts ${SIM_ARGS.map(quote).join(' ')}`, raw], {
  stdio: 'ignore',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_API_KEY: apiKey, DOTENV_CONFIG_PATH: '/dev/null' } as NodeJS.ProcessEnv,
});
if (rec.status !== 0 || !existsSync(raw)) fail('the recording failed. Run the sim by hand to see why: npm run sim -- --script ' + SCRIPT);

// asciinema's v3 format: a header line, then [seconds since the last event, kind, data].
const [headerLine, ...eventLines] = readFileSync(raw, 'utf8').trim().split('\n');
const header = JSON.parse(headerLine!) as Record<string, unknown>;
header.term = { cols: COLS, rows: ROWS }; // recorded without a terminal, it says 80x24
delete header.command;
const events = eventLines.map((line) => JSON.parse(line) as [number, string, string]).filter(([, kind]) => kind === 'o');
const shown = events.map(([t, kind, data]): [number, string, string] => [t, kind, data.replaceAll(SCRIPT, 'hold.txt')]);
const transcript = shown
  .map(([, , data]) => data)
  .join('')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, '')
  .trimEnd();
if (!transcript.includes('--- outcome ---')) fail(`the call did not reach an outcome. What was recorded:\n${transcript}`);
writeFileSync(clean, [JSON.stringify(header), JSON.stringify([0.3, 'o', `${SHOWN_COMMAND}\r\n`]), ...shown.map((e) => JSON.stringify(e))].join('\n') + '\n');

execFileSync('agg', ['--idle-time-limit', '3', '--font-size', '16', '--theme', 'monokai', '--last-frame-duration', '5', clean, OUTPUT], { stdio: 'ignore' });

console.log(transcript);
console.log(`\nWrote ${OUTPUT}. It is a new model run: read the call above and open the GIF before committing.`);
console.log("If the story changed (README's alt text: put on hold, waits, says it's an AI again, books an oil change), run it again.");
