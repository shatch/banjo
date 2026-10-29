/**
 * OpenAI Realtime API adapter — targets the GA (non-beta) interface.
 *
 * ============================================================================
 * CONFIRMED vs NEEDS VERIFICATION — read before trusting any wire detail here
 * ============================================================================
 * CONFIRMED (verified directly against openai-node's TypeScript source —
 * github.com/openai/openai-node, src/resources/realtime/realtime.ts, checked
 * 2026-08 after two live-call failures: the beta header being rejected, then
 * `session.audio.input.format.rate` being rejected as an unknown parameter
 * for mu-law):
 *   - Connection is a WebSocket to wss://api.openai.com/v1/realtime?model=...
 *   - Auth via `Authorization: Bearer <OPENAI_API_KEY>` header ONLY — the
 *     `OpenAI-Beta: realtime=v1` header MUST NOT be sent; GA rejects it
 *     outright rather than ignoring it.
 *   - `session.update`'s `session` object requires `type: 'realtime'`
 *     (`RealtimeSessionCreateRequest.type`, required not optional).
 *   - Audio config lives under `session.audio.{input,output}.format`
 *     (`RealtimeAudioConfigInput`/`RealtimeAudioConfigOutput`), each an
 *     `AudioPCM | AudioPCMU | AudioPCMA` (`RealtimeAudioFormats`):
 *       - `audio/pcmu` (mu-law) and `audio/pcma` take NO `rate` field —
 *         it's implicitly 8kHz; including one is rejected.
 *       - `audio/pcm` accepts only the literal `rate: 24000` — no other
 *         value is valid.
 *   - `voice` lives at `session.audio.output.voice`.
 *   - Tool envelope (`session.tools[]`) is `RealtimeFunctionTool`:
 *     `{ type: 'function', name, description, parameters }` — unchanged
 *     from the beta shape.
 *   - `gpt-realtime` (our default `OPENAI_REALTIME_MODEL`) is a valid,
 *     current model id per the SDK's model enum.
 *   - `response.output_audio.delta`, `response.done`,
 *     `response.function_call_arguments.delta`/`.done`, `response.cancel`,
 *     and `conversation.item.create` with a `function_call_output` item are
 *     all confirmed exact event/type names.
 *   - Client -> server events are JSON objects with a `type` field.
 *   - `input_audio_buffer.append` is the event used to stream input audio in
 *     as base64.
 *   - `response.create`'s `response` object accepts an `instructions` field
 *     that overrides the session's standing instructions FOR THAT ONE
 *     response only — verified 2026-09-01 against OpenAI's Realtime API
 *     docs ("These fields will override the Session's configuration for
 *     this Response only"). Used by sayVerbatim() below to force a
 *     particular response's spoken content (e.g. a voicemail message)
 *     rather than trusting the model already said it in an earlier,
 *     unconstrained turn. Not yet exercised against a live call.
 *   - Text-only mode (the simulator, scripts/sim.ts), checked 2026-10-12
 *     against the same file: `session.output_modalities: ['text']` turns
 *     audio output off; replies then stream as `response.output_text.delta`
 *     (`delta`) and `response.output_text.done` (`text`); a typed caller
 *     line is a `conversation.item.create` with a `message` item, role
 *     `user`, content `[{ type: 'input_text', text }]`.
 *
 * NEEDS VERIFICATION (not cross-checked against the SDK source, only
 * sketched from general API conventions):
 *   1. The exact error event shape — sketched as `{ type: 'error', error: {
 *      message, code, ... } }`.
 *   2. Whether `response.audio.delta` (the pre-GA event name) can still
 *      arrive in any circumstance — handled defensively as a fallback
 *      alongside `response.output_audio.delta`, but not confirmed necessary.
 * ============================================================================
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../../config/index.js';
import { childLogger } from '../../lib/logger.js';
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
import {
  ANSWER_CHECK_INSTRUCTIONS,
  answerCheckInput,
  answerVerdict,
  HOLD_CHECK_INSTRUCTIONS,
  HOLD_CHECK_TIMEOUT_MS,
  holdCheckInput,
  holdVerdict,
} from '../judges.js';
import { VoiceAIError } from '../types.js';
import { verbatimMatches } from '../verbatimMatch.js';

const log = childLogger({ module: 'voice.provider.openai' });

interface OpenAIAudioFormat {
  type: string;
  rate?: 24000;
}

/**
 * Maps our vendor-agnostic audio format enum to OpenAI's GA audio format
 * object. CONFIRMED against openai-node's `RealtimeAudioFormats` types
 * (RealtimeAudioFormats.AudioPCM / AudioPCMU / AudioPCMA):
 *   - `audio/pcmu` (mu-law) and `audio/pcma` take NO `rate` field at all —
 *     it's implicitly 8kHz. Sending one is rejected with
 *     "Unknown parameter: 'session.audio.input.format.rate'" (hit this for
 *     real against the live API — the fix here is not a guess).
 *   - `audio/pcm` accepts only the literal `rate: 24000` — no other sample
 *     rate is supported. This means our internal `pcm16_8k`/`pcm16_16k`
 *     enum values are not actually usable with OpenAI; session/audioPipeline.ts's
 *     negotiateAudioFormats() never requests them for this provider, so this
 *     is a documented constraint rather than a live bug, but worth knowing
 *     if that negotiation logic ever changes.
 */
