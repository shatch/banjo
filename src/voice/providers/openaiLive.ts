/**
 * OpenAI GPT-Live adapter (`gpt-live-1`) — selected by VOICE_AI_PROVIDER=openai-live.
 *
 * SHIPS DARK: exercised on live test calls (docs/ARCHITECTURE.md, GPT-Live
 * Open Risks), but `openai` (gpt-realtime, ./openai.ts) stays the default and
 * is the only provider carrying live traffic.
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
 *     synthesizes the message (TTS, in the session's voice) and plays it as
 *     an audio fixture (`session.output_audio.fixture.play`), reported
 *     delivered on `fixture.played`. If synthesis fails, it falls back to
 *     asking the model to say it, and verbatimDeliveryReport() checks the
 *     output transcript against the intended text (../verbatimMatch.ts), so
 *     a voicemail is only recorded as left when it was actually said.
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
 *   1. Fixtures, commentary and thinking (added 2026-10-28; a wire spike
 *      confirmed fixture.play on a pcmu session, `fixture.played` after the
 *      clip, no output transcript for it, and a spoken commentary cue) on a
 *      real call: does a commentary cue get the model to speak promptly, and
 *      does the TTS voice sound like the model's own?
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
import { responsesText } from '../../lib/openaiResponses.js';
import {
  ANSWER_CHECK_INSTRUCTIONS,
  answerCheckInput,
  answerVerdict,
  HOLD_CHECK_INSTRUCTIONS,
  HOLD_CHECK_TIMEOUT_MS,
  holdCheckInput,
  holdVerdict,
} from '../judges.js';
import type {
  AnswerVerdict,
  AudioChunk,
  HoldVerdict,
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

/**
 * How long connect() waits for session.started. The phone call is already
 * dialed by then (CallSession.start), so a session that opens but never
 * starts would otherwise leave the callee on a silent line with nothing to
 * end it; rejecting routes to CallSession.fail(), which hangs up.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/** The generic cue to speak, sent as commentary (see appendTriggerCue). */
const TRIGGER_RESPONSE_INSTRUCTION =
  'Respond to the other party now, following your instructions — if the call has only just connected, greet them.';

/**
 * How long Live waits before speaking its own acknowledgement of a delegation
 * ("one moment"). Its default outside Decisions sessions is 0, at once; 400 is
 * Live's own Decisions default, which leaves room for a quick tool result.
 */
const ACKNOWLEDGEMENT_DELAY_MS = 400;

/** Live's voice when the session names none (openai-node: "Defaults to `marin`"). A fixture is synthesized in the same one. */
const DEFAULT_LIVE_VOICE = 'marin';
/** Speech synthesis for verbatim fixtures: raw PCM16 at 24 kHz, the only fixture format. */
const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_INSTRUCTIONS = 'Speak warmly and naturally, at an unhurried pace, as on a phone call.';
const TTS_TIMEOUT_MS = 10_000;
/** Silent notes to the voice layer as a hold starts and ends (#151): while on hold, nothing it says is heard. */
const HOLD_STARTED_NOTE = 'You are on hold now. Say nothing and do nothing until you are told the hold is over: nothing you say can be heard.';
const HOLD_ENDED_NOTE = 'The hold is over: you can be heard again. Nothing you said during the hold was heard by anyone.';

