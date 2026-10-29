/**
 * Records everything that crosses the voice-provider boundary on an eval run
 * (#188): what CallSession sent the model, and what the model sent back, in
 * arrival order. From that one log come the run's checks, its rescues and the
 * recording a replay plays back. Every model input and output on a sim call
 * goes through this interface, the hold judge included.
 */
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

/** The optional methods CallSession checks for before using: a recording keeps which ones the session had. */
export const OPTIONAL_METHODS = ['addContext', 'setHold', 'judgeHoldLine', 'judgeFirstLine', 'verbatimDeliveryReport', 'usageTotals'] as const;
/** The optional flags CallSession reads off the provider. */
export const OPTIONAL_PROPS = ['emitsInterruptions', 'marksVerbatimTurns', 'maxSessionMs'] as const;

type In<C extends string, T = object> = { dir: 'in'; t: number; call: C } & T;

export type LogEntry =
  | In<'capabilities', { has: string[]; props: Record<string, unknown> }>
  | In<'connect', { config: { instructions: string; tools: unknown[] } }>
  | In<'sendUserText', { text: string }>
  | In<'sendToolResult', { toolCallId: string; result: unknown; isError?: boolean; options?: unknown }>
  | In<'triggerResponse', { cue?: string }>
  | In<'sayVerbatim', { text: string }>
  | In<'addContext', { items: { role: 'system' | 'user'; text: string }[] }>
  | In<'setHold', { onHold: boolean }>
  | In<'interrupt'>
  | In<'judgeHoldLine', { line: string; earlier: string[]; verdict: HoldVerdict }>
  | In<'judgeFirstLine', { line: string; earlier: string[]; verdict: AnswerVerdict }>
  | In<'verbatimDeliveryReport', { report: VerbatimDeliveryReport | undefined }>
  /** Not a voice call: the other party hanging up, which the eval run logs so a replay can do the same. */
  | In<'calleeHangsUp'>
  | { dir: 'out'; t: number; event: VoiceAIEvent };

export class RecordingVoiceAI implements TextVoiceAIProvider {
  readonly name: string;
  readonly log: LogEntry[] = [];
  private readonly startedAt = Date.now();

  // Declared, not initialized: each exists on the instance only if the inner
  // session has it, since CallSession takes a different path without one.
  declare readonly emitsInterruptions?: boolean;
  declare readonly marksVerbatimTurns?: boolean;
  declare readonly maxSessionMs?: number;
  declare addContext?: (items: { role: 'system' | 'user'; text: string }[]) => void;
  declare setHold?: (onHold: boolean) => void;
  declare judgeHoldLine?: (line: string, earlier: string[]) => Promise<HoldVerdict>;
  declare judgeFirstLine?: (line: string, earlier: string[]) => Promise<AnswerVerdict>;
  declare verbatimDeliveryReport?: () => VerbatimDeliveryReport | undefined;
  declare usageTotals?: () => { inputTokens: number; cachedInputTokens: number; outputTokens: number };

  constructor(private readonly inner: TextVoiceAIProvider) {
    this.name = inner.name;
    const props: Record<string, unknown> = {};
    for (const prop of OPTIONAL_PROPS) {
      if (inner[prop] !== undefined) props[prop] = inner[prop];
    }
    Object.assign(this, props);
    const has = OPTIONAL_METHODS.filter((method) => typeof inner[method] === 'function');
    this.log.push({ dir: 'in', t: 0, call: 'capabilities', has: [...has], props });

    if (inner.addContext) {
      this.addContext = (items) => {
        this.record({ call: 'addContext', items });
        inner.addContext!(items);
      };
    }
    if (inner.setHold) {
      this.setHold = (onHold) => {
        this.record({ call: 'setHold', onHold });
        inner.setHold!(onHold);
      };
    }
    if (inner.judgeHoldLine) {
      this.judgeHoldLine = async (line, earlier) => {
        const verdict = await inner.judgeHoldLine!(line, earlier);
        this.record({ call: 'judgeHoldLine', line, earlier: [...earlier], verdict });
        return verdict;
      };
    }
    if (inner.judgeFirstLine) {
      this.judgeFirstLine = async (line, earlier) => {
        const verdict = await inner.judgeFirstLine!(line, earlier);
        this.record({ call: 'judgeFirstLine', line, earlier: [...earlier], verdict });
        return verdict;
      };
    }
    if (inner.verbatimDeliveryReport) {
      this.verbatimDeliveryReport = () => {
        const report = inner.verbatimDeliveryReport!();
        this.record({ call: 'verbatimDeliveryReport', report });
        return report;
      };
    }
    // Not logged: read once at the end of a run, and nothing in the call depends on it.
    if (inner.usageTotals) this.usageTotals = () => inner.usageTotals!();
    inner.on('event', (event) => {
      if (event.type !== 'audio_chunk') this.log.push({ dir: 'out', t: this.now(), event });
    });
  }

  async connect(config: VoiceAISessionConfig): Promise<void> {
    this.record({ call: 'connect', config: { instructions: config.instructions, tools: config.tools } });
    await this.inner.connect(config);
  }

  sendUserText(text: string): void {
    this.record({ call: 'sendUserText', text });
    this.inner.sendUserText(text);
  }

  sendToolResult(toolCallId: string, result: unknown, isError?: boolean, options?: { respond?: boolean | 'if-silent' }): void {
    this.record({
      call: 'sendToolResult',
      toolCallId,
      result,
      ...(isError !== undefined && { isError }),
      ...(options !== undefined && { options }),
    });
    this.inner.sendToolResult(toolCallId, result, isError, options);
  }

  triggerResponse(cue?: string): void {
    this.record({ call: 'triggerResponse', ...(cue !== undefined && { cue }) });
    if (cue === undefined) this.inner.triggerResponse();
    else this.inner.triggerResponse(cue);
  }

  sayVerbatim(text: string): void {
    this.record({ call: 'sayVerbatim', text });
    this.inner.sayVerbatim(text);
  }

  interrupt(): void {
    this.record({ call: 'interrupt' });
    this.inner.interrupt();
  }

  sendAudioChunk(chunk: AudioChunk): void {
    this.inner.sendAudioChunk(chunk);
  }

  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  on(event: 'event', listener: VoiceAIEventListener): void {
    this.inner.on(event, listener);
  }

  off(event: 'event', listener: VoiceAIEventListener): void {
    this.inner.off(event, listener);
  }

  /** Logs the other party hanging up (the script ran out, or the run hit its limit). */
  noteCalleeHangsUp(): void {
    this.record({ call: 'calleeHangsUp' });
  }

  private now(): number {
    return Date.now() - this.startedAt;
  }

  private record(entry: Record<string, unknown> & { call: string }): void {
    this.log.push({ dir: 'in', t: this.now(), ...entry } as LogEntry);
  }
}