function toOpenAIAudioFormat(format: VoiceAIAudioFormat): OpenAIAudioFormat {
  if (format === 'g711_ulaw_8k') return { type: 'audio/pcmu' };
  return { type: 'audio/pcm', rate: 24000 };
}

/** The actual wire sample rate for a given format — kept separate from toOpenAIAudioFormat() since AudioPCMU has no `rate` field to read it back from. */
function actualSampleRate(format: VoiceAIAudioFormat): number {
  return format === 'g711_ulaw_8k' ? 8000 : 24000;
}

/** Maps our ToolDefinition[] to OpenAI's function-calling tool envelope. CONFIRMED against openai-node's RealtimeFunctionTool type: `{ type: 'function', name, description, parameters }`. */
function toOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/** The text of an out-of-band response's output, if any. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function outputText(response: any): string | undefined {
  const parts: string[] = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) if (typeof content?.text === 'string') parts.push(content.text);
  }
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * response.create, with a cue as `response.instructions` when there is one. That field replaces the session's
 * instructions for this one response only (see sayVerbatim), so a cue has to say everything that response needs.
 */
function responseCreate(cue?: string): Record<string, unknown> {
  return cue === undefined ? { type: 'response.create' } : { type: 'response.create', response: { instructions: cue } };
}

interface PendingFunctionCall {
  callId: string;
  name: string;
  argsBuffer: string;
}

export interface OpenAIRealtimeProviderOptions {
  /**
   * Text in, text out, no audio: the simulator (scripts/sim.ts), where you type
   * as the business. Same model, prompt and tools as a call; the caller's lines
   * come in through sendUserText(). Never set on a real call.
   */
  textOnly?: boolean;
}

