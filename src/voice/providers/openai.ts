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
  AudioChunk,
  NormalizedToolCall,
  ToolDefinition,
  VoiceAIAudioFormat,
  VoiceAIEvent,
  VoiceAIEventListener,
  VoiceAIProvider,
  VoiceAISessionConfig,
} from '../types.js';
import { VoiceAIError } from '../types.js';

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

interface PendingFunctionCall {
  callId: string;
  name: string;
  argsBuffer: string;
}

export class OpenAIRealtimeProvider implements VoiceAIProvider {
  readonly name = 'openai';

  private ws: WebSocket | undefined;
  private emitter = new EventEmitter();
  private pendingCalls = new Map<string, PendingFunctionCall>();
  /** Tracks function_call ids we've already emitted a tool_call for, so response.done doesn't double-emit. */
  private emittedCallIds = new Set<string>();
  /** The rate we negotiated for output audio (session.audio.output.format.rate) — used to tag emitted audio_chunks correctly instead of assuming a fixed rate. */
  private outputSampleRate = 24000;
  private pendingTriggerResponse = false;

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
                  input: {
                    format: toOpenAIAudioFormat(sessionConfig.inputAudioFormat),
                    transcription: { model: 'gpt-4o-mini-transcribe' },
                  },
                  output: { format: outputFormat, voice: sessionConfig.voice },
                },
              },
            }),
          );
        } catch (err) {
          log.error({ err }, 'failed to send initial session.update');
        }
        this.emitEvent({ type: 'connected' });
        if (this.pendingTriggerResponse) {
          this.pendingTriggerResponse = false;
          ws.send(JSON.stringify({ type: 'response.create' }));
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
        log.error({ err }, 'openai realtime ws error');
        this.emitEvent({ type: 'error', error: new VoiceAIError(err.message, true) });
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

  sendToolResult(toolCallId: string, result: unknown, isError?: boolean): void {
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
    // Prompt the model to continue now that it has the tool result.
    this.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  interrupt(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // NEEDS VERIFICATION (see file header, item 6): exact cancel-event name.
    this.ws.send(JSON.stringify({ type: 'response.cancel' }));
  }

  triggerResponse(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // The telephony 'connected' event (which calls this for an inbound
      // greeting) can race voiceAI.connect() — Twilio's Media Stream WS
      // needs an HTTP round-trip + its own dial-back + a second WS
      // handshake before it fires, while this WS only needs one handshake,
      // so connect() should usually win, but "usually" isn't a guarantee.
      // Queue it instead of silently dropping it, so the greeting still
      // fires once the connection actually opens.
      this.pendingTriggerResponse = true;
      return;
    }
    // Same message sendToolResult() already sends after a tool result
    // (line ~232) — CONFIRMED working in this codebase, just fired here
    // with no prior tool result, to make the model speak first.
    this.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  sayVerbatim(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn({ textLength: text.length }, 'sayVerbatim called with no open connection — message was dropped');
      return;
    }
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
        response: {
          instructions: `Say exactly the following, word for word, and nothing else — no preamble, no additions, no acknowledgement: "${text}"`,
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
      case 'response.output_audio_transcript.delta': {
        if (typeof msg.delta === 'string') {
          this.emitEvent({ type: 'transcript', role: 'assistant', text: msg.delta, isFinal: false });
        }
        return;
      }

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done': {
        if (typeof msg.transcript === 'string') {
          this.emitEvent({ type: 'transcript', role: 'assistant', text: msg.transcript, isFinal: true });
        }
        return;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        if (typeof msg.transcript === 'string') {
          this.emitEvent({ type: 'transcript', role: 'user', text: msg.transcript, isFinal: true });
        }
        return;
      }

      // Accumulate function-call argument deltas keyed by call id.
      // NEEDS VERIFICATION (see file header, item 5).
      case 'response.function_call_arguments.delta': {
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
        const callId: string | undefined = msg.call_id;
        if (!callId) return;
        const pending = this.pendingCalls.get(callId);
        const argsStr = msg.arguments ?? pending?.argsBuffer ?? '{}';
        const name = msg.name ?? pending?.name ?? 'unknown_tool';
        this.emitToolCall(callId, name, argsStr, msg);
        this.pendingCalls.delete(callId);
        return;
      }

      case 'response.done': {
        // Fallback path: scan response.output for function_call items in
        // case response.function_call_arguments.done wasn't (or isn't)
        // emitted per-call. emittedCallIds guards against double-emitting.
        const outputs: any[] = msg?.response?.output ?? [];
        for (const item of outputs) {
          if (item?.type === 'function_call' && item.call_id) {
            this.emitToolCall(item.call_id, item.name ?? 'unknown_tool', item.arguments ?? '{}', item);
          }
        }
        this.emitEvent({ type: 'turn_end' });
        return;
      }

      case 'input_audio_buffer.speech_started': {
        // Caller started talking while the model may be speaking — treat as barge-in.
        this.emitEvent({ type: 'interrupted' });
        return;
      }

      case 'error': {
        const errPayload = msg.error ?? {};
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
