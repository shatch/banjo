/**
 * ElevenLabs Conversational AI adapter.
 *
 * ============================================================================
 * CONFIRMED-ISH vs NEEDS VERIFICATION
 * ============================================================================
 * These protocol details are more concrete than the Gemini sketch (ElevenLabs'
 * Conversational AI WebSocket protocol is reasonably well-documented), but
 * should still be re-verified against current docs before production use:
 *   - Session starts with a `conversation_initiation_client_data` message
 *     carrying agent overrides / dynamic variables.
 *   - Inbound (client -> server) audio is sent as
 *     `{ user_audio_chunk: <base64> }`.
 *   - Outbound (server -> client) audio arrives as `audio` events carrying a
 *     base64 chunk plus an `is_final`-ish flag — the exact nested field path
 *     (sketched below as `event.audio_event.audio_base_64` /
 *     `event.audio_event.event_id`, mirroring the documented "audio" event
 *     shape) needs verification.
 *   - Supported audio formats include PCM at several sample rates as well as
 *     `ulaw_8000` — negotiated via `conversation_config_override` /
 *     `audio_interface` fields at conversation-init time. The exact field
 *     names for declaring input vs output format NEED VERIFICATION.
 *   - Tool calls: ElevenLabs' primary "client tool" pattern is
 *     `client_tool_call` (the server asks the WS client — i.e. us — to
 *     execute the tool) paired with a `client_tool_result` reply. The exact
 *     nested field names (sketched as `client_tool_call.tool_call_id`,
 *     `.tool_name`, `.parameters`) NEED VERIFICATION.
 *   - The exact WebSocket URL and query params (sketched as
 *     `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...`) NEED
 *     VERIFICATION, in particular whether auth is via query param, an
 *     `xi-api-key` header, or a signed-URL fetched via a separate REST call
 *     (ElevenLabs supports a "get signed URL" flow for private agents).
 *   - The exact interrupt/barge-in signal (sketched as sending nothing —
 *     ElevenLabs is documented to detect user speech server-side via VAD and
 *     emit its own `interruption` event) NEEDS VERIFICATION as to whether a
 *     client-sent cancel message exists/is required.
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

const log = childLogger({ module: 'voice.provider.elevenlabs' });

/** Maps our vendor-agnostic audio format enum to ElevenLabs' format strings. NEEDS VERIFICATION. */
function toElevenLabsAudioFormat(format: VoiceAIAudioFormat): string {
  switch (format) {
    case 'g711_ulaw_8k':
      return 'ulaw_8000';
    case 'pcm16_8k':
      return 'pcm_8000';
    case 'pcm16_16k':
      return 'pcm_16000';
    case 'pcm16_24k':
      return 'pcm_24000';
    default: {
      const exhaustive: never = format;
      throw new Error(`Unsupported audio format for ElevenLabs: ${String(exhaustive)}`);
    }
  }
}