export class OpenAIRealtimeProvider implements VoiceAIProvider {
  readonly name = 'openai';
  private readonly textOnly: boolean;
  // Every response's tokens, out-of-band hold checks included (#188).
  private usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  private ws: WebSocket | undefined;
  /** The socket disconnect() is closing: if it hasn't opened yet, `ws` reports the close as an error, which isn't one (#100). */
  private closingWs: WebSocket | undefined;
  private emitter = new EventEmitter();
  private pendingCalls = new Map<string, PendingFunctionCall>();
  /** Tracks function_call ids we've already emitted a tool_call for, so response.done doesn't double-emit. */
  private emittedCallIds = new Set<string>();
  /**
   * For sendToolResult's respond: 'if-silent' (#148 review r2): which response
   * each tool call came from, which responses are still open, which produced
   * speech, and what to decide once an open one is done.
   */
  private callResponseIds = new Map<string, string>();
  private openResponseIds = new Set<string>();
  private spokenResponseIds = new Set<string>();
  private afterResponseDone = new Map<string, (() => void)[]>();
  /**
   * A tool result is waiting for a reply that can't be prompted yet: another
   * response is open, and OpenAI rejects a second response.create
   * (conversation_already_has_active_response). Prompted once none is open.
   * In sim warm-transfer runs the "owner declined" result was rejected that
   * way while Banjo answered the other party, and never got a reply.
   */
  private toolReplyWaiting = false;
  /** event_ids of the response.create messages sent for tool results, so a rejection of one can be told apart. */
  private readonly toolReplyEventIds = new Set<string>();
  private toolReplySeq = 0;
  /**
   * The latest sayVerbatim() message (#177). Sent as its own response once
   * none is open, and re-sent if the server rejects it for one that had just
   * started: on a live call the message's response.create lost that race, and
   * the voicemail was left blank. `eventId` is set once sent; `responseId`
   * once the server starts it; `done` once that response is done. Dropped
   * when its delivery report is read.
   */
  private verbatim: { text: string; eventId?: string; responseId?: string; spoken: string[]; done: boolean } | undefined;
  private verbatimSeq = 0;
  readonly marksVerbatimTurns = true;
  /** The rate we negotiated for output audio (session.audio.output.format.rate) — used to tag emitted audio_chunks correctly instead of assuming a fixed rate. */
  private outputSampleRate = 24000;
  /** A triggerResponse() that arrived before the socket opened: false for none, else its cue (undefined for none). */
  private pendingTriggerResponse: false | { cue?: string } = false;
  /** OpenAI ends a Realtime session at 60 minutes, with no warning first. */
  readonly maxSessionMs = 60 * 60_000;
  /** On hold (#151): no automatic replies, and each held turn is deleted from the conversation once transcribed. */
  private onHold = false;
  /** The session's audio.input, kept so setHold() can resend it whole with only turn_detection changed. */
  private audioInput: Record<string, unknown> | undefined;
  /** Hold judgments waiting on their out-of-band response, by the id in its metadata. */
  private readonly holdChecks = new Map<string, (text: string | undefined) => void>();
  /** Out-of-band responses (hold judgments): their text and turn_end are not Banjo speaking. */
  private readonly outOfBandResponseIds = new Set<string>();
  private holdCheckSeq = 0;

  constructor(options: OpenAIRealtimeProviderOptions = {}) {
    this.textOnly = options.textOnly ?? false;
  }

  connect(sessionConfig: VoiceAISessionConfig): Promise<void> {
    const apiKey = config.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured but VOICE_AI_PROVIDER=openai');
    }
    const model = config.OPENAI_REALTIME_MODEL;
    // NEEDS VERIFICATION (see file header, item 1): exact model id.
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    const outputFormat = toOpenAIAudioFormat(sessionConfig.outputAudioFormat);
    this.outputSampleRate = actualSampleRate(sessionConfig.outputAudioFormat);

