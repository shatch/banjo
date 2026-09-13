/**
 * OpenAI GPT-Live adapter (`gpt-live-1`) — selected by VOICE_AI_PROVIDER=openai-live.
 *
 * SHIPS DARK: never exercised against a live call. `openai` (gpt-realtime,
 * ./openai.ts) stays the default and is the only provider carrying live
 * traffic.
 *
 * GPT-Live is a full-duplex voice FRONT-END only — it listens and speaks at
 * the same time — and delegates reasoning and tool calls to a separate
 * Responses backend model (`delegation: { type: 'responses' }`). Two things
 * CallSession depends on have no equivalent on this wire, and are synthesized
 * here so CallSession's own logic stays unchanged:
 *   - turn_end: there is no response.done and no speech-started/stopped
 *     event. Emitted once output audio (silent frames excluded — see below),
 *     output transcript, and backend response.event activity have all gone
 *     quiet for OUTPUT_IDLE_TURN_END_MS.
 *     Losing turn_end is not graceful — CallSession's responseActive latches
 *     true, and the silence watchdog skips its nudge once and disarms itself.
 *   - verbatim speech: the Live prompting guide says outright "do not treat
 *     model-generated speech as guaranteed verbatim playback." sayVerbatim()
 *     asks for it, and verbatimDeliveryReport() then checks the output
 *     transcript against the intended text (../verbatimMatch.ts), so a
 *     voicemail is only recorded as left when it was actually said.
 * Final transcripts are synthesized too, for both sides, once fragments go
 * quiet for TRANSCRIPT_IDLE_FINAL_MS: GPT-Live never marks one final, and
 * CallSession both logs only final transcripts and arms its silence watchdog
 * only on a final user transcript.
 *
 * ============================================================================
 * CONFIRMED vs NEEDS VERIFICATION — read before trusting any wire detail here
 * ============================================================================
 * CONFIRMED against openai-node's TypeScript source (github.com/openai/
 * openai-node, src/resources/live/{live,internal-base}.ts and
 * src/resources/responses/responses.ts), checked 2026-09-12 — SDK types
 * only, NOT against a live session:
 *   - WebSocket at wss://api.openai.com/v1/live/sessions (internal-base.ts's
 *     buildURL: endpoint '/live/sessions', no query params), auth via
 *     `Authorization: Bearer <OPENAI_API_KEY>`, no beta header. The model
 *     goes in session.start's `session.model` — SessionConfig.model's own
 *     doc: "do not pass it as a URL query parameter".
 *   - The client sends `session.start` first and waits for `session.started`
 *     before any other command (SessionStartEvent doc).
 *   - `session.audio.format` is ONE AudioFormat shared by both directions.
 *     AudioPCMU is `{ type: 'audio/pcmu', rate }` with `rate` REQUIRED — the
 *     opposite of the Realtime API, which rejects a rate on pcmu. AudioPCM
 *     accepts only rate 16000 or 24000. Voice is `session.audio.output.voice`
 *     (default `marin`). Instructions, audio format, and voice are all
 *     immutable after startup.
 *   - Responses delegation: `session.delegation = { type: 'responses',
 *     responses: { model, instructions, tools } }`, tools being FunctionTool
 *     `{ type: 'function', name, description, parameters }`.
 *   - Server events: `session.started`, `session.output_audio.delta`
 *     (`delta`, base64), `session.output_transcript.delta` and
 *     `session.input_transcript.delta` (`delta`, `start_ms`, `end_ms` —
 *     fragments only, "these events do not define complete turns or include
 *     a transcript-done event"), `response.event` (a nested Responses stream
 *     event under `event`), `session.usage.updated` (`usage.seconds`,
 *     cumulative), `session.closed` (`reason`: close_requested | expired |
 *     content | remote_hangup | connection_lost), `error`
 *     (`error.{code,message,type}`).
 *   - A backend function call is a nested `response.output_item.done` whose
 *     `item` is a ResponseFunctionToolCall `{ type: 'function_call',
 *     call_id, name, arguments }`. The result goes back as
 *     `response.item.create` carrying a ResponseInputItem.FunctionCallOutput
 *     `{ type: 'function_call_output', call_id, output }`, followed by
 *     `response.create` ("continue a delegated response waiting for tool
 *     results").
 *   - `session.instructions.append` takes `content` (at most 500 tokens) and a
 *     REQUIRED `delegation_id`, which must be null under Responses delegation.
 *   - The complete client event set has no cancel, and the server event set
 *     has no interruption/speech-started event: interrupt() is a no-op and
 *     `interrupted` is never emitted (see docs/ARCHITECTURE.md's Open Risks).
 *
 * CONFIRMED on live calls (2026-09-12; a short smoke test, then a ~7.5-minute
 * conversation):
 *   - session.start as built here is accepted; audio both ways, input and
 *     output transcript deltas, and Responses delegation all flow.
 *   - Output audio is a CONTINUOUS real-time stream: the model pads the gaps
 *     between utterances with digital-silence frames (1887 of 4434 chunks
 *     were pure mu-law silence; the longest gap between any two chunks was
 *     289ms). Forwarded as-is, turn_end never fired once in 7.5 minutes and
 *     no assistant transcript was ever finalized — hence silent frames are
 *     dropped (see the session.output_audio.delta case).
 *   - A voicemail delivered via sayVerbatim() matched its output transcript
 *     and was recorded as voicemail_left (one call).
 *   - The voice layer did not delegate ending a free-form conversation (a
 *     5.5-minute call made zero delegations despite an explicit instruction)
 *     until the voice-layer prompt said outright that saying goodbye does not
 *     hang up; the next call delegated end_conversation_call right after its
 *     goodbye (see docs/ARCHITECTURE.md Open Risks #21).
 *
 * NEEDS VERIFICATION (live call):
 *   1. Whether `session.instructions.append` gets the voice model to speak
 *      promptly — used by both sayVerbatim() and triggerResponse(). The
 *      alternative, `session.commentary.append` ("speakable context... for a
 *      result the model should communicate"), invites paraphrase, which is
 *      why it was not the first choice for verbatim delivery.
 *   2. OUTPUT_IDLE_TURN_END_MS and TRANSCRIPT_IDLE_FINAL_MS are still guesses,
 *      though turn_end with silent frames dropped did fire as expected on two
 *      later live calls (3 and 23 turn_ends).
 *   3. Whether a backend function call can ever surface without a nested
 *      `response.output_item.done` (only that event carries `call_id`).
 *   4. GPT-Live's error codes — every error is emitted `retryable: true`,
 *      the same posture as the other adapters.
 * ============================================================================
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../../config/index.js';
import { childLogger } from '../../lib/logger.js';
import type {
  AudioChunk,
  NormalizedToolCall,
  ToolDefinition,
  VerbatimDeliveryReport,
  VoiceAIAudioFormat,
  VoiceAIEvent,
  VoiceAIEventListener,
  VoiceAIProvider,
  VoiceAISessionConfig,
} from '../types.js';
import { VoiceAIError } from '../types.js';
import { verbatimMatches } from '../verbatimMatch.js';

const log = childLogger({ module: 'voice.provider.openaiLive' });

const LIVE_URL = 'wss://api.openai.com/v1/live/sessions';

/**
 * How long output audio, output transcript, and backend response.event
 * activity must all stay quiet before a synthesized turn_end (see file
 * header). A starting guess: too low fires turn_end inside a natural pause;
 * too high adds latency to every hang-up tool's TURN_END_WAIT_MS wait in
 * session/callSession.ts.
 */