function toElevenLabsToolDeclarations(tools: ToolDefinition[]): unknown[] {
  // ElevenLabs' client-tools declaration shape — NEEDS VERIFICATION.
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export class ElevenLabsProvider implements VoiceAIProvider {
  readonly name = 'elevenlabs';

  private ws: WebSocket | undefined;
  private emitter = new EventEmitter();

  connect(sessionConfig: VoiceAISessionConfig): Promise<void> {
    const apiKey = config.ELEVENLABS_API_KEY;
    const agentId = config.ELEVENLABS_AGENT_ID;
    if (!apiKey || !agentId) {
      throw new Error('ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are required but VOICE_AI_PROVIDER=elevenlabs');
    }

    // NEEDS VERIFICATION: exact URL/auth mechanism. Sketched as agent_id
    // query param + xi-api-key header, which is the pattern ElevenLabs
    // documents for their non-signed-URL (private agent, server-side)
    // WebSocket flow.
    const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          'xi-api-key': apiKey,
        },
      });
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        try {
          // NEEDS VERIFICATION: exact conversation_initiation_client_data shape.
          ws.send(
            JSON.stringify({
              type: 'conversation_initiation_client_data',
              conversation_config_override: {
                agent: {
                  prompt: { prompt: sessionConfig.instructions },
                  language: sessionConfig.languageHint,
                },
                tts: sessionConfig.voice ? { voice_id: sessionConfig.voice } : undefined,
              },
              // NEEDS VERIFICATION: exact field names for negotiating audio
              // format at conversation-init time.
              audio_interface: {
                input_format: toElevenLabsAudioFormat(sessionConfig.inputAudioFormat),
                output_format: toElevenLabsAudioFormat(sessionConfig.outputAudioFormat),
              },
              client_tools: toElevenLabsToolDeclarations(sessionConfig.tools),
            }),
          );
        } catch (err) {
          log.error({ err }, 'failed to send conversation_initiation_client_data');
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
        log.error({ err }, 'elevenlabs ws error');
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
        user_audio_chunk: chunk.data.toString('base64'),
      }),
    );
  }

  sendToolResult(toolCallId: string, result: unknown, isError?: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // NEEDS VERIFICATION: exact client_tool_result shape/field names.
    this.ws.send(
      JSON.stringify({
        type: 'client_tool_result',
        tool_call_id: toolCallId,
        result: isError ? JSON.stringify({ error: true, ...safeResultObject(result) }) : JSON.stringify(result),
        is_error: !!isError,
      }),
    );
  }

  interrupt(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // NEEDS VERIFICATION: ElevenLabs is documented to detect user speech
    // server-side via VAD and emit its own `interruption` event; no
    // confirmed client-initiated cancel message is known. Left as a no-op
    // beyond logging, rather than guessing at a message that may not exist
    // and could error the connection.
    log.debug('interrupt() called on ElevenLabsProvider — no confirmed client-initiated cancel message exists; relying on server-side VAD barge-in detection.');
  }

  triggerResponse(): void {
    // NEEDS VERIFICATION: elevenlabs is not the active provider
    // (VOICE_AI_PROVIDER=openai) — the greeting-first fix was only
    // verified against a live OpenAI call. Left as a stub consistent with
    // this file's existing NEEDS VERIFICATION posture rather than guessing
    // at a message shape untested against the real API.
    log.debug('triggerResponse() called on ElevenLabsProvider — NEEDS VERIFICATION, not the active provider.');
  }

  sayVerbatim(text: string): void {
    // NEEDS VERIFICATION: elevenlabs is not the active provider. No
    // confirmed mechanism for a one-off forced-response override (the
    // OpenAI equivalent is response.create.response.instructions) is known
    // for ElevenLabs Conversational AI — left as a logged no-op rather than
    // guessing at a message shape untested against the real API.
    log.debug({ textLength: text.length }, 'sayVerbatim() called on ElevenLabsProvider — NEEDS VERIFICATION, not the active provider.');
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
      log.warn({ err }, 'received non-JSON message from elevenlabs ws');
      return;
    }

    const type: string | undefined = msg?.type;
    if (!type) return;

    switch (type) {
      case 'conversation_initiation_metadata': {
        // Ack of conversation init — connection already reported as 'connected' on open.
        return;
      }

      case 'audio': {
        // NEEDS VERIFICATION: exact nested field path for the base64 chunk.
        const base64Audio: string | undefined = msg.audio_event?.audio_base_64 ?? msg.audio_event?.audio_base64;
        if (!base64Audio) return;
        this.emitEvent({
          type: 'audio_chunk',
          chunk: {
            data: Buffer.from(base64Audio, 'base64'),
            sampleRate: 16000, // Best-effort default; actual rate depends on negotiated audio_interface.output_format.
          },
        });
        return;
      }

      case 'user_transcript': {
        const text: string | undefined = msg.user_transcription_event?.user_transcript;
        if (typeof text === 'string') {
          this.emitEvent({ type: 'transcript', role: 'user', text, isFinal: true });
        }
        return;
      }

      case 'agent_response': {
        const text: string | undefined = msg.agent_response_event?.agent_response;
        if (typeof text === 'string') {
          this.emitEvent({ type: 'transcript', role: 'assistant', text, isFinal: true });
        }
        return;
      }

      case 'interruption': {
        this.emitEvent({ type: 'interrupted' });
        return;
      }

      // Primary ElevenLabs client-tool pattern: the server asks us (the WS
      // client) to execute a tool locally. NEEDS VERIFICATION: exact nested
      // field names.
      case 'client_tool_call': {
        const payload = msg.client_tool_call ?? {};
        const call: NormalizedToolCall = {
          id: payload.tool_call_id ?? `elevenlabs-call-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: payload.tool_name ?? 'unknown_tool',
          arguments: (payload.parameters ?? {}) as Record<string, unknown>,
          rawVendorEvent: msg,
        };
        this.emitEvent({ type: 'tool_call', call });
        return;
      }

      case 'ping': {
        // ElevenLabs sends periodic pings expecting a pong with the same event_id — handled at the transport
        // level if needed; not modeled as a VoiceAIEvent since it's not conversation-relevant.
        const eventId = msg.ping_event?.event_id;
        if (eventId !== undefined && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'pong', event_id: eventId }));
        }
        return;
      }

      case 'error': {
        this.emitEvent({
          type: 'error',
          error: new VoiceAIError(msg.message ?? msg.error?.message ?? 'Unknown ElevenLabs error', true),
        });
        return;
      }

      default:
        // Unhandled event types are expected (e.g. vad_score, internal_tentative_agent_response) — ignore silently.
        return;
    }
  }
}

function safeResultObject(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object') return result as Record<string, unknown>;
  return { value: result };
}
