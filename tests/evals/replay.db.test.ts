import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextVoiceAIProvider } from '../../src/sim/simCall.js';
import type { RecordingFile } from '../../src/evals/recording.js';
import type { Scenario } from '../../src/evals/scenario.js';
import type { VoiceAIEvent, VoiceAIEventListener } from '../../src/voice/types.js';

// DB-backed (banjo_test). Replays recordings of live eval runs (#188) against
// the real call path: CallSession, its safety nets, the tools and Postgres,
// with the model's side played back. A recording made with a different prompt
// or tools is stale: skipped, with a warning, never a pass.

const TEST_DB = 'postgresql://banjo:banjo@localhost:5432/banjo_test';
const RECORDINGS = 'evals/recordings';
const SCENARIOS = 'evals/scenarios';

async function clearTables() {
  const { db } = await import('../../src/db/index.js');
  const { sql } = await import('drizzle-orm');
  await db.execute(sql`truncate owner_questions, call_transcript_turns, call_attempts, tasks, contacts restart identity cascade`);
}

/**
 * Closes this module instance's Postgres pool, then resets modules. vi.resetModules
 * alone leaves the old pool open, and a pool per recording ran CI's Postgres out
 * of connections ("too many clients already") once there were 17 recordings.
 */
async function resetModulesAndCloseDb() {
  const { db } = await import('../../src/db/index.js');
  await db.$client.end({ timeout: 5 });
  vi.resetModules();
}

beforeEach(async () => {
  process.env.DATABASE_URL = TEST_DB;
  await clearTables();
});
afterEach(async () => {
  (await import('../../src/sim/simCall.js')).endSimOverrides();
  vi.useRealTimers();
});
afterAll(clearTables);

/** Plays Banjo's side of a booking: books on their first line, then says goodbye and ends the call. */
class ScriptedBanjo implements TextVoiceAIProvider {
  readonly name = 'scripted';
  private emitter = new EventEmitter();
  constructor(private readonly confirmedStart: string) {}
  async connect(): Promise<void> {
    setImmediate(() => this.emit({ type: 'connected' }));
  }
  sendUserText(text: string): void {
    this.emit({ type: 'transcript', role: 'user', text, isFinal: true });
    this.say("Hi, I'm an AI assistant calling for Alex to book a grooming.");
    this.emit({ type: 'tool_call', call: { id: 'confirm-1', name: 'confirm_appointment', arguments: { confirmedStart: this.confirmedStart, durationMinutes: 60, summary: 'Grooming' } } });
  }
  sendToolResult(toolCallId: string, result: unknown): void {
    if (toolCallId !== 'confirm-1' || !(result as { ok?: boolean }).ok) return;
    this.say("You're all set. Thanks so much, bye!");
    this.emit({ type: 'tool_call', call: { id: 'end-1', name: 'end_call', arguments: { summary: 'Booked.' } } });
    this.emit({ type: 'turn_end' });
  }
  sendAudioChunk(): void {}
  interrupt(): void {}
  triggerResponse(): void {}
  sayVerbatim(): void {}
  async disconnect(): Promise<void> {}
  on(_e: 'event', l: VoiceAIEventListener): void {
    this.emitter.on('event', l);
  }
  off(_e: 'event', l: VoiceAIEventListener): void {
    this.emitter.off('event', l);
  }
  private say(text: string): void {
    this.emit({ type: 'transcript', role: 'assistant', text, isFinal: true });
    this.emit({ type: 'turn_end' });
  }
  private emit(event: VoiceAIEvent): void {
    this.emitter.emit('event', event);
  }
}

const BOOKING: Scenario = {
  id: 'scripted-booking',
  title: 'A scripted booking',
  source: 'test',
  path: 'test',
  task: { business: "Claudia's Dog Grooming", category: 'salon', goal: 'Book a grooming appointment.', mode: 'booking', durationMinutes: 60, windowDays: 3 },
  flags: { transfer: false, warm: false, owner: 'accept' },
  script: [{ kind: 'line', text: "Claudia's, how can I help?" }],
  expect: { status: ['confirmed'], toolsCalled: [{ name: 'confirm_appointment' }], bookedLocal: { dayOffset: 2, time: '14:00' } },
};

/** Places a sim call for a scenario, with the voice session given, and returns it with what the checks need. */
async function simCall(scenario: Scenario, createVoiceAI: () => TextVoiceAIProvider, windowStart: Date) {
  const { startSimCall } = await import('../../src/sim/simCall.js');
  return startSimCall({
    business: scenario.task.business,
    category: scenario.task.category,
    goal: scenario.task.goal,
    mode: scenario.task.mode,
    questions: scenario.task.questions,
    durationMinutes: scenario.task.durationMinutes,
    windowDays: scenario.task.windowDays,
    windowStart,
    relationshipTier: scenario.task.relationshipTier,
    owner: (await import('../../src/evals/env.js')).OWNER_ANSWERS[scenario.flags.owner],
    ...(scenario.flags.askOwner !== undefined && { ownerAnswer: scenario.flags.askOwner }),
    createVoiceAI,
    print: () => {},
  });
}

