#!/usr/bin/env -S npx tsx
/**
 * The text-mode simulator (ROADMAP 4.5): Banjo places a "call" and you type as
 * the business that answers. Everything runs for real — the place_call
 * handler, the orchestrator, the system prompt, the tools, CallSession, rows in
 * Postgres — except the phone line (src/sim/simTelephony.ts), the calendar
 * (src/sim/simCalendar.ts, in memory) and the voice transport (OpenAI Realtime
 * in text-only mode). No phone call is placed, nothing is booked, no one is
 * notified.
 *
 * Needs OPENAI_API_KEY (in .env or the environment) and Postgres:
 * `docker compose up -d postgres`. The sim uses its own `banjo_sim` database on
 * that server, creates and migrates it, and empties it at the start of every
 * run. It never touches the database DATABASE_URL names.
 *
 * Options: see USAGE below, or `npm run sim -- --help`.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { ensureSimDatabase, emptySimDatabase } from '../src/sim/db.js';
import { SIM_DATABASE, simEnv } from '../src/sim/env.js';
import { readScript, renderDates, runScript, type ScriptStep } from '../src/sim/script.js';
// Type-only, so erased: nothing here may load src/config before simEnv is applied.
import type { TextVoiceAIProvider } from '../src/sim/simCall.js';

const USAGE = `Usage: npm run sim -- [options]

Banjo calls a business and you type as whoever answers. No phone call is
placed, no real calendar is written, nobody is notified.

Options:
  --business <name>      Who Banjo is calling. Default: "Claudia's Dog Grooming".
  --category <string>    salon|medical|restaurant|home_services|other. Default: salon.
  --goal <string>        What the call is for. Default: book a grooming appointment.
  --mode <mode>          booking|conversation|ask. Default: booking.
  --question <text>      With --mode ask: something Banjo should find out, on one line.
                         Repeat for more than one (at most 5). Checked as place_call
                         checks them. Default goal for ask: find out a few things.
  --duration <minutes>   Appointment length to negotiate. Default: 60. Not used by --mode ask.
  --window-days <n>      How many days out Banjo may book. Default: 3. Not used by --mode ask.
  --transfer             Offer transfer_to_owner, as with TRANSFER_ENABLED=true.
  --warm                 Make it a warm transfer (TRANSFER_MODE=warm). Implies --transfer.
  --owner <answer>       With --warm: what the owner does. accept|decline|no-answer. Default: accept.
  --ask-owner <answer>   Offer ask_owner, as with ASK_OWNER_ENABLED=true. A question Banjo asks is
                         answered with <answer> a few seconds later; "none" never answers (Banjo is
                         told after 30 seconds).
  --script <file>        Read your lines from a file, one per line (# for comments). A line starting
                         with ~ plays 3 seconds after the one before it, without waiting for
                         Banjo: a phone menu or hold queue, which doesn't wait for anyone.
                         (silence N) says nothing for N seconds (1 to 120) once Banjo goes quiet.
                         {day+N} is said as the date N days from today ("Friday, October 30").
  --verbose              Show the app's info-level logs.
  -h, --help             Show this.

While the call runs: type a line and press Enter to say it. /hangup hangs up
on Banjo; Ctrl+C does the same.`;

const DEFAULT_BOOKING_GOAL = 'Book a full grooming appointment for my dog, Banjo, a golden retriever.';
const DEFAULT_QUESTIONS = ['What time do you close on Saturdays?', 'How much is a full groom for a golden retriever?'];
const OWNER_ANSWERS = { accept: 'accepted', decline: 'declined', 'no-answer': 'no_answer' } as const;

const CATEGORIES = ['salon', 'medical', 'restaurant', 'home_services', 'other'] as const;
type Category = (typeof CATEGORIES)[number];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      business: { type: 'string', default: "Claudia's Dog Grooming" },
      category: { type: 'string', default: 'salon' },
      goal: { type: 'string' },
      question: { type: 'string', multiple: true },
      mode: { type: 'string', default: 'booking' },
      duration: { type: 'string', default: '60' },
      'window-days': { type: 'string', default: '3' },
      transfer: { type: 'boolean', default: false },
      warm: { type: 'boolean', default: false },
      owner: { type: 'string', default: 'accept' },
      'ask-owner': { type: 'string' },
      script: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const mode = values.mode;
  if (mode !== 'booking' && mode !== 'conversation' && mode !== 'ask') fail(`--mode must be "booking", "conversation" or "ask" (got "${mode}").`);
  if (mode !== 'ask' && values.question) fail('--question is only for --mode ask.');
  const questions = mode === 'ask' ? (values.question ?? DEFAULT_QUESTIONS) : undefined;
  const goal = values.goal ?? (mode === 'ask' ? 'Find out a few things before booking a grooming.' : DEFAULT_BOOKING_GOAL);
  const category = values.category as Category;
  if (!CATEGORIES.includes(category)) fail(`--category must be one of ${CATEGORIES.join(', ')} (got "${values.category}").`);
  const durationMinutes = positiveInt(values.duration, '--duration');
  const windowDays = positiveInt(values['window-days'], '--window-days');
  const scriptLines = values.script ? loadScript(values.script) : undefined;

  // .env first, then the sim's own values over it: config reads process.env at
  // import, and dotenv never overwrites what is already set.
  dotenv.config({ path: process.env.DOTENV_CONFIG_PATH, quiet: true });
  const owner = OWNER_ANSWERS[values.owner as keyof typeof OWNER_ANSWERS];
  if (!owner) fail(`--owner must be accept, decline or no-answer (got "${values.owner}").`);
  const transfer = values.transfer || values.warm;
  const askOwner = values['ask-owner'];
  Object.assign(process.env, simEnv(process.env, { transfer, warm: values.warm, askOwner: askOwner !== undefined, verbose: values.verbose }));
  if (!process.env.OPENAI_API_KEY) fail('OPENAI_API_KEY is not set. Add it to .env or the environment: the sim talks to OpenAI Realtime.');

  await ensureSimDatabase(process.env.DATABASE_URL!).catch((err: Error) => fail(err.message));
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  await emptySimDatabase().catch((err: Error) => fail(err.message));

  const { config } = await import('../src/config/index.js');
  const { OpenAIRealtimeProvider } = await import('../src/voice/providers/openai.js');
  const { startSimCall, SimInputError } = await import('../src/sim/simCall.js');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'You: ' });
  // Clears the half-typed "You: " line first, then redraws it, so Banjo's lines don't land mid-prompt.
  const interactive = !scriptLines && process.stdout.isTTY;
  const print = (line: string) => {
    if (interactive) process.stdout.write('\r\x1b[2K');
    console.log(line);
    if (interactive) rl.prompt(true);
  };

  console.log(`\nBanjo is calling ${values.business} for ${config.ASSISTANT_PRINCIPAL_NAME}.`);
  console.log(`Goal: ${goal}`);
  questions?.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  console.log(`You're answering the phone at ${values.business}. Nothing real is called, booked or sent.`);
  console.log(scriptLines ? `Reading your lines from ${values.script}.\n` : 'Type what you say and press Enter. /hangup hangs up.\n');

  const call = await startSimCall({
    business: values.business,
    category,
    goal,
    mode,
    questions,
    durationMinutes,
    windowDays,
    createVoiceAI: () => new OpenAIRealtimeProvider({ textOnly: true }),
    owner,
    ...(askOwner !== undefined && { ownerAnswer: askOwner === 'none' ? null : askOwner }),
    print,
  }).catch((err: unknown) => {
    if (err instanceof SimInputError) fail(`place_call would refuse this call: ${err.message}`);
    throw err;
  });
  process.on('SIGINT', () => call.telephony.calleeHangsUp());

  const voice = await call.ready;
  if (voice) {
    console.log('[The phone rings. You pick up.]');
    if (scriptLines) {
      void runScript(renderDates(scriptLines, new Date(), config.CALENDAR_TIMEZONE), voice, call.telephony, print);
    } else {
      rl.on('line', (line) => {
        const text = line.trim();
        if (text === '/hangup') call.telephony.calleeHangsUp();
        else if (text) voice.sendUserText(text);
        else rl.prompt();
      });
      rl.prompt();
    }
  }

  const task = await call.finished;
  rl.close();
  console.log('\n--- outcome ---');
  console.log(`Task status: ${task.status}`);
  console.log(JSON.stringify(task.outcome, null, 2));
  console.log(call.calendar.events.length ? `Calendar (dry run): ${call.calendar.events.map((e) => e.summary).join('; ')}` : 'Calendar: nothing booked.');
  console.log(`The transcript and task are in the ${SIM_DATABASE} database until the next run.`);
  process.exit(0);
}

/** The --script file's steps, or a clear failure: no lines, or a malformed (silence N). */
function loadScript(path: string): ScriptStep[] {
  let steps: ScriptStep[];
  try {
    steps = readScript(path);
  } catch (err) {
    fail(`--script ${path}: ${(err as Error).message}`);
  }
  if (!steps.length) fail(`--script ${path} has no lines.`);
  return steps;
}

function positiveInt(value: string | undefined, flag: string): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(n) || n <= 0) fail(`${flag} must be a positive whole number (got "${value}").`);
  return n;
}

function fail(message: string): never {
  console.error(`sim: ${message}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('sim failed:', err);
  process.exit(1);
});