export const OUTPUT_IDLE_TURN_END_MS = 600;

/**
 * How long transcript fragments (either side) must stay quiet before they are
 * emitted as one final transcript. Raised from 600ms after the first live
 * call, which split caller speech at nearly every pause ("Hi" / ", uh" /
 * ", what can I").
 */
export const TRANSCRIPT_IDLE_FINAL_MS = 1200;

const TRIGGER_RESPONSE_INSTRUCTION =
  'It is your turn to speak. Respond to the other party now, following your instructions — if the call has only just connected, greet them.';

type LiveAudioFormat = { type: 'audio/pcmu'; rate: 8000 } | { type: 'audio/pcm'; rate: 16000 | 24000 };

function toLiveAudioFormat(format: VoiceAIAudioFormat): LiveAudioFormat {
  switch (format) {
    case 'g711_ulaw_8k':
      return { type: 'audio/pcmu', rate: 8000 };
    case 'pcm16_16k':
      return { type: 'audio/pcm', rate: 16000 };
    case 'pcm16_24k':
      return { type: 'audio/pcm', rate: 24000 };
    case 'pcm16_8k':
      throw new Error('VOICE_AI_PROVIDER=openai-live does not support pcm16_8k — Live WebSocket PCM audio is 16000 or 24000 Hz only');
  }
}

