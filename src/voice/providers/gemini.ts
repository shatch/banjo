/**
 * Google Gemini Live API adapter.
 *
 * ============================================================================
 * NEEDS VERIFICATION — this entire file is a best-effort structural sketch.
 * ============================================================================
 * Unlike the OpenAI adapter (where the core event/field names are fairly
 * well-established), the exact wire protocol for Gemini Live is NOT
 * confirmed here and must be re-checked against the current
 * `google-genai`/Gemini Live API docs before this is trusted in production:
 *   - The exact WebSocket URL (sketched below as
 *     `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`
 *     with an `?key=` API key query param — the exact path, API version
 *     segment (v1alpha vs v1beta vs v1), and auth mechanism (query param vs
 *     header) all need verification).
 *   - The exact shape of the initial "setup" message. Sketched below as a
 *     `BidiGenerateContentSetup`-style envelope: `{ setup: { model,
 *     systemInstruction, tools, generationConfig: { responseModalities,
 *     speechConfig }, ... } }`.
 *   - The exact shape of function/tool declarations within `setup.tools`.
 *     Sketched as `{ functionDeclarations: [{ name, description,
 *     parameters }] }` (mirroring the general Gemini function-calling
 *     shape used elsewhere in the Gemini API).
 *   - The exact shape of inbound audio chunks. Sketched as
 *     `{ realtimeInput: { mediaChunks: [{ mimeType, data }] } }` for
 *     client -> server, mirroring the documented `realtimeInput` field
 *     name, but the exact nesting (`mediaChunks` vs `audio`) needs
 *     verification.
 *   - The exact shape of outbound (server -> client) messages: sketched as
 *     `{ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType,
 *     data } }] }, turnComplete, interrupted } }` for audio/turn signaling,
 *     and `{ toolCall: { functionCalls: [{ id, name, args }] } }` for tool
 *     invocation, with `{ toolResponse: { functionResponses: [{ id, name,
 *     response }] } }` as the client -> server reply.
 *   - Whether "cancel/interrupt" is a client-sent message at all, or purely
 *     server-driven (Gemini Live is documented as detecting barge-in
 *     server-side via VAD and emitting `interrupted` itself) — sketched
 *     below as a best-effort client-sent activity signal, but this may not
 *     be a real/needed message.
 *
 * What IS reasonably solid: Gemini Live hard-requires 16kHz PCM16 mono input
 * and produces 24kHz PCM16 mono output — there is no mu-law option, unlike
 * OpenAI/ElevenLabs. Any codec/resampling needed to satisfy this (e.g. from
 * telephony's native g711_ulaw_8k) must happen upstream, in
 * session/callSession.ts — this adapter only validates/warns that the
 * negotiated session config matches what Gemini Live actually accepts.
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

const log = childLogger({ module: 'voice.provider.gemini' });

const EXPECTED_INPUT_FORMAT: VoiceAIAudioFormat = 'pcm16_16k';
const EXPECTED_OUTPUT_FORMAT: VoiceAIAudioFormat = 'pcm16_24k';

/** Default model id — NEEDS VERIFICATION against the current Gemini Live model catalog. */
const DEFAULT_GEMINI_LIVE_MODEL = 'models/gemini-2.0-flash-live-001';

