import type { CalendarProvider } from '../calendar/types.js';
import type { Contact } from '../contacts/schema.js';
import { getContact } from '../contacts/service.js';
import type { CallSessionOptions } from '../session/callSession.js';
import type { CallContext } from '../session/types.js';
import { buildOutcomeSummary } from '../notifications/channel.js';
import { createNotificationChannel } from '../notifications/twilioSms.js';
import { pressDigitsTool } from '../telephony/dtmf.js';
import type { TelephonyProvider } from '../telephony/providers/types.js';
import { callTools, endConversationCallTool } from '../voice/tools/callTools.js';
import type { VoiceTool } from '../voice/tools/defineVoiceTool.js';
import { getTask, transitionTask, updateCallAttempt } from './service.js';
import type { CallAttempt, Task } from './schema.js';

const TERMINAL_TASK_STATUSES: Task['status'][] = [
  'confirmed',
  'voicemail_left',
  'negotiation_failed',
  'escalated',
  'conversation_completed',
  'failed',
];

/** All live-call tools for an outbound call, keyed by name — check_my_availability/confirm_appointment/etc.
 *  (backend-service tools) plus press_digits (telephony-layer, routed differently — see telephony/dtmf.ts).
 *  Conversation-mode tasks additionally get end_conversation_call — see docs/superpowers/specs/
 *  2026-08-12-outbound-conversational-call-design.md for why this is additive, not a separate restricted set. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function outboundToolsFor(task: Task): VoiceTool<any, CallContext>[] {
  const base: VoiceTool<any, CallContext>[] = [...callTools, pressDigitsTool];
  return task.mode === 'conversation' ? [...base, endConversationCallTool] : base;
}

/**
 * Reproduces exactly what CallSession used to do by importing
 * tasks/service.ts and contacts/service.ts directly, now routed through
 * CallSessionOptions's generic persistence seam — CallSession itself has
 * zero Task/CallAttempt/Contact coupling. Used by tasks/orchestrator.ts's
 * runTask(); a future src/inbound/callSessionAdapter.ts supplies the
 * equivalent for inbound calls.
 */
export function buildOutboundCallSessionOptions(params: {
  task: Task;
  callAttempt: CallAttempt;
  contact: Contact;
  telephony: TelephonyProvider;
  calendar: CalendarProvider;
  systemPrompt: string;
}): CallSessionOptions<CallContext> {
  const { task, callAttempt, contact, telephony, calendar, systemPrompt } = params;

  // Shared by onFailure and onStatusChange's 'ended' case below: if the call
  // is over and the task never reached a terminal status, nothing else will
  // ever move it forward (no auto-retry in v1) — mark it failed rather than
  // leaving it silently stuck. onFailure already covered this for
  // voice-AI/telephony *errors* (CallSession.fail()); it was missing for the
  // far more common case of a call simply ending — the far end hanging up,
  // or the media-stream socket closing — *before* the model ever called an
  // outcome tool (CallSession.end(), reached via the telephony 'ended'/
  // voice-AI 'disconnected' events). That path only updated call_attempts,
  // so a dropped/short call left the task orphaned at whatever in-progress
  // status it was last in, with no outcome and no Steve notification
  // (notifyIfTerminal no-ops without an outcome) — caught via a live call
  // that hung up mid-conversation and stayed stuck at 'calling' indefinitely.
  async function failTaskIfStillNonTerminal(reason: string): Promise<void> {
    const current = await getTask(task.id);
    if (current && !TERMINAL_TASK_STATUSES.includes(current.status)) {
      await transitionTask(task.id, 'failed', { outcome: { kind: 'failed', reason } });
    }
  }

  return {
    callId: callAttempt.id,
    telephony,
    systemPrompt,
    tools: outboundToolsFor(task),

    async beginCall() {
      return telephony.originateCall({
        to: contact.phoneNumber,
        callId: callAttempt.id,
        answeringMachineDetection: true,
      });
    },

    async buildToolContext(estimatedAudioDoneAt: number): Promise<CallContext> {
      return {
        task: (await getTask(task.id)) ?? task, // re-fetch so tool handlers see the latest status
        callAttempt,
        callId: callAttempt.id, // OUR id — what TelephonyProvider methods are keyed by, not Twilio's CallSid
        telephony,
        calendar,
        estimatedAudioDoneAt,
      };
    },

    async onStatusChange(patch) {
      switch (patch.kind) {
        case 'started':
          await updateCallAttempt(callAttempt.id, { providerCallId: patch.providerCallId });
          break;
        case 'answering_machine_detected':
          await updateCallAttempt(callAttempt.id, { answeredBy: patch.answeredBy });
          break;
        case 'ended':
          await updateCallAttempt(callAttempt.id, { status: 'ended', endedAt: new Date() });
          await failTaskIfStillNonTerminal(patch.reason);
          break;
        case 'failed':
          await updateCallAttempt(callAttempt.id, { status: 'error', errorDetail: patch.reason, endedAt: new Date() });
          break;
        default: {
          // Exhaustiveness check: if CallSessionStatusPatch grows a new
          // `kind` without this switch being updated, this becomes a
          // compile-time error instead of a silently-ignored patch.
          const _exhaustive: never = patch;
          throw new Error(`Unhandled CallSessionStatusPatch kind: ${JSON.stringify(_exhaustive)}`);
        }
      }
    },

    async onFailure(reason: string) {
      await failTaskIfStillNonTerminal(reason);
    },

    async notifyIfTerminal() {
      const current = await getTask(task.id);
      if (!current || !current.outcome || !TERMINAL_TASK_STATUSES.includes(current.status)) return;
      const c = await getContact(current.contactId);
      if (!c) return;
      const summary = buildOutcomeSummary(c, current.outcome);
      await createNotificationChannel().notify(current.id, current.outcome, summary);
    },
  };
}
