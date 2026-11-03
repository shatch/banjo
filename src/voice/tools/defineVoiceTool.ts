import { z } from 'zod';
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
   * For an endsCall tool that closes a normal call with a person (#102):
   * CallSession refuses it once if Banjo's latest line has no goodbye in it
   * (session/goodbye.ts), so the model says one and calls it again. If it
   * goes through with still no goodbye, CallSession says one itself (#139). Leave it
   * off where a goodbye may not fit: escalations (a phone menu, a hostile
   * caller), a voicemail (its message is verified separately) and a transfer.
   */
  requiresGoodbye?: boolean;
  /**
   * Runs before CallSession's checks can refuse the call (#102, #133), so
   * what the call carries is kept even when it's refused and the line then
   * drops (#148 review r2: report_answers_and_end_call's answers). Must be
   * safe to run again on a retry. A failure is logged and never stops the tool.
   */
  beforeChecks?: (input: TInput, ctx: TCtx) => Promise<void>;
  /**
   * For an endsCall tool that should give way when the other party starts
   * talking while Banjo is ending the call (#133): CallSession refuses it once,
   * without prompting Banjo to speak, so it hears them out. Set on the
   * requiresGoodbye tools. Leave it off the escalation tools (talking must
   * never hold up getting off the line with a hostile caller or a phone menu),
   * a voicemail (a reply already cuts its delivery off) and a transfer.
   */
  yieldsToCallee?: boolean;
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
   * Steve, not content meant for the other party's ears. Each string is its
   * own forced turn, spoken in order (#71: the voicemail's disclosure opener,
   * then its message).
   */
  verbatimMessage?: (input: TInput) => string[];
  /**
   * How long this tool's handler may run, for a tool whose work cannot be cut
   * off part-way (transfer_to_owner, telephony/transfer.ts: once its redirect
   * is sent, the call may already be with the principal). Such a handler is
   * not wrapped in runToolSafely's TOOL_TIMEOUT_MS, so CallSession's own
   * limits must allow for it instead: the tool-pending watchdog is re-armed
   * with this budget once any endsCall turn_end wait is over, and end()/fail()
   * keep waiting for the handler for that long (toolBudgetMs). Omit it and the
   * tool gets the default budget, as every tool did before (one benign change
   * for concurrent tool calls: the watchdog's first arm now clears any timer
   * already running and records the arming call as its owner, and only that
   * owner clears it or resumes 'active' when it finishes; while an endsCall
   * tool runs, no other tool call re-arms it). Ignored for a tool with
   * verbatimMessage, which has its own larger budget.
   */
  handlerBudgetMs?: number;
  /**
   * wait_on_hold (#151): once the handler succeeds, CallSession puts the call
   * on hold (VoiceAIProvider.setHold) and sends the result without prompting a
   * reply, so Banjo says nothing to the queue. Offered only where the voice
   * provider can hold.
   */
  startsHold?: boolean;
  /**
   * record_answer (#148 review r2): its result prompts a reply only if the
   * model said nothing alongside the call (VoiceAIProvider.sendToolResult's
   * respond: 'if-silent'). It usually asks its next question in that same
   * turn, and prompting another reply collided with it or talked over them.
   */
  replyOnlyIfSilent?: boolean;
  /**
   * note_follow_up, record_do_not_call (#251): its result prompts a reply unless
   * the model asked them something alongside the call (respond: 'unless-asked').
   * What's left to say comes after the tool, so a line before it, often a filler,
   * doesn't finish the turn. Takes precedence over replyOnlyIfSilent.
   */
  replyUnlessAsked?: boolean;
}

export function defineVoiceTool<TInput, TCtx = CallContext>(spec: VoiceTool<TInput, TCtx>): VoiceTool<TInput, TCtx> {
  return spec;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toToolDefinition(tool: VoiceTool<any, any>): ToolDefinition {
  // An OpenAPI 3.0 target was tried first and is WRONG here: it represents
  // `.positive()`/exclusive bounds as a boolean flag (`"exclusiveMinimum": true`
  // alongside `"minimum": 0`), which OpenAI's Realtime function-parameter
  // validator rejected on a live call ("True is not of type 'number'"). Draft 7
  // produces the numeric form. $schema is meta-only and not meaningful inside a
  // function `parameters` object, so it's stripped.
  // io 'output' keeps `additionalProperties: false` on objects.
  const { $schema: _schema, ...parameters } = tidySchema(z.toJSONSchema(tool.schema, { target: 'draft-7', io: 'output' })) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    parameters,
  };
}

/**
 * Keeps the JSON Schema the model sees exactly as it was before zod 4: no
 * `.int()` safe-integer bounds zod 4 adds on its own, and each `description`
 * last, as zod-to-json-schema wrote it. The model reads this as text, and the
 * eval recordings' fingerprints hash it, so a reordering is a real change.
 */
function tidySchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidySchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description') continue;
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'minimum' && value === Number.MIN_SAFE_INTEGER) continue;
    out[key] = tidySchema(value);
  }
  if ('description' in node) out.description = (node as { description: unknown }).description;
  return out;
}