/** A fixture is at most 30 seconds of PCM16 24 kHz audio. */
export const FIXTURE_MAX_BYTES = 30 * 24_000 * 2;

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
  /** No interruption event exists on this wire (open risk #15). */
  readonly emitsInterruptions = false;
  /** Transcripts finalize after an idle, which can be after the turn's tool call. */
  readonly transcriptsLate = true;
  /** A Live session expires two hours after it starts (session.started's expires_at, seen 2026-10-28). Caps a hold (#151). */
  readonly maxSessionMs = 2 * 60 * 60_000;

  private ws: WebSocket | undefined;
  /** The socket disconnect() is closing: if it hasn't opened yet, `ws` reports the close as an error, which isn't one (#100). */
  private closingWs: WebSocket | undefined;
  private emitter = new EventEmitter();
  private pendingConnect: { resolve: () => void; reject: (err: Error) => void } | undefined;
  /** session.started received — no command other than session.start may be sent before it. */
  private started = false;
  private disconnectedEmitted = false;
  /** A triggerResponse() that arrived before session.started: false for none, else its cue (undefined for none). */
  private pendingTriggerResponse: false | { cue?: string } = false;
  private outputSampleRate = 8000;
  private voice = DEFAULT_LIVE_VOICE;
  /** On hold (#151): the model keeps listening, and what it says or delegates is kept off the call. */
  private onHold = false;
  /** Output audio chunks held back on hold, for the event summary. */
  private heldOutputAudioChunks = 0;
  /** Counts sayVerbatim() calls, so audio synthesized for a replaced message is dropped. */
  private verbatimSeq = 0;
  /** The text of the fixture sent and not yet reported played. */
  private fixtureText: string | undefined;
  /** Tracks function_call ids already emitted as tool_call, so a repeated output_item.done can't double-dispatch a tool. */
  private emittedCallIds = new Set<string>();
  private turnEndTimer: ReturnType<typeof setTimeout> | undefined;
  private transcriptTimers: Record<'user' | 'assistant', ReturnType<typeof setTimeout> | undefined> = { user: undefined, assistant: undefined };
  private assistantTranscript = '';
  private userTranscript = '';
  /** The most recent sayVerbatim() request and the output transcript accumulated since it was sent. */
  private verbatim: { intended: string; spoken: string } | undefined;
  /**
   * True from sayVerbatim() until the output transcript since then matches
   * the message (or the report is read). While set, turn_end is held back:
   * trailing preamble audio, or a pause of more than OUTPUT_IDLE_TURN_END_MS
   * before or inside the message, would otherwise resolve CallSession's
   * deliverVerbatim() wait before the message was spoken, misreport a delivered
   * voicemail as a mismatch, and hang up on it. If the model never says it,
   * CallSession's SPEAK_VERBATIM_TIMEOUT_MS ends the wait instead.
   */
  private holdTurnEndForVerbatim = false;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  /** A trigger cue was appended and the model hasn't spoken or delegated since — see appendTriggerCue. */
  private triggerCueOutstanding = false;
  /**
   * Orders caller transcript fragments against the model's own responses
   * (speech audio, tool calls), so a final user transcript can say whether it
   * was already answered — see flushTranscript.
   */
  private activitySeq = 0;
  private lastUserFragmentSeq = 0;
  private lastResponseActivitySeq = 0;
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
    this.voice = sessionConfig.voice ?? DEFAULT_LIVE_VOICE;
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
        acknowledgement_delay_ms: ACKNOWLEDGEMENT_DELAY_MS,
        responses: {
          model: config.OPENAI_LIVE_BACKEND_MODEL,
          instructions: sessionConfig.instructions,
          tools: toLiveTools(sessionConfig.tools),
          // sendToolResult continues the response after each result; with
          // parallel calls that would continue it while other calls in the
          // same response still had no output.
          parallel_tool_calls: false,
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
      this.connectTimer = setTimeout(() => {
        log.error({ timeoutMs: CONNECT_TIMEOUT_MS }, 'openai live session did not start in time — abandoning the connection');
        this.settleConnect(new Error(`openai live session did not start within ${CONNECT_TIMEOUT_MS}ms`));
        ws.terminate();
      }, CONNECT_TIMEOUT_MS);

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
        if (ws === this.closingWs) {
          log.debug({ err }, 'openai live ws closed by disconnect() before it opened');
        } else {
          log.error({ err }, 'openai live ws error');
          this.emitEvent({ type: 'error', error: new VoiceAIError(err.message, true) });
        }
        this.settleConnect(err);
      });

      ws.on('close', (code: number, reasonBuf: Buffer) => {
        if (this.started) this.flushPendingTranscripts();
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

  triggerResponse(cue?: string): void {
    if (!this.isStarted()) {
      // Same connect() race as the Realtime adapter's triggerResponse(), plus
      // one more gate: nothing but session.start may be sent before
      // session.started. Queue it rather than drop the inbound greeting.
      this.pendingTriggerResponse = { cue };
      return;
    }
    // response.create would only prompt the delegated BACKEND; the voice
    // front-end has no response trigger, so steer it with commentary.
    // NEEDS VERIFICATION (file header, item 1).
    this.appendTriggerCue(cue);
  }

  sayVerbatim(text: string): void {
    // Recorded before the connection check, so a dropped request still
    // reports as undelivered rather than as "never asked".
    this.verbatim = { intended: text, spoken: '' };
    const seq = ++this.verbatimSeq;
    this.fixtureText = undefined;
    if (!this.isStarted()) {
      log.warn({ textLength: text.length }, 'sayVerbatim called with no started session — message was dropped');
      return;
    }
    this.holdTurnEndForVerbatim = true;
    this.clearTurnEndTimer();
    // Played as recorded audio, it is said word for word: the model can't
    // paraphrase it. If synthesis fails, the model is asked to say it, and
    // verbatimDeliveryReport() checks what it actually said.
    void synthesizeSpeech(text, this.voice)
      .then((audio) => {
        if (audio.length > FIXTURE_MAX_BYTES) throw new Error(`speech is ${audio.length} bytes, longer than a fixture may be`);
        return audio;
      })
      .then(
        (audio) => {
          if (seq !== this.verbatimSeq || !this.isStarted()) return;
          this.fixtureText = text;
          this.send({ type: 'session.output_audio.fixture.play', audio: audio.toString('base64') });
        },
        (err: unknown) => {
          if (seq !== this.verbatimSeq || !this.isStarted()) return;
          log.warn({ err }, 'could not play the message as recorded audio — asking the model to say it');
          // JSON.stringify quotes the message so a double quote inside it can't end it early.
          this.appendInstructions(
            `One-time cue for this moment only: say exactly the following once, word for word, and nothing else — no preamble, no additions, no acknowledgement — and never repeat it on a later turn: ${JSON.stringify(text)}`,
          );
        },
      );
  }

  verbatimDeliveryReport(): VerbatimDeliveryReport | undefined {
    // CallSession reads the report once its wait for the message is over, so
    // stop holding turn_end back for it either way.
    this.holdTurnEndForVerbatim = false;
    if (!this.verbatim) return undefined;
    const { intended } = this.verbatim;
    const spoken = this.verbatim.spoken.trim();
    return { intended, spoken, matched: verbatimMatches(intended, spoken) };
  }

  /**
   * On hold (#151). Muting Live's input would also stop its input transcript
   * (wire spike, 2026-10-28), and CallSession judges each line heard on hold
   * from that transcript. So the model keeps listening, and while on hold its
   * speech and transcript are dropped and any tool call it makes is refused.
   */
  setHold(onHold: boolean): void {
    if (this.onHold === onHold) return;
    this.onHold = onHold;
    if (!this.isStarted()) return;
    if (onHold) this.flushTranscript('assistant');
    this.appendThinking(onHold ? HOLD_STARTED_NOTE : HOLD_ENDED_NOTE);
  }

  /**
   * Silent context (session.thinking.append): it informs later speech without
   * asking for any. The other party's words are quoted as theirs, never given
   * as instructions.
   */
  addContext(items: { role: 'system' | 'user'; text: string }[]): void {
    if (!this.isStarted()) return;
    for (const { role, text } of items) {
      this.appendThinking(role === 'user' ? `The other party said: ${JSON.stringify(text)}` : text);
    }
  }

  /** What a line heard on hold is (#151), from a Responses request: Live has no out-of-band response of its own. */
  judgeHoldLine(line: string, earlier: string[]): Promise<HoldVerdict> {
    return this.judge(HOLD_CHECK_INSTRUCTIONS, holdCheckInput(line, earlier)).then(holdVerdict);
  }

  /** Who answered (#187), judged the same way. */
  judgeFirstLine(line: string, earlier: string[]): Promise<AnswerVerdict> {
    return this.judge(ANSWER_CHECK_INSTRUCTIONS, answerCheckInput(line, earlier)).then(answerVerdict);
  }

  async disconnect(): Promise<void> {
    if (this.started) this.flushPendingTranscripts();
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
      this.closingWs = ws;
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

  /** Live caps an append at 500 tokens; this keeps well under it. */
  private appendThinking(content: string): void {
    this.send({ type: 'session.thinking.append', content: content.slice(0, 1500), delegation_id: null });
  }

  /** A tool call made on hold is answered, not run: the delegated response would otherwise wait on it. */
  private refuseOnHold(callId: string, name: string | undefined): void {
    if (this.emittedCallIds.has(callId)) return;
    this.emittedCallIds.add(callId);
    log.warn({ callId, name }, 'tool call on hold — refused, not run');
    this.sendToolResult(callId, { ok: false, error: 'on_hold', message: 'You are on hold: nothing was done. Say nothing.' }, true);
  }

  /** One out-of-band one-word judgment; undefined if it failed or timed out, which each verdict parser handles. */
  private judge(instructions: string, input: string): Promise<string | undefined> {
    return responsesText({ model: config.OPENAI_LIVE_BACKEND_MODEL, instructions, input, timeoutMs: HOLD_CHECK_TIMEOUT_MS }).catch(
      (err: unknown) => {
        log.warn({ err }, 'out-of-band judgment failed');
        return undefined;
      },
    );
  }

  /**
   * A fixture leaves no output transcript, so its text is emitted as Banjo's
   * line here (the disclosure check and the call's transcript read it), and
   * the voice layer is told what it said, as Live asks for external audio.
   */
  private onFixturePlayed(): void {
    const text = this.fixtureText;
    if (text === undefined) return;
    this.fixtureText = undefined;
    if (this.verbatim?.intended === text) this.verbatim.spoken = text;
    const pending = this.transcriptTimers.assistant;
    if (pending) clearTimeout(pending);
    this.transcriptTimers.assistant = undefined;
    this.flushTranscript('assistant');
    this.emitEvent({ type: 'transcript', role: 'assistant', text, isFinal: true });
    this.appendThinking(`You just said this to them, word for word, as recorded audio: ${JSON.stringify(text)}`);
    this.holdTurnEndForVerbatim = false;
    this.armTurnEnd();
  }

  /**
   * A cue is commentary (`session.commentary.append`: context for the model
   * to communicate, which asks it to speak), and stays in the conversation.
   * One appended again before the model acted on the last would pile up
   * "respond now" against the turn-taking guidance, so it's skipped while one
   * is still outstanding. `cue` replaces the generic one.
   */
  private appendTriggerCue(cue?: string): void {
    if (this.triggerCueOutstanding) {
      log.debug('a response cue is already outstanding — not appending another');
      return;
    }
    this.triggerCueOutstanding = true;
    this.send({ type: 'session.commentary.append', content: cue ?? TRIGGER_RESPONSE_INSTRUCTION, delegation_id: null });
  }

  /** The model visibly responded (speech audio or a delegated tool call). */
  private noteResponseActivity(): void {
    this.lastResponseActivitySeq = ++this.activitySeq;
    this.triggerCueOutstanding = false;
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
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
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
          const { cue } = this.pendingTriggerResponse;
          this.pendingTriggerResponse = false;
          this.appendTriggerCue(cue);
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
        if (this.onHold) {
          this.heldOutputAudioChunks++;
          return;
        }
        this.recordSpeechAudioGap();
        this.noteResponseActivity();
        this.emitEvent({
          type: 'audio_chunk',
          chunk: { data, sampleRate: this.outputSampleRate },
        });
        if (!this.holdTurnEndForVerbatim) this.armTurnEnd();
        return;
      }

      case 'session.output_transcript.delta': {
        if (typeof msg.delta !== 'string' || this.onHold) return;
        this.assistantTranscript += msg.delta;
        if (this.verbatim) this.verbatim.spoken += msg.delta;
        this.emitEvent({ type: 'transcript', role: 'assistant', text: msg.delta, isFinal: false });
        this.armTranscriptFlush('assistant');
        if (this.holdTurnEndForVerbatim && this.verbatim && verbatimMatches(this.verbatim.intended, this.verbatim.spoken)) {
          this.holdTurnEndForVerbatim = false;
        }
        // Transcript can trail the audio it describes — keep the turn open
        // until it finishes, so a verbatim report taken at turn_end isn't
        // missing its last words.
        if (!this.holdTurnEndForVerbatim) this.armTurnEnd();
        return;
      }

      case 'session.input_transcript.delta': {
        if (typeof msg.delta !== 'string') return;
        this.userTranscript += msg.delta;
        this.lastUserFragmentSeq = ++this.activitySeq;
        this.emitEvent({ type: 'transcript', role: 'user', text: msg.delta, isFinal: false });
        this.armTranscriptFlush('user');
        return;
      }

      case 'response.event': {
        const nested = msg.event;
        if (nested?.type === 'response.output_item.done' && nested.item?.type === 'function_call' && nested.item.call_id && this.onHold) {
          this.refuseOnHold(nested.item.call_id, nested.item.name);
          return;
        }
        if (nested?.type === 'response.output_item.done' && nested.item?.type === 'function_call' && nested.item.call_id) {
          this.emitToolCall(nested.item.call_id, nested.item.name ?? 'unknown_tool', nested.item.arguments ?? '{}', msg);
        } else if (nested?.type === 'response.failed' || nested?.type === 'error') {
          log.warn({ nestedType: nested.type, delegationId: msg.delegation_id }, 'openai live delegated backend response reported a failure');
        }
        // Backend activity counts as the turn still being in progress — this
        // is also what ends a tool-only turn that never produces audio.
        if (!this.holdTurnEndForVerbatim) this.armTurnEnd();
        return;
      }

      case 'session.output_audio.fixture.playing': {
        this.noteResponseActivity();
        return;
      }

      case 'session.output_audio.fixture.played': {
        this.onFixturePlayed();
        return;
      }

      // The model handed work to the backend: it responded, and its turn goes on.
      case 'session.delegation.created': {
        this.noteResponseActivity();
        if (!this.holdTurnEndForVerbatim) this.armTurnEnd();
        return;
      }

      case 'session.usage.updated': {
        log.info({ audioSeconds: msg.usage?.seconds }, 'openai live usage');
        return;
      }

      case 'session.closed': {
        log.info({ reason: msg.reason, audioSeconds: msg.usage?.seconds }, 'openai live session closed');
        this.flushPendingTranscripts();
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
        heldOutputAudioChunks: this.heldOutputAudioChunks,
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

  /**
   * A final user transcript lands TRANSCRIPT_IDLE_FINAL_MS after the caller's
   * last fragment — often after a full-duplex model has already replied.
   * `answered` tells CallSession not to arm its silence watchdog for it, or a
   * caller pausing after the reply would get nudged at. Only a response after
   * the last fragment counts, so a backchannel mid-sentence doesn't.
   */
  private flushTranscript(role: 'user' | 'assistant'): void {
    const text = (role === 'user' ? this.userTranscript : this.assistantTranscript).trim();
    if (role === 'user') this.userTranscript = '';
    else this.assistantTranscript = '';
    if (!text) return;
    const answered = role === 'user' && this.lastResponseActivitySeq > this.lastUserFragmentSeq;
    this.emitEvent({ type: 'transcript', role, text, isFinal: true, ...(answered ? { answered: true } : {}) });
  }

  /** Emits whatever fragments are still waiting on their idle timer, so the last words before a hang-up get logged. */
  private flushPendingTranscripts(): void {
    for (const role of ['user', 'assistant'] as const) {
      const timer = this.transcriptTimers[role];
      if (!timer) continue;
      clearTimeout(timer);
      this.transcriptTimers[role] = undefined;
      this.flushTranscript(role);
    }
  }

  private emitToolCall(callId: string, name: string, argsStr: string, raw: unknown): void {
    if (this.emittedCallIds.has(callId)) return;
    this.emittedCallIds.add(callId);
    this.noteResponseActivity();
    let args: Record<string, unknown> = {};
    let unparsedArguments: string | undefined;
    try {
      args = JSON.parse(argsStr);
    } catch (err) {
      // Deliberately NOT swallowed into `args = {}`: an empty object is a
      // legitimate call shape, so passing one on here loses the difference
      // between "the model sent no arguments" and "the message was cut off".
      log.warn({ err, argsStr, callId }, 'failed to parse function_call arguments as JSON');
      unparsedArguments = argsStr;
    }
    const call: NormalizedToolCall = { id: callId, name, arguments: args, unparsedArguments, rawVendorEvent: raw };
    this.emitEvent({ type: 'tool_call', call });
  }
}

function safeResultObject(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object') return result as Record<string, unknown>;
  return { value: result };
}

/** The message as raw PCM16 24 kHz speech in `voice`, the format a fixture must be. */
async function synthesizeSpeech(text: string, voice: string): Promise<Buffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice, input: text, instructions: TTS_INSTRUCTIONS, response_format: 'pcm' }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`speech synthesis failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