    return new Promise((resolve, reject) => {
      // GA interface: Authorization only. The beta header (`OpenAI-Beta:
      // realtime=v1`) is REJECTED outright by GA, not just ignored — sending
      // it produces "The Realtime Beta API is no longer supported."
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      this.ws = ws;

      let settled = false;

      ws.on('open', () => {
        try {
          ws.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'realtime',
                instructions: sessionConfig.instructions,
                tools: toOpenAITools(sessionConfig.tools),
                // Text-only mode sends no audio config at all.
                ...(this.textOnly
                  ? { output_modalities: ['text'] }
                  : {
                      audio: {
                        // `transcription` is a genuinely separate opt-in feature
                        // from the model's ability to understand spoken input —
                        // Realtime models consume audio natively, so omitting this
                        // does NOT stop the model from understanding the caller
                        // (confirmed on a live call: it correctly answered a
                        // question after a multi-second pause with no
                        // transcription enabled). It only stops US from ever
                        // seeing what the caller said in our own logs/transcript
                        // events — every 'transcript' event with role: 'user' was
                        // silently never firing because of this, not because
                        // audio wasn't reaching the model.
                        input: (this.audioInput = {
                          format: toOpenAIAudioFormat(sessionConfig.inputAudioFormat),
                          transcription: { model: 'gpt-4o-mini-transcribe' },
                          // Filtered before server VAD sees it, so noise and echo
                          // don't count as a barge-in (#143).
                          ...(config.OPENAI_NOISE_REDUCTION !== 'off' && {
                            noise_reduction: { type: config.OPENAI_NOISE_REDUCTION },
                          }),
                        }),
                        output: { format: outputFormat, voice: sessionConfig.voice },
                      },
                    }),
              },
            }),
          );
        } catch (err) {
          log.error({ err }, 'failed to send initial session.update');
        }
        this.emitEvent({ type: 'connected' });
        if (this.pendingTriggerResponse) {
          const { cue } = this.pendingTriggerResponse;
          this.pendingTriggerResponse = false;
          ws.send(JSON.stringify(responseCreate(cue)));
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      ws.on('error', (err: Error) => {
        if (ws === this.closingWs) {
          log.debug({ err }, 'openai realtime ws closed by disconnect() before it opened');
        } else {
          log.error({ err }, 'openai realtime ws error');
          this.emitEvent({ type: 'error', error: new VoiceAIError(err.message, true) });
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on('close', (code: number, reasonBuf: Buffer) => {
        const reason = reasonBuf?.toString() || `ws closed (code ${code})`;
        this.emitEvent({ type: 'disconnected', reason });
      });
    });
  }

  sendAudioChunk(chunk: AudioChunk): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: chunk.data.toString('base64'),
      }),
    );
  }

  /**
   * Text-only mode: one line from the other party, as typed. Reported back as a
   * final user transcript, the way a call reports transcribed speech, so
   * CallSession handles it exactly like a spoken turn.
   */
  usageTotals(): { inputTokens: number; cachedInputTokens: number; outputTokens: number } {
    return { ...this.usage };
  }

  private addUsage(usage: any): void {
    if (!usage) return;
    this.usage.inputTokens += Number(usage.input_tokens) || 0;
    this.usage.cachedInputTokens += Number(usage.input_token_details?.cached_tokens) || 0;
    this.usage.outputTokens += Number(usage.output_tokens) || 0;
  }

  sendUserText(text: string): void {
    if (!this.textOnly) throw new Error('sendUserText is only for text-only mode');
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn({ textLength: text.length }, 'sendUserText called with no open connection — line was dropped');
      return;
    }
    this.emitEvent({ type: 'transcript', role: 'user', text, isFinal: true });
    // On hold (#151): heard, never answered, and kept out of the conversation, like a held audio turn.
    if (this.onHold) return;
    this.ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      }),
    );
    this.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  sendToolResult(toolCallId: string, result: unknown, isError?: boolean, options?: { respond?: boolean | 'if-silent' }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const output = isError ? { error: true, ...safeResultObject(result) } : result;
    this.ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: toolCallId,
          output: JSON.stringify(output),
        },
      }),
    );
    // Prompt the model to continue now that it has the tool result, unless the
    // caller wants it to wait for the other party (server VAD responds then).
    if (options?.respond === 'if-silent') return this.respondIfSilent(toolCallId);
    if (options?.respond !== false) this.promptToolReply();
  }

  /** Prompts a reply to a tool result now, or once no other response is open. One prompt covers every result waiting. */
  private promptToolReply(): void {
    this.toolReplyWaiting = true;
    this.flushToolReply();
  }

  private flushToolReply(): void {
    // A verbatim message still to be said goes first: a reply prompted now would talk over it or delay it.
    const verbatimPending = this.verbatim !== undefined && !this.verbatim.done;
    if (!this.toolReplyWaiting || verbatimPending || this.openResponseIds.size > 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    this.toolReplyWaiting = false;
    const eventId = `banjo_tool_reply_${++this.toolReplySeq}`;
    this.toolReplyEventIds.add(eventId);
    for (const old of this.toolReplyEventIds) {
      if (this.toolReplyEventIds.size <= 20) break;
      this.toolReplyEventIds.delete(old);
    }
    this.ws.send(JSON.stringify({ type: 'response.create', event_id: eventId }));
  }

  /**
   * Prompts a reply to a tool result only if the response that called the
   * tool said nothing, deciding once that response is done. A response still
   * open can't take another response.create, and one that spoke (usually the
   * next question, alongside record_answer) needs no second turn (#148 review r2).
   */
  private respondIfSilent(toolCallId: string): void {
    const responseId = this.callResponseIds.get(toolCallId);
    this.callResponseIds.delete(toolCallId);
    const decide = () => {
      if (responseId !== undefined && this.spokenResponseIds.has(responseId)) return;
      this.promptToolReply();
    };
    if (responseId !== undefined && this.openResponseIds.has(responseId)) {
      this.afterResponseDone.set(responseId, [...(this.afterResponseDone.get(responseId) ?? []), decide]);
    } else {
      decide();
    }
  }

  interrupt(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // NEEDS VERIFICATION (see file header, item 6): exact cancel-event name.
    this.ws.send(JSON.stringify({ type: 'response.cancel' }));
  }

  triggerResponse(cue?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // The telephony 'connected' event (which calls this for an inbound
      // greeting) can race voiceAI.connect() — Twilio's Media Stream WS
      // needs an HTTP round-trip + its own dial-back + a second WS
      // handshake before it fires, while this WS only needs one handshake,
      // so connect() should usually win, but "usually" isn't a guarantee.
      // Queue it instead of silently dropping it, so the greeting still
      // fires once the connection actually opens.
      this.pendingTriggerResponse = { cue };
      return;
    }
    // Same message sendToolResult() already sends after a tool result
    // (line ~232) — CONFIRMED working in this codebase, just fired here
    // with no prior tool result, to make the model speak first.
    this.ws.send(JSON.stringify(responseCreate(cue)));
  }

  /**
   * Hold on or off (#151). Server VAD keeps detecting and committing turns, so
   * the other side is still transcribed, but `create_response: false` stops the
   * model answering them and `interrupt_response: false` stops them cutting
   * anything off. audio.input is resent whole, since only turn_detection should
   * change. In text-only mode there's no audio: sendUserText() holds instead.
   */
  setHold(onHold: boolean): void {
    this.onHold = onHold;
    if (this.textOnly || !this.audioInput || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          audio: {
            input: { ...this.audioInput, turn_detection: { type: 'server_vad', create_response: !onHold, interrupt_response: !onHold } },
          },
        },
      }),
    );
  }

  /**
   * An out-of-band, text-only response (#151): `conversation: 'none'` keeps it
   * and its input out of the call's conversation, and no audio is made, so the
   * other party hears nothing. It runs alongside the call's own responses.
   */
  judgeHoldLine(line: string, earlier: string[]): Promise<HoldVerdict> {
    return this.outOfBandCheck('hold-check', HOLD_CHECK_INSTRUCTIONS, holdCheckInput(line, earlier)).then(holdVerdict);
  }

  /** Who answered (#187): the same out-of-band check, with its own instructions. */
  judgeFirstLine(line: string, earlier: string[]): Promise<AnswerVerdict> {
    return this.outOfBandCheck('answer-check', ANSWER_CHECK_INSTRUCTIONS, answerCheckInput(line, earlier)).then(answerVerdict);
  }

  /** One out-of-band, one-word judgment; resolves its text, or undefined if it failed or timed out. */
  private outOfBandCheck(kind: string, instructions: string, input: string): Promise<string | undefined> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(undefined);
    const id = `${kind}-${++this.holdCheckSeq}`;
    const result = new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.holdChecks.delete(id);
        log.warn({ id }, 'out-of-band check timed out');
        resolve(undefined);
      }, HOLD_CHECK_TIMEOUT_MS);
      this.holdChecks.set(id, (text) => {
        clearTimeout(timer);
        this.holdChecks.delete(id);
        resolve(text);
      });
    });
    this.ws.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          conversation: 'none',
          output_modalities: ['text'],
          // The line is the other party's words: the judgment must not be able to act on them.
          tools: [],
          tool_choice: 'none',
          metadata: { banjo_hold_check: id },
          instructions,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }],
        },
      }),
    );
    return result;
  }

  /**
   * Adds lines to the conversation without prompting a reply (#151). The other
   * party's words go in as a user message, never as instructions, and the
   * session's instructions stay in force for the reply that follows.
   */
  addContext(items: { role: 'system' | 'user'; text: string }[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const { role, text } of items) {
      this.ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role, content: [{ type: 'input_text', text }] } }));
    }
  }

  sayVerbatim(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn({ textLength: text.length }, 'sayVerbatim called with no open connection — message was dropped');
      return;
    }
    this.verbatim = { text, spoken: [], done: false };
    this.flushVerbatim();
  }

  /** What the latest sayVerbatim() response said, from its own transcript only; ends that delivery (#177). */
  verbatimDeliveryReport(): VerbatimDeliveryReport | undefined {
    const verbatim = this.verbatim;
    if (!verbatim) return undefined;
    this.verbatim = undefined;
    const spoken = verbatim.spoken.join(' ');
    // A reply to a tool result may have been held back for the message.
    this.flushToolReply();
    return { intended: verbatim.text, spoken, matched: verbatim.done && verbatimMatches(verbatim.text, spoken) };
  }

  /** Sends the queued verbatim message once no response is open (#177). */
  private flushVerbatim(): void {
    const verbatim = this.verbatim;
    if (!verbatim || verbatim.eventId !== undefined || this.openResponseIds.size > 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    verbatim.eventId = `banjo_verbatim_${++this.verbatimSeq}`;
    // response.create's `response` object OVERRIDES the session's
    // `instructions` for this one response only (CONFIRMED against OpenAI's
    // Realtime API docs, 2026-09-01: "These fields will override the
    // Session's configuration for this Response only"). The model is not
    // guaranteed to comply word-for-word — the docs are explicit that
    // instructions are guidance, not a hard constraint — but this is the
    // only mechanism the API offers for steering a specific response's
    // content; there is no separate text-to-speech bypass.
    this.ws.send(
      JSON.stringify({
        type: 'response.create',
        event_id: verbatim.eventId,
        response: {
          instructions: `Say exactly the following, word for word, and nothing else — no preamble, no additions, no acknowledgement: "${verbatim.text}"`,
          // No conversation history for this response (#198): with it, and its
          // own voicemail tool call still open, the model often said "I've left
          // a voicemail…" instead of the opener. The output still joins the
          // conversation (conversation stays "auto"), so later turns see it.
          // One line of input, not none (#214): an empty input failed with a
          // server_error, saying nothing, in 3 of 33 eval runs' responses.
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '(Say the message now.)' }] }],
          // Speech only (#214): with tools, one called leave_voicemail_and_end_call again instead.
          tool_choice: 'none',
          metadata: { banjo_verbatim: verbatim.eventId },
        },
      }),
    );
  }

  async disconnect(): Promise<void> {
    if (!this.ws) return;
    await new Promise<void>((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once('close', () => resolve());
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

  private emitEvent(event: VoiceAIEvent): void {
    this.emitter.emit('event', event);
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      log.warn({ err }, 'received non-JSON message from openai realtime ws');
      return;
    }

    const type: string | undefined = msg?.type;
    if (!type) return;

    switch (type) {
      // NEEDS VERIFICATION (see file header, item 4): exact audio delta event name.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const base64Audio: string | undefined = msg.delta;
        if (!base64Audio) return;
        if (typeof msg.response_id === 'string') this.spokenResponseIds.add(msg.response_id);
        this.emitEvent({
          type: 'audio_chunk',
          chunk: {
            data: Buffer.from(base64Audio, 'base64'),
            sampleRate: this.outputSampleRate, // rate negotiated in session.audio.output.format at connect()
          },
        });
        return;
      }

      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta': {
        if (this.outOfBandResponseIds.has(msg.response_id)) return;
        if (typeof msg.delta === 'string') {
          if (msg.delta.trim() && typeof msg.response_id === 'string') this.spokenResponseIds.add(msg.response_id);
          this.emitEvent({ type: 'transcript', role: 'assistant', text: msg.delta, isFinal: false });
        }
        return;
      }

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done': {
        if (typeof msg.transcript === 'string') {
          this.recordVerbatimSpeech(msg.response_id, msg.transcript);
          this.emitEvent({ type: 'transcript', role: 'assistant', text: msg.transcript, isFinal: true });
        }
        return;
      }

      // Text-only mode's replies: the same assistant transcript, with no audio behind it.
      case 'response.output_text.done': {
        if (this.outOfBandResponseIds.has(msg.response_id)) return;
        if (typeof msg.text === 'string') {
          this.recordVerbatimSpeech(msg.response_id, msg.text);
          this.emitEvent({ type: 'transcript', role: 'assistant', text: msg.text, isFinal: true });
        }
        return;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        // On hold (#151): the turn has done its job once transcribed. Left in
        // the conversation, a long hold's audio would fill the context and be
        // paid for as input on the first reply after it.
        if (this.onHold && typeof msg.item_id === 'string') {
          this.ws?.send(JSON.stringify({ type: 'conversation.item.delete', item_id: msg.item_id }));
        }
        if (typeof msg.transcript === 'string') {
          this.emitEvent({ type: 'transcript', role: 'user', text: msg.transcript, isFinal: true });
        }
        return;
      }

      // Marks a hold judgment's response as out-of-band (#151), by the id in
      // its metadata, before any of its text arrives.
      case 'response.created': {
        if (typeof msg.response?.metadata?.banjo_hold_check === 'string' && typeof msg.response.id === 'string') {
          this.outOfBandResponseIds.add(msg.response.id);
        } else if (typeof msg.response?.id === 'string') {
          this.openResponseIds.add(msg.response.id);
          const verbatim = this.verbatim;
          if (verbatim?.eventId !== undefined && msg.response.metadata?.banjo_verbatim === verbatim.eventId) verbatim.responseId = msg.response.id;
        }
        return;
      }

      // Accumulate function-call argument deltas keyed by call id.
      // NEEDS VERIFICATION (see file header, item 5).
      case 'response.function_call_arguments.delta': {
        // A hold judgment never runs a tool, whatever the line it judged said (#151).
        if (this.outOfBandResponseIds.has(msg.response_id)) return;
        const callId: string | undefined = msg.call_id;
        if (!callId) return;
        const existing = this.pendingCalls.get(callId);
        if (existing) {
          existing.argsBuffer += msg.delta ?? '';
        } else {
          this.pendingCalls.set(callId, {
            callId,
            name: msg.name ?? 'unknown_tool',
            argsBuffer: msg.delta ?? '',
          });
        }
        return;
      }

      case 'response.function_call_arguments.done': {
        if (this.outOfBandResponseIds.has(msg.response_id)) return;
        const callId: string | undefined = msg.call_id;
        if (!callId) return;
        if (typeof msg.response_id === 'string') this.callResponseIds.set(callId, msg.response_id);
        const pending = this.pendingCalls.get(callId);
        const argsStr = msg.arguments ?? pending?.argsBuffer ?? '{}';
        const name = msg.name ?? pending?.name ?? 'unknown_tool';
        this.emitToolCall(callId, name, argsStr, msg);
        this.pendingCalls.delete(callId);
        return;
      }

      case 'response.done': {
        this.addUsage(msg?.response?.usage);
        const holdCheck = msg?.response?.metadata?.banjo_hold_check;
        if (typeof holdCheck === 'string') {
          this.outOfBandResponseIds.delete(msg.response.id);
          this.holdChecks.get(holdCheck)?.(outputText(msg.response));
          return;
        }
        // Fallback path: scan response.output for function_call items in
        // case response.function_call_arguments.done wasn't (or isn't)
        // emitted per-call. emittedCallIds guards against double-emitting.
        const responseId: string | undefined = typeof msg?.response?.id === 'string' ? msg.response.id : undefined;
        const outputs: any[] = msg?.response?.output ?? [];
        for (const item of outputs) {
          if (item?.type === 'function_call' && item.call_id) {
            if (responseId && !this.callResponseIds.has(item.call_id)) this.callResponseIds.set(item.call_id, responseId);
            this.emitToolCall(item.call_id, item.name ?? 'unknown_tool', item.arguments ?? '{}', item);
          }
        }
        const verbatim = this.verbatim;
        const isVerbatim = responseId !== undefined && verbatim?.responseId === responseId;
        if (isVerbatim) verbatim.done = true;
        this.emitEvent(isVerbatim ? { type: 'turn_end', verbatim: true } : { type: 'turn_end' });
        if (responseId) {
          this.openResponseIds.delete(responseId);
          const waiting = this.afterResponseDone.get(responseId) ?? [];
          this.afterResponseDone.delete(responseId);
          for (const decide of waiting) decide();
          this.flushVerbatim();
          this.flushToolReply();
          // Only recent responses: a tool result asks about its own, moments later.
          for (const old of this.spokenResponseIds) {
            if (this.spokenResponseIds.size <= 50) break;
            this.spokenResponseIds.delete(old);
          }
        }
        return;
      }

      case 'input_audio_buffer.speech_started': {
        // Caller started talking while the model may be speaking — treat as barge-in.
        this.emitEvent({ type: 'interrupted' });
        return;
      }

      case 'error': {
        const errPayload = msg.error ?? {};
        // Our tool result's prompt lost a race with a response the server had
        // just started (e.g. a reply to the other party): prompt again once
        // that one is done, rather than leave the result with no reply.
        if (errPayload.code === 'conversation_already_has_active_response' && this.toolReplyEventIds.delete(errPayload.event_id)) {
          this.toolReplyWaiting = true;
          return;
        }
        // The same race for a verbatim message (#177): send it again once that response is done.
        const verbatim = this.verbatim;
        if (errPayload.code === 'conversation_already_has_active_response' && verbatim && errPayload.event_id !== undefined && verbatim.eventId === errPayload.event_id) {
          verbatim.eventId = undefined;
          return;
        }
        this.emitEvent({
          type: 'error',
          error: new VoiceAIError(errPayload.message ?? 'Unknown OpenAI Realtime error', true, errPayload.code),
        });
        return;
      }

      default:
        // Unhandled event types are expected (session.updated, rate_limits.updated, etc.) — ignore silently.
        return;
    }
  }

  private recordVerbatimSpeech(responseId: unknown, text: string): void {
    if (this.verbatim?.responseId !== undefined && responseId === this.verbatim.responseId) this.verbatim.spoken.push(text);
  }

  private emitToolCall(callId: string, name: string, argsStr: string, raw: unknown): void {
    if (this.emittedCallIds.has(callId)) return;
    this.emittedCallIds.add(callId);
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
