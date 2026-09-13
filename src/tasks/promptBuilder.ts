import type { Contact } from '../contacts/schema.js';
import { config } from '../config/index.js';
import { buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance } from '../voice/systemPrompt.js';
import type { Task, TimeWindow } from './schema.js';

function formatWindows(windows: TimeWindow[]): string {
  if (windows.length === 0) return '(no pre-checked windows — always use check_my_availability before agreeing to a time)';
  return windows.map((w) => `${w.start} to ${w.end}`).join('; ');
}

function conversationModeGuidance(task: Task): string {
  if (task.mode !== 'conversation') return '';
  return `

This call has no booking or negotiation goal — it's a conversation: ${task.goalDescription}. Not having a
specific outcome to report is expected and fine; do not treat that as a reason to end the call quickly. Engage
naturally and stay on the call until the conversation actually reaches its own natural close — the other party
sounds done, or you've said what you called to say and there's nothing more to add — not the moment you've
delivered your opening line. If a specific time or booking need comes up naturally, you can still use
confirm_appointment/check_my_availability as usual. When the conversation is genuinely over, call
end_conversation_call with a short summary — this is the correct, successful way to end this call, even if
nothing specific was decided or accomplished. Do NOT use escalate_and_end_call or end_call to close out a normal
conversation that went fine — those mark the task as needing ${config.ASSISTANT_PRINCIPAL_NAME}'s follow-up, which would be wrong here.
escalate_and_end_call is still the right call if something genuinely goes wrong (hostile response, you can't
understand each other, you're truly stuck) — just not as a way to wrap up a conversation that went normally.`;
}

/**
 * Builds the call-specific system prompt injected into the VoiceAIProvider
 * session. The precomputed candidateWindows are an optimization/starting
 * point, not the source of truth — check_my_availability exists precisely so
 * the model isn't stuck if what the other party offers diverges from what
 * was computed minutes/hours earlier (stale calendar state, a slightly
 * different duration, etc).
 */
export function buildCallSystemPrompt(task: Task, contact: Contact, candidateWindows: TimeWindow[]): string {
  return `
${buildBaseSystemPromptGuidance()}

You are calling ${contact.displayName} on behalf of ${config.ASSISTANT_PRINCIPAL_NAME} to: ${task.goalDescription}.

Contact context: ${contact.notes ?? '(no notes on file)'}

You may offer or accept any of these times without checking back with anyone: ${formatWindows(candidateWindows)}.
If the other party offers a time outside these windows, call check_my_availability(date, time, durationMinutes)
to check live before agreeing — do not assume it's free or unavailable.

Once a specific time is agreed, call confirm_appointment with the confirmed start time and duration.
If you reach voicemail, call leave_voicemail_and_end_call with a concise, natural message (including a callback
number if one was given to you) as the message argument — the system speaks that message for you, verbatim,
before hanging up. Do not say the message yourself first; the callee would hear it twice.
If you reach a human who engages properly but no offered time fits the constraints (e.g. fully booked), call
report_negotiation_failed with a short reason.
If you get stuck — a confusing phone menu, a hostile or nonsensical response, or you genuinely cannot proceed —
call escalate_and_end_call with a short reason rather than guessing or looping indefinitely.
If you're navigating a phone menu, use press_digits to select the relevant option; if you've tried a couple of
options and still can't find a relevant one, escalate rather than keep guessing.${conversationModeGuidance(task)}
`.trim();
}

function conversationModeFrontendGuidance(task: Task): string {
  if (task.mode !== 'conversation') return '';
  return `

This call has no booking or negotiation goal — it's a conversation. Not having a specific outcome to report is
expected and fine; do not treat that as a reason to end the call quickly. Engage naturally and stay on the call
until the conversation reaches its own natural close — the other party sounds done, or you've said what you
called to say and there's nothing more to add — then say goodbye and immediately delegate ending the call. The
call does not end when you say goodbye; it ends only when your backend ends it.`;
}

/**
 * Voice-layer counterpart of buildCallSystemPrompt, for a VoiceAIProvider that
 * splits its voice front-end from a reasoning backend (openai-live — passed
 * through as VoiceAISessionConfig.frontendInstructions; every other provider
 * ignores it). The backend receives buildCallSystemPrompt's full prompt —
 * tools, candidate windows, timezone contract — so this carries only what the
 * voice needs to hold the conversation: who it is calling, why, and how to
 * sound.
 */
export function buildCallFrontendPrompt(task: Task, contact: Contact): string {
  return `
${buildFrontendSystemPromptGuidance()}

You are calling ${contact.displayName} on behalf of ${config.ASSISTANT_PRINCIPAL_NAME} to: ${task.goalDescription}.

Contact context: ${contact.notes ?? '(no notes on file)'}${conversationModeFrontendGuidance(task)}
`.trim();
}
