/**
 * Replays a recording (#188) in place of the model: the recorded events come
 * back in order, and every call the code under test makes to the voice
 * session is held to the recorded one. Everything above the provider
 * interface runs for real: CallSession, its safety nets, the tools, Postgres.
 *
 * Never a pass by default: a prompt or tools that changed since the recording
 * make it stale, and a call the recording didn't have, or one it had that
 * never comes, is a divergence.
 */
import { EventEmitter } from 'node:events';
import type { TextVoiceAIProvider } from '../sim/simCall.js';
import type {
  AnswerVerdict,
  AudioChunk,
  HoldVerdict,
  VerbatimDeliveryReport,
  VoiceAIEvent,
  VoiceAIEventListener,
  VoiceAISessionConfig,
} from '../voice/types.js';
import { fingerprint, normalizeVolatile, type RecordingFile } from './recording.js';
import type { LogEntry } from './recorder.js';

type InEntry = Extract<LogEntry, { dir: 'in' }>;

export interface Divergence {
  /** Index in the recording's log; -1 for a call it had none of. */
  index: number;
  expected: LogEntry | null;
  actual: LogEntry | 'timeout';
}

export type ReplayOutcome = { ok: true; log: LogEntry[] } | { ok: false; stale: true } | { ok: false; divergence: Divergence };

/** Entries the replay itself plays, rather than waiting for the code to make. */
const PLAYED = new Set(['capabilities', 'sendUserText', 'calleeHangsUp']);

/** What a recorded call is compared on: everything but when it happened, minus per-run ids and times. */
function comparable(entry: Record<string, unknown>): string {
  const { dir: _d, t: _t, verdict: _v, report: _r, ...rest } = entry;
  return normalizeVolatile(JSON.stringify(rest));
}

export class ReplayVoiceAI implements TextVoiceAIProvider {
  readonly name = 'replay';
  /** What actually happened on the replayed call, in the recorder's format, for the checks. */
  readonly log: LogEntry[];
  stale = false;
  divergence: Divergence | null = null;
  readonly consumed: boolean[];

  private readonly emitter = new EventEmitter();
  private readonly startedAt = Date.now();
  /** Pending judgments, by log index; each resolves with its recorded verdict. */
  private readonly judges = new Map<number, (v: string) => void>();
  private wake: () => void = () => {};

  declare readonly emitsInterruptions?: boolean;
  declare readonly marksVerbatimTurns?: boolean;
  declare readonly maxSessionMs?: number;
  declare addContext?: (items: { role: 'system' | 'user'; text: string }[]) => void;
  declare setHold?: (onHold: boolean) => void;
  declare judgeHoldLine?: (line: string, earlier: string[]) => Promise<HoldVerdict>;
  declare judgeFirstLine?: (line: string, earlier: string[]) => Promise<AnswerVerdict>;
  declare verbatimDeliveryReport?: () => VerbatimDeliveryReport | undefined;
  declare usageTotals?: () => { inputTokens: number; cachedInputTokens: number; outputTokens: number };

  constructor(readonly rec: RecordingFile) {
    const caps = rec.log[0];
    if (!caps || caps.dir !== 'in' || caps.call !== 'capabilities') throw new Error(`recording ${rec.scenarioId} has no capabilities entry`);
    this.log = [caps];
    this.consumed = rec.log.map((e) => e.dir === 'in' && e.call === 'capabilities');
    Object.assign(this, caps.props);
    const has = new Set(caps.has);
    if (has.has('addContext')) this.addContext = (items) => void this.match({ call: 'addContext', items });
    if (has.has('setHold')) this.setHold = (onHold) => void this.match({ call: 'setHold', onHold });
    if (has.has('judgeHoldLine')) {
      this.judgeHoldLine = (line, earlier) =>
        new Promise((resolve) => {
          const index = this.match({ call: 'judgeHoldLine', line, earlier: [...earlier] });
          if (index >= 0) this.judges.set(index, this.resolvingLogged(resolve as (v: string) => void));
        });
    }
    if (has.has('judgeFirstLine')) {
      this.judgeFirstLine = (line, earlier) =>
        new Promise((resolve) => {
          const index = this.match({ call: 'judgeFirstLine', line, earlier: [...earlier] });
          if (index >= 0) this.judges.set(index, this.resolvingLogged(resolve as (v: string) => void));
        });
    }
    if (has.has('verbatimDeliveryReport')) {
      this.verbatimDeliveryReport = () => {
        const index = this.match({ call: 'verbatimDeliveryReport' });
        const entry = rec.log[index];
        return entry?.dir === 'in' && entry.call === 'verbatimDeliveryReport' ? entry.report : undefined;
      };
    }
    if (has.has('usageTotals')) this.usageTotals = () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  }

  async connect(config: VoiceAISessionConfig): Promise<void> {
    if (fingerprint(config) !== this.rec.fingerprint) {
      this.stale = true;
      this.notify();
      return;
    }
    this.match({ call: 'connect', config: { instructions: config.instructions, tools: config.tools } });
  }

