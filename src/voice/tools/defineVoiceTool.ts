import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { CallContext } from '../../session/types.js';
import type { ToolDefinition } from '../types.js';

/**
 * A live-call tool's Zod schema is the single source of truth — converted to
 * JSON Schema once and injected identically into every VoiceAIProvider's
 * session config (each adapter may do a light reshape into its own envelope,
 * but the parameter schema itself is shared).
 */
export interface VoiceTool<TInput = unknown, TCtx = CallContext> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  handler: (input: TInput, ctx: TCtx) => Promise<unknown>;
  /**
   * Marks a tool that calls hangUpAfterSpeaking (voice/tools/callTools.ts).
   * CallSession waits for the current response to fully finish (the
   * 'turn_end' event) before snapshotting the audio-playback estimate for
   * these tools — the tool-call event can fire before trailing audio in the
   * same response has finished streaming, so snapshotting immediately can
   * miss it entirely and hang up mid-sentence.
   */
  endsCall?: boolean;
  /**
   * For a tool whose argument IS content meant to reach the other party
   * (e.g. a voicemail message) — extracts that text from the validated
   * input. When present, CallSession forces the model to speak this text
   * verbatim (VoiceAIProvider.sayVerbatim) and waits for it to finish BEFORE
   * the handler runs, so the recorded outcome and the audio actually
   * delivered come from the same source and cannot diverge. Reproduced live
   * without this: the model said a short preamble, then called
   * leave_voicemail_and_end_call with the real message as an argument that
   * was never itself spoken — the callee heard only the preamble. Omit for
   * tools whose argument (e.g. an escalation "reason") is metadata for
   * Steve, not content meant for the other party's ears.
   */
  verbatimMessage?: (input: TInput) => string;
}

export function defineVoiceTool<TInput, TCtx = CallContext>(spec: VoiceTool<TInput, TCtx>): VoiceTool<TInput, TCtx> {
  return spec;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toToolDefinition(tool: VoiceTool<any, any>): ToolDefinition {
  // target: 'openApi3' was tried first and is WRONG here — OpenAPI 3.0
  // schemas represent `.positive()`/exclusive bounds as a boolean flag
  // (`"exclusiveMinimum": true` alongside `"minimum": 0`), which is valid
  // OpenAPI but not valid JSON Schema. OpenAI's Realtime function-parameter
  // validator expects standard JSON Schema (numeric `exclusiveMinimum`) and
  // rejected the boolean with "True is not of type 'number'" on a live call.
  // 'jsonSchema7' produces the numeric form; $schema is meta-only and not
  // meaningful inside a function `parameters` object, so it's stripped.
  const { $schema: _schema, ...parameters } = zodToJsonSchema(tool.schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    parameters,
  };
}