/** Maps our ToolDefinition[] to Live's FunctionTool envelope — the same shape the Realtime adapter puts under session.tools, here under delegation.responses.tools. */
function toLiveTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export class OpenAILiveProvider implements VoiceAIProvider {
  readonly name = 'openai-live';

  private ws: WebSocket | undefined;
  private emitter = new EventEmitter();
  private pendingConnect: { resolve: () => void; reject: (err: Error) => void } | undefined;
  /** session.started received — no command other than session.start may be sent before it. */
  private started = false;
  private disconnectedEmitted = false;
  private pendingTriggerResponse = false;
  private outputSampleRate = 8000;
  /** Tracks function_call ids already emitted as tool_call, so a repeated output_item.done can't double-dispatch a tool. */
  private emittedCallIds = new Set<string>();
  private turnEndTimer: ReturnType<typeof setTimeout> | undefined;
  private transcriptTimers: Record<'user' | 'assistant', ReturnType<typeof setTimeout> | undefined> = { user: undefined, assistant: undefined };
  private assistantTranscript = '';
  private userTranscript = '';
  /** The most recent sayVerbatim() request and the output transcript accumulated since it was sent. */
  private verbatim: { intended: string; spoken: string } | undefined;
  /**
   * True from sayVerbatim() until the first output audio after it. While set,
   * turn_end is held back: a turn_end left over from the preamble the model
   * spoke before the tool call would otherwise resolve CallSession's
   * speakVerbatim() wait before the message was ever spoken, and the empty
   * transcript would be misreported as a delivery mismatch.
   */
  private awaitingVerbatimAudio = false;
  private outputFormatType: LiveAudioFormat['type'] = 'audio/pcmu';
  /**
   * Diagnostics, logged once as a single summary line when the session ends
   * (never per frame). Added when a live call logged no assistant transcript
   * at all; the summary from the next call showed why (continuous output
   * audio, zero turn_ends — see file header). Kept so a future regression
   * in turn detection is visible from one log line.
   */
  private eventCounts = new Map<string, number>();
  private turnEndsEmitted = 0;
  private lastSpeechAudioAt: number | undefined;
  /** Longest gap between two non-silent output audio chunks. */
  private maxSpeechAudioGapMs = 0;
  /** Digital-silence output frames dropped rather than emitted. */
  private silentOutputAudioChunks = 0;
  private summaryLogged = false;

  connect(sessionConfig: VoiceAISessionConfig): Promise<void> {
    const apiKey = config.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured but VOICE_AI_PROVIDER=openai-live');
    }
    if (sessionConfig.inputAudioFormat !== sessionConfig.outputAudioFormat) {
      throw new Error(
        `VOICE_AI_PROVIDER=openai-live uses one audio format for both directions, but input (${sessionConfig.inputAudioFormat}) and output (${sessionConfig.outputAudioFormat}) differ — see negotiateAudioFormats() in session/audioPipeline.ts`,
      );
    }
    const format = toLiveAudioFormat(sessionConfig.outputAudioFormat);
    this.outputSampleRate = format.rate;
    this.outputFormatType = format.type;

    if (sessionConfig.frontendInstructions === undefined) {
      log.warn('no frontendInstructions supplied — sending the full prompt to both the voice layer and the backend');
    }
    const session = {
      model: config.OPENAI_LIVE_MODEL,
      instructions: sessionConfig.frontendInstructions ?? sessionConfig.instructions,
      audio: {
        format,
        ...(sessionConfig.voice ? { output: { voice: sessionConfig.voice } } : {}),
      },
      delegation: {
        type: 'responses',
        responses: {
          model: config.OPENAI_LIVE_BACKEND_MODEL,
          instructions: sessionConfig.instructions,
          tools: toLiveTools(sessionConfig.tools),
        },
      },
    };

    return new Promise((resolve, reject) => {
      this.pendingConnect = { resolve, reject };
      const ws = new WebSocket(LIVE_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      this.ws = ws;

      ws.on('open', () => {
        try {
          ws.send(JSON.stringify({ type: 'session.start', session }));
        } catch (err) {
          log.error({ err }, 'failed to send session.start');
          this.settleConnect(err instanceof Error ? err : new Error(String(err)));
        }
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      ws.on('error', (err: Error) => {
        log.error({ err }, 'openai live ws error');
        this.emitEvent({ type: 'error', error: new VoiceAIError(err.message, true) });
        this.settleConnect(err);
      });

      ws.on('close', (code: number, reasonBuf: Buffer) => {
        this.clearTimers();
        const reason = reasonBuf?.toString() || `ws closed (code ${code})`;
        // Before session.started the session never existed as far as
        // CallSession is concerned — reject connect() (-> fail()) rather than
        // also emitting 'disconnected' (-> end()), which would race it and
        // record a failed connect as a normal call end.
        if (!this.started) {
          this.settleConnect(new Error(`openai live connection closed before session.started: ${reason}`));
          return;
        }
        this.logEventSummary();
        this.emitDisconnected(reason);
      });
    });
  }

  sendAudioChunk(chunk: AudioChunk): void {
    if (!this.isStarted()) return;
    this.send({ type: 'session.input_audio.append', audio: chunk.data.toString('base64') });
  }

  sendToolResult(toolCallId: string, result: unknown, isError?: boolean): void {
    if (!this.isStarted()) return;
    const output = isError ? { error: true, ...safeResultObject(result) } : result;
    this.send({
      type: 'response.item.create',
      event_id: randomUUID(),
      item: {
        type: 'function_call_output',
        call_id: toolCallId,
        output: JSON.stringify(output),
      },
    });
    // Continue the delegated backend response that was waiting on this result.
    this.send({ type: 'response.create' });
  }

  interrupt(): void {
    // Deliberately a no-op: the Live client event set has no cancel, and in
    // full duplex the caller talking over the model is normal conversation
    // the model handles itself, not a barge-in to flush. See file header.
  }

  triggerResponse(): void {
    if (!this.isStarted()) {
      // Same connect() race as the Realtime adapter's triggerResponse(), plus
      // one more gate: nothing but session.start may be sent before
      // session.started. Queue it rather than drop the inbound greeting.
      this.pendingTriggerResponse = true;
      return;
    }
    // response.create would only prompt the delegated BACKEND; the voice
    // front-end has no response trigger, so steer it with an instruction.
    // NEEDS VERIFICATION (file header, item 1).
    this.appendInstructions(TRIGGER_RESPONSE_INSTRUCTION);
  }

  sayVerbatim(text: string): void {
    // Recorded before the connection check, so a dropped request still
    // reports as undelivered rather than as "never asked".
    this.verbatim = { intended: text, spoken: '' };
    if (!this.isStarted()) {
      log.warn({ textLength: text.length }, 'sayVerbatim called with no started session — message was dropped');
      return;
    }
    this.awaitingVerbatimAudio = true;
    this.clearTurnEndTimer();
    // No verbatim mechanism exists — this is a request, not a guarantee;
    // verbatimDeliveryReport() checks what was actually said.
    this.appendInstructions(
      `Say exactly the following, word for word, and nothing else — no preamble, no additions, no acknowledgement: "${text}"`,
    );
  }

  verbatimDeliveryReport(): VerbatimDeliveryReport | undefined {
    if (!this.verbatim) return undefined;
    const { intended } = this.verbatim;
    const spoken = this.verbatim.spoken.trim();
    return { intended, spoken, matched: verbatimMatches(intended, spoken) };
  }

  async disconnect(): Promise<void> {
    this.clearTimers();
    this.logEventSummary();
    if (!this.ws) return;
    await new Promise<void>((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once('close', () => resolve());
      // Best-effort graceful finalization; the socket closes right after
      // regardless, and nothing here depends on session.closed arriving.
      if (this.isStarted()) this.send({ type: 'session.close' });
      ws.close(1000, 'client disconnect');
    });
    this.ws = undefined;
  }

  on(event: 'event', listener: VoiceAIEventListener): void {
    this.emitter.on(event, listener);
  }

  off(event: 'event', listener: VoiceAIEventListener): void {
    this.emitter.off(event, listener);
  }

  private isStarted(): boolean {
    return this.started && !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private send(message: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(message));
  }

  private appendInstructions(content: string): void {
    this.send({ type: 'session.instructions.append', content, delegation_id: null });
  }

  private emitEvent(event: VoiceAIEvent): void {
    this.emitter.emit('event', event);
  }

  private emitDisconnected(reason: string): void {
    if (this.disconnectedEmitted) return;
    this.disconnectedEmitted = true;
    this.emitEvent({ type: 'disconnected', reason });
  }

  private settleConnect(err?: Error): void {
    const pending = this.pendingConnect;
    if (!pending) return;
    this.pendingConnect = undefined;
    if (err) pending.reject(err);
    else pending.resolve();
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      log.warn({ err }, 'received non-JSON message from openai live ws');
      return;
    }

    const type: string | undefined = msg?.type;
    if (!type) return;
    this.countEvent(type === 'response.event' ? `response.event:${msg.event?.type ?? 'unknown'}` : type);

    switch (type) {
      case 'session.started': {
        this.started = true;
        log.info({ sessionId: msg.session?.id }, 'openai live session started');
        this.emitEvent({ type: 'connected' });
        this.settleConnect();
        if (this.pendingTriggerResponse) {
          this.pendingTriggerResponse = false;
          this.appendInstructions(TRIGGER_RESPONSE_INSTRUCTION);
        }
        return;
      }

      case 'session.output_audio.delta': {
        const base64Audio: string | undefined = msg.delta;
        if (!base64Audio) return;
        const data = Buffer.from(base64Audio, 'base64');
        // Live streams output audio continuously, padding the gaps between
        // utterances with digital-silence frames (confirmed live — see file
        // header). Forwarded, they tell CallSession the model never stops
        // talking: turn_end can't fire, responseActive stays latched, and
        // every frame clears the silence watchdog. Dropping them loses
        // nothing on the phone leg, which plays silence between frames anyway.
        if (this.isSilentAudio(data)) {
          this.silentOutputAudioChunks++;
          return;
        }
        this.recordSpeechAudioGap();
        this.awaitingVerbatimAudio = false;
        this.emitEvent({
          type: 'audio_chunk',
          chunk: { data, sampleRate: this.outputSampleRate },
        });
        this.armTurnEnd();
        return;
      }

      case 'session.output_transcript.delta': {
        if (typeof msg.delta !== 'string') return;
        this.assistantTranscript += msg.delta;
        if (this.verbatim) this.verbatim.spoken += msg.delta;
        this.emitEvent({ type: 'transcript', role: 'assistant', text: msg.delta, isFinal: false });
        this.armTranscriptFlush('assistant');
        // Transcript can trail the audio it describes — keep the turn open
        // until it finishes, so a verbatim report taken at turn_end isn't
        // missing its last words.
        if (!this.awaitingVerbatimAudio) this.armTurnEnd();
        return;
      }

      case 'session.input_transcript.delta': {
        if (typeof msg.delta !== 'string') return;
        this.userTranscript += msg.delta;
        this.emitEvent({ type: 'transcript', role: 'user', text: msg.delta, isFinal: false });
        this.armTranscriptFlush('user');
        return;
      }

      case 'response.event': {
        const nested = msg.event;
        if (nested?.type === 'response.output_item.done' && nested.item?.type === 'function_call' && nested.item.call_id) {
          this.emitToolCall(nested.item.call_id, nested.item.name ?? 'unknown_tool', nested.item.arguments ?? '{}', msg);
        } else if (nested?.type === 'response.failed' || nested?.type === 'error') {
          log.warn({ nestedType: nested.type, delegationId: msg.delegation_id }, 'openai live delegated backend response reported a failure');
        }
        // Backend activity counts as the turn still being in progress — this
        // is also what ends a tool-only turn that never produces audio.
        if (!this.awaitingVerbatimAudio) this.armTurnEnd();
        return;
      }

      case 'session.usage.updated': {
        log.info({ audioSeconds: msg.usage?.seconds }, 'openai live usage');
        return;
      }

      case 'session.closed': {
        log.info({ reason: msg.reason, audioSeconds: msg.usage?.seconds }, 'openai live session closed');
        this.clearTimers();
        this.logEventSummary();
        this.emitDisconnected(`openai live session closed: ${msg.reason ?? 'unknown'}`);
        return;
      }

      case 'error': {
        const errPayload = msg.error ?? {};
        const message: string = errPayload.message ?? 'Unknown OpenAI Live error';
        this.emitEvent({ type: 'error', error: new VoiceAIError(message, true, errPayload.code) });
        if (!this.started) this.settleConnect(new Error(`openai live rejected session.start: ${message}`));
        return;
      }

      default:
        // Expected and ignored: session.instructions.appended,
        // session.delegation.created, info, etc.
        return;
    }
  }

  private armTurnEnd(): void {
    this.clearTurnEndTimer();
    this.turnEndTimer = setTimeout(() => {
      this.turnEndTimer = undefined;
      this.turnEndsEmitted++;
      this.flushTranscript('assistant');
      this.emitEvent({ type: 'turn_end' });
    }, OUTPUT_IDLE_TURN_END_MS);
  }

  private countEvent(key: string): void {
    this.eventCounts.set(key, (this.eventCounts.get(key) ?? 0) + 1);
  }

  /** Digital silence: every byte 0xFF (or 0x7F) for mu-law, every byte 0 for PCM. */
  private isSilentAudio(data: Buffer): boolean {
    if (data.length === 0) return true;
    return this.outputFormatType === 'audio/pcmu' ? data.every((b) => b === 0xff || b === 0x7f) : data.every((b) => b === 0);
  }

  private recordSpeechAudioGap(): void {
    const now = Date.now();
    if (this.lastSpeechAudioAt !== undefined) {
      this.maxSpeechAudioGapMs = Math.max(this.maxSpeechAudioGapMs, now - this.lastSpeechAudioAt);
    }
    this.lastSpeechAudioAt = now;
  }

  private armTranscriptFlush(role: 'user' | 'assistant'): void {
    const existing = this.transcriptTimers[role];
    if (existing) clearTimeout(existing);
    this.transcriptTimers[role] = setTimeout(() => {
      this.transcriptTimers[role] = undefined;
      this.flushTranscript(role);
    }, TRANSCRIPT_IDLE_FINAL_MS);
  }

  private logEventSummary(): void {
    if (this.summaryLogged || !this.started) return;
    this.summaryLogged = true;
    log.info(
      {
        eventCounts: Object.fromEntries(this.eventCounts),
        turnEndsEmitted: this.turnEndsEmitted,
        maxSpeechAudioGapMs: this.maxSpeechAudioGapMs,
        silentOutputAudioChunks: this.silentOutputAudioChunks,
      },
      'openai live event summary',
    );
  }

  private clearTurnEndTimer(): void {
    if (this.turnEndTimer) clearTimeout(this.turnEndTimer);
    this.turnEndTimer = undefined;
  }

  private clearTimers(): void {
    this.clearTurnEndTimer();
    for (const role of ['user', 'assistant'] as const) {
      const timer = this.transcriptTimers[role];
      if (timer) clearTimeout(timer);
      this.transcriptTimers[role] = undefined;
    }
  }

  private flushTranscript(role: 'user' | 'assistant'): void {
    const text = (role === 'user' ? this.userTranscript : this.assistantTranscript).trim();
    if (role === 'user') this.userTranscript = '';
    else this.assistantTranscript = '';
    if (text) this.emitEvent({ type: 'transcript', role, text, isFinal: true });
  }

  private emitToolCall(callId: string, name: string, argsStr: string, raw: unknown): void {
    if (this.emittedCallIds.has(callId)) return;
    this.emittedCallIds.add(callId);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsStr);
    } catch (err) {
      log.warn({ err, argsStr, callId }, 'failed to parse function_call arguments as JSON');
    }
    const call: NormalizedToolCall = { id: callId, name, arguments: args, rawVendorEvent: raw };
    this.emitEvent({ type: 'tool_call', call });
  }
}

function safeResultObject(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object') return result as Record<string, unknown>;
  return { value: result };
}