function toGeminiFunctionDeclarations(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export class GeminiLiveProvider implements VoiceAIProvider {
  readonly name = 'gemini';

  private ws: WebSocket | undefined;
  private emitter = new EventEmitter();

  connect(sessionConfig: VoiceAISessionConfig): Promise<void> {
    const apiKey = config.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured but VOICE_AI_PROVIDER=gemini');
    }
    const model = config.GEMINI_LIVE_MODEL ?? DEFAULT_GEMINI_LIVE_MODEL;

    if (sessionConfig.inputAudioFormat !== EXPECTED_INPUT_FORMAT) {
      log.warn(
        { requested: sessionConfig.inputAudioFormat, expected: EXPECTED_INPUT_FORMAT },
        'Gemini Live requires 16kHz PCM16 input — the requested inputAudioFormat does not match. ' +
          'Resampling must happen upstream in session/callSession.ts; proceeding anyway.',
      );
    }
    if (sessionConfig.outputAudioFormat !== EXPECTED_OUTPUT_FORMAT) {
      log.warn(
        { requested: sessionConfig.outputAudioFormat, expected: EXPECTED_OUTPUT_FORMAT },
        'Gemini Live produces 24kHz PCM16 output — the requested outputAudioFormat does not match. ' +
          'Resampling must happen upstream in session/callSession.ts; proceeding anyway.',
      );
    }

    // NEEDS VERIFICATION: exact URL path/version segment and auth mechanism (query param vs header).
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        try {
          // NEEDS VERIFICATION: exact `setup` message shape.
          ws.send(
            JSON.stringify({
              setup: {
                model,
                systemInstruction: {
                  parts: [{ text: sessionConfig.instructions }],
                },
                tools: [{ functionDeclarations: toGeminiFunctionDeclarations(sessionConfig.tools) }],
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: sessionConfig.voice
                    ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: sessionConfig.voice } } }
                    : undefined,
                },
              },
            }),
          );
        } catch (err) {
          log.error({ err }, 'failed to send initial gemini setup message');
        }
        this.emitEvent({ type: 'connected' });
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      ws.on('error', (err: Error) => {
        log.error({ err }, 'gemini live ws error');
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
    // NEEDS VERIFICATION: exact realtimeInput/mediaChunks shape.
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [
            {
              mimeType: `audio/pcm;rate=${chunk.sampleRate}`,
              data: chunk.data.toString('base64'),
            },
          ],
        },
      }),
    );
  }

  sendToolResult(toolCallId: string, result: unknown, isError?: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const response = isError ? { error: true, ...safeResultObject(result) } : safeResultObject(result);
    // NEEDS VERIFICATION: exact toolResponse/functionResponses shape.
    this.ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [
            {
              id: toolCallId,
              response,
            },
          ],
        },
      }),
    );
  }

  interrupt(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // NEEDS VERIFICATION: Gemini Live is documented to detect barge-in
    // server-side via VAD and emit its own `interrupted` signal; it's
    // unclear whether a client-initiated cancel message exists/is needed.
    // Sketching a best-effort activity-end signal so this method isn't a
    // silent no-op if such a message does exist.
    try {
      this.ws.send(JSON.stringify({ clientContent: { turnComplete: false } }));
    } catch (err) {
      log.warn({ err }, 'failed to send gemini interrupt signal');
    }
  }

  triggerResponse(): void {
    // NEEDS VERIFICATION: gemini is not the active provider
    // (VOICE_AI_PROVIDER=openai) — the greeting-first fix was only
    // verified against a live OpenAI call. Left as a stub consistent with
    // this file's existing NEEDS VERIFICATION posture rather than guessing
    // at a message shape untested against the real API.
    log.debug('triggerResponse() called on GeminiLiveProvider — NEEDS VERIFICATION, not the active provider.');
  }

  sayVerbatim(text: string): void {
    // NEEDS VERIFICATION: gemini is not the active provider. Sketched as a
    // clientContent turn carrying the forced instruction as user-role text,
    // mirroring the general Gemini Live pattern for injecting content — the
    // exact mechanism for a one-off instructions override (equivalent to
    // OpenAI's response.create.response.instructions) is unconfirmed.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    log.debug({ textLength: text.length }, 'sayVerbatim() called on GeminiLiveProvider — NEEDS VERIFICATION, not the active provider.');
    try {
      this.ws.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: `Say exactly the following, word for word, and nothing else: "${text}"` }] }],
            turnComplete: true,
          },
        }),
      );
    } catch (err) {
      log.warn({ err }, 'failed to send gemini sayVerbatim message');
    }
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
      log.warn({ err }, 'received non-JSON message from gemini live ws');
      return;
    }

    // NEEDS VERIFICATION: all branches below are best-effort sketches of the
    // server -> client message shapes documented for Gemini Live.
    if (msg.setupComplete) {
      // Setup acknowledged; connection already reported as 'connected' on open.
      return;
    }

    if (msg.toolCall?.functionCalls) {
      for (const fc of msg.toolCall.functionCalls) {
        const call: NormalizedToolCall = {
          id: fc.id ?? `gemini-call-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: fc.name ?? 'unknown_tool',
          arguments: (fc.args ?? {}) as Record<string, unknown>,
          rawVendorEvent: fc,
        };
        this.emitEvent({ type: 'tool_call', call });
      }
      return;
    }

    if (msg.serverContent) {
      const sc = msg.serverContent;

      if (sc.interrupted) {
        this.emitEvent({ type: 'interrupted' });
      }

      const parts: any[] = sc.modelTurn?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          this.emitEvent({
            type: 'audio_chunk',
            chunk: {
              data: Buffer.from(part.inlineData.data, 'base64'),
              sampleRate: 24000, // Gemini Live output rate.
            },
          });
        }
        if (typeof part.text === 'string' && part.text.length > 0) {
          this.emitEvent({ type: 'transcript', role: 'assistant', text: part.text, isFinal: !!sc.turnComplete });
        }
      }

      if (sc.turnComplete) {
        this.emitEvent({ type: 'turn_end' });
      }
      return;
    }

    if (msg.error) {
      this.emitEvent({
        type: 'error',
        error: new VoiceAIError(msg.error.message ?? 'Unknown Gemini Live error', true, msg.error.code),
      });
      return;
    }

    // Unrecognized message shape — ignore rather than throw, since this
    // protocol sketch is not confirmed and vendor payloads may vary.
  }
}

function safeResultObject(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object') return result as Record<string, unknown>;
  return { value: result };
}