/** Replays a recording through the sim and grades it as a live run would be. */
async function replayAndCheck(rec: RecordingFile, scenario: Scenario) {
  const { ReplayVoiceAI, replay } = await import('../../src/evals/replayer.js');
  const { buildRunRecord } = await import('../../src/evals/runRecord.js');
  const { runChecks } = await import('../../src/evals/checks.js');
  const { config } = await import('../../src/config/index.js');
  const voice = new ReplayVoiceAI(rec);
  const call = await simCall(scenario, () => voice, new Date(rec.windowStart));
  const outcome = await replay(voice, { waitMs: 30_000, hangUp: () => call.telephony.calleeHangsUp() });
  if (!outcome.ok) call.telephony.calleeHangsUp();
  const task = await call.finished;
  const record = buildRunRecord(voice.log, task, call.calendar.events, config.CALENDAR_TIMEZONE, rec.windowStart);
  return { outcome, checks: runChecks(record, scenario) };
}

describe('replay through the real call path', () => {
  it('a recorded scripted booking replays, and its checks pass', async () => {
    const { RecordingVoiceAI } = await import('../../src/evals/recorder.js');
    const { fingerprint } = await import('../../src/evals/recording.js');
    const { formatInZone } = await import('../../src/lib/timezone.js');
    const { config } = await import('../../src/config/index.js');
    const windowStart = new Date();
    const day = formatInZone(new Date(windowStart.getTime() + 2 * 86_400_000).toISOString(), config.CALENDAR_TIMEZONE).slice(0, 10);

    const recorder = new RecordingVoiceAI(new ScriptedBanjo(`${day}T14:00:00`));
    const live = await simCall(BOOKING, () => recorder, windowStart);
    (await live.ready)!.sendUserText("Claudia's, how can I help?");
    expect((await live.finished).status).toBe('confirmed');
    (await import('../../src/sim/simCall.js')).endSimOverrides();
    await clearTables();

    const connect = recorder.log.find((e) => e.dir === 'in' && e.call === 'connect');
    const rec: RecordingFile = {
      version: 1,
      scenarioId: BOOKING.id,
      scenarioHash: 'test',
      fingerprint: fingerprint((connect as Extract<typeof connect, { call: 'connect' }>)!.config),
      recordedAt: windowStart.toISOString(),
      windowStart: windowStart.toISOString(),
      gitSha: 'test',
      model: 'scripted',
      log: recorder.log,
    };
    const { outcome, checks } = await replayAndCheck(rec, BOOKING);
    expect(outcome).toMatchObject({ ok: true });
    expect(checks.filter((c) => !c.pass)).toEqual([]);
  }, 30_000);

  it("fakes only Date, which runs on from the recording's time", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-22T15:00:00.000Z'), shouldAdvanceTime: true });
    const before = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(before).toBeGreaterThanOrEqual(Date.parse('2026-10-22T15:00:00.000Z'));
    expect(Date.now() - before).toBeGreaterThanOrEqual(40);
    expect(Date.now()).toBeLessThan(Date.parse('2026-10-22T15:01:00.000Z'));
  });
});

describe('recorded scenarios', async () => {
  const { loadScenarios } = await import('../../src/evals/scenario.js');
  const { readRecording, scenarioHash } = await import('../../src/evals/recording.js');
  const scenarios = existsSync(SCENARIOS) ? loadScenarios(SCENARIOS) : [];
  if (!scenarios.length) it.skip('no scenarios yet', () => {});

  for (const scenario of scenarios) {
    const rec = readRecording(RECORDINGS, scenario.id);
    const reason = !rec ? 'no recording yet' : rec.scenarioHash !== scenarioHash(scenario.path) ? 'the scenario changed since its recording' : null;
    if (reason) {
      console.warn(`[evals] ${scenario.id}: ${reason} — re-record with npm run eval -- --scenario ${scenario.id} --record`);
      it.skip(`${scenario.id} (${reason})`, () => {});
      continue;
    }
    it(`${scenario.id} replays, and its checks pass`, async (ctx) => {
      await resetModulesAndCloseDb();
      const { evalEnv } = await import('../../src/evals/env.js');
      for (const [key, value] of Object.entries(evalEnv({ OPENAI_API_KEY: 'sk-test' }, { ...scenario.flags, env: scenario.env }))) vi.stubEnv(key, value);
      vi.stubEnv('DATABASE_URL', TEST_DB);
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(rec!.recordedAt), shouldAdvanceTime: true });
      try {
        const { outcome, checks } = await replayAndCheck(rec!, scenario);
        if (!outcome.ok && 'stale' in outcome) {
          console.warn(`[evals] ${scenario.id}: stale (the prompt or tools changed) — re-record with npm run eval -- --scenario ${scenario.id} --record`);
          // Skipped, never a pass: a stale recording proves nothing about this code.
          ctx.skip();
        }
        expect(outcome, JSON.stringify(outcome).slice(0, 2000)).toMatchObject({ ok: true });
        expect(checks.filter((c) => !c.pass)).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        await resetModulesAndCloseDb();
      }
    }, 120_000);
  }
});