  sendToolResult(toolCallId: string, result: unknown, isError?: boolean, options?: { respond?: boolean | 'if-silent' }): void {
    this.match({
      call: 'sendToolResult',
      toolCallId,
      result,
      ...(isError !== undefined && { isError }),
      ...(options !== undefined && { options }),
    });
  }

  triggerResponse(cue?: string): void {
    this.match({ call: 'triggerResponse', ...(cue !== undefined && { cue }) });
  }

  sayVerbatim(text: string): void {
    this.match({ call: 'sayVerbatim', text });
  }

  interrupt(): void {
    this.match({ call: 'interrupt' });
  }

  /** The other party's lines come from the recording, which replay() plays: nothing to do. */
  sendUserText(): void {}
  sendAudioChunk(_chunk: AudioChunk): void {}
  async disconnect(): Promise<void> {}

  on(_event: 'event', listener: VoiceAIEventListener): void {
    this.emitter.on('event', listener);
  }

  off(_event: 'event', listener: VoiceAIEventListener): void {
    this.emitter.off('event', listener);
  }

  /** Resolves the next time anything changes: a call matched, a divergence, stale. */
  changed(): Promise<void> {
    return new Promise((resolve) => (this.wake = resolve));
  }

  emitRecorded(event: VoiceAIEvent): void {
    this.log.push({ dir: 'out', t: this.now(), event });
    this.emitter.emit('event', event);
  }

  playedUserLine(index: number): void {
    const entry = this.rec.log[index] as InEntry;
    this.consumed[index] = true;
    this.log.push({ ...entry, t: this.now() });
  }

  /** Resolves a judgment and records its verdict on the call just logged, as a live run's log has it. */
  private resolvingLogged(resolve: (v: string) => void): (v: string) => void {
    const logged = this.log.at(-1) as { verdict?: string };
    return (verdict) => {
      logged.verdict = verdict;
      resolve(verdict);
    };
  }

  resolveJudge(index: number): void {
    const entry = this.rec.log[index];
    if (entry?.dir === 'in' && (entry.call === 'judgeHoldLine' || entry.call === 'judgeFirstLine')) this.judges.get(index)?.(entry.verdict);
    this.judges.delete(index);
  }

  /**
   * Holds a call from the code to the recording's next unconsumed call of the
   * same kind. Returns its index, or -1 (a divergence) when it differs or
   * there's none.
   */
  private match(call: Record<string, unknown> & { call: string }): number {
    const actual = { dir: 'in', t: this.now(), ...call } as LogEntry;
    this.log.push(actual);
    if (this.divergence || this.stale) return -1;
    const index = this.rec.log.findIndex((e, i) => !this.consumed[i] && e.dir === 'in' && e.call === call.call && !PLAYED.has(e.call));
    if (index < 0) {
      this.divergence = { index: -1, expected: null, actual };
    } else if (comparable(this.rec.log[index] as unknown as Record<string, unknown>) !== comparable(actual as unknown as Record<string, unknown>)) {
      this.divergence = { index, expected: this.rec.log[index]!, actual };
    } else {
      this.consumed[index] = true;
    }
    this.notify();
    return this.divergence ? -1 : index;
  }

  private notify(): void {
    this.wake();
  }

  private now(): number {
    return Date.now() - this.startedAt;
  }
}

/**
 * Walks the recording: plays each recorded event and line in order, and waits
 * (up to waitMs) at each recorded call until the code has made it.
 */
export async function replay(voice: ReplayVoiceAI, opts: { waitMs?: number; hangUp?: () => void } = {}): Promise<ReplayOutcome> {
  const waitMs = opts.waitMs ?? 30_000;
  const log = voice.rec.log;
  const settled = (): ReplayOutcome | null => {
    if (voice.stale) return { ok: false, stale: true };
    if (voice.divergence) return { ok: false, divergence: voice.divergence };
    return null;
  };

  for (let i = 1; i < log.length; i++) {
    const entry = log[i]!;
    if (entry.dir === 'out') {
      await new Promise((resolve) => setImmediate(resolve));
      const early = settled();
      if (early) return early;
      voice.emitRecorded(entry.event);
      continue;
    }
    if (entry.call === 'sendUserText') {
      voice.playedUserLine(i);
      continue;
    }
    if (entry.call === 'calleeHangsUp') {
      voice.playedUserLine(i);
      opts.hangUp?.();
      continue;
    }
    const deadline = Date.now() + waitMs;
    while (!voice.consumed[i]) {
      const early = settled();
      if (early) return early;
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, divergence: { index: i, expected: entry, actual: 'timeout' } };
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([voice.changed(), new Promise((resolve) => (timer = setTimeout(resolve, left)))]);
      clearTimeout(timer);
    }
    voice.resolveJudge(i);
  }
  // A last moment for a call the recording didn't have.
  await new Promise((resolve) => setTimeout(resolve, Math.min(200, waitMs)));
  return settled() ?? { ok: true, log: voice.log };
}
