import type { CalendarProvider } from '../calendar/types.js';
import type { Contact } from '../contacts/schema.js';
import { getContact } from '../contacts/service.js';
import type { CallSessionOptions } from '../session/callSession.js';
import type { CallContext } from '../session/types.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { buildOutcomeSummary, withDisclosureNote } from '../notifications/channel.js';
import type { DisclosureResult } from '../session/disclosure.js';
import { createNotificationChannel } from '../notifications/owner.js';
import { pressDigitsTool } from '../telephony/dtmf.js';
import type { TelephonyProvider } from '../telephony/providers/types.js';
import { callTools, endConversationCallTool } from '../voice/tools/callTools.js';
import type { VoiceTool } from '../voice/tools/defineVoiceTool.js';
import { unregisterLiveCall } from './liveCalls.js';
import { getTask, isTerminalStatus, transitionTask, updateCallAttempt } from './service.js';
import type { CallAttempt, Task } from './schema.js';
import { saveTranscriptTurn } from '../transcripts/service.js';

/**
 * Fires the outcome notification for a task that has reached a terminal
 * status. Extracted from the CallSessionOptions closure so the stale-call
 * sweep can notify too — a task whose process died mid-call has no session
 * left to do it, which is exactly why those failures used to be silent.
 */
export async function notifyTaskOutcome(taskId: string, disclosure?: DisclosureResult): Promise<void> {
  const current = await getTask(taskId);
  if (!current || !current.outcome || !isTerminalStatus(current.status)) return;
  const contact = await getContact(current.contactId);
  if (!contact) return;
  const summary = withDisclosureNote(buildOutcomeSummary(contact, current.outcome), disclosure);
  await createNotificationChannel().notify(current.id, current.outcome, summary);
}

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
  frontendSystemPrompt?: string;
}): CallSessionOptions<CallContext> {
  const { task, callAttempt, contact, telephony, calendar, systemPrompt, frontendSystemPrompt } = params;

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
  //
  // transitionTask would refuse this write on a terminal task by itself; the
  // read first keeps the normal case (the call ending after an outcome tool
  // already ran) from logging transitionTask's ignored-transition warning.
  async function failTaskIfStillNonTerminal(reason: string): Promise<void> {
    const current = await getTask(task.id);
    if (current && !isTerminalStatus(current.status)) {
      await transitionTask(task.id, 'failed', { outcome: { kind: 'failed', reason } });
    }
  }

  // Set when the call ends, read by notifyIfTerminal right after (#8).
  let disclosure: DisclosureResult | undefined;
  const recordDisclosure = (result: DisclosureResult): DisclosureResult => {
    if (result === 'missed') {
      logger.warn({ taskId: task.id, callAttemptId: callAttempt.id }, "call did not open by saying it's an AI");
    }
    return result;
  };

  return {
    callId: callAttempt.id,
    telephony,
    systemPrompt,
    frontendSystemPrompt,
    tools: outboundToolsFor(task),
    // Outbound only: the notice that starts a recording is part of
    // DISCLOSURE_LINE, which only outbound calls open with (#8).
    recordCalls: config.RECORD_CALLS,

    async beginCall() {
      // No answering-machine detection (#32). Twilio's verdict misread a
      // person answering with a business greeting as a machine, nothing acted
      // on it, and it was billed per call. The model tells voicemail from a
      // person by listening. The provider still supports it
      // (answeringMachineDetection) if something ever needs the signal.
      return telephony.originateCall({
        to: contact.phoneNumber,
        callId: callAttempt.id,
      });
    },

    async buildToolContext(estimatedAudioDoneAt, verbatimDelivery): Promise<CallContext> {
      return {
        task: (await getTask(task.id)) ?? task, // re-fetch so tool handlers see the latest status
        callAttempt,
        callId: callAttempt.id, // OUR id — what TelephonyProvider methods are keyed by, not Twilio's CallSid
        telephony,
        calendar,
        estimatedAudioDoneAt,
        verbatimDelivery,
      };
    },

    async onTranscript(turn) {
      // No-op unless PERSIST_TRANSCRIPTS is on (#6).
      await saveTranscriptTurn({ callAttemptId: callAttempt.id }, turn);
    },

    async onStatusChange(patch) {
      switch (patch.kind) {
        case 'started':
          await updateCallAttempt(callAttempt.id, { providerCallId: patch.providerCallId });
          break;
        case 'answering_machine_detected':
          await updateCallAttempt(callAttempt.id, { answeredBy: patch.answeredBy });
          break;
        case 'recording_started':
          await updateCallAttempt(callAttempt.id, { recordingSid: patch.recordingId });
          break;
        case 'ended':
          // The call is genuinely over here — not when start() returned. See
          // the registerLiveCall comment in orchestrator.ts.
          unregisterLiveCall(task.id);
          disclosure = recordDisclosure(patch.disclosure);
          await updateCallAttempt(callAttempt.id, { status: 'ended', endedAt: new Date(), disclosed: disclosedColumn(patch.disclosure) });
          await failTaskIfStillNonTerminal(patch.reason);
          break;
        case 'failed':
          unregisterLiveCall(task.id);
          disclosure = recordDisclosure(patch.disclosure);
          await updateCallAttempt(callAttempt.id, {
            status: 'error',
            errorDetail: patch.reason,
            endedAt: new Date(),
            disclosed: disclosedColumn(patch.disclosure),
          });
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
      unregisterLiveCall(task.id);
      await failTaskIfStillNonTerminal(reason);
    },

    async notifyIfTerminal() {
      await notifyTaskOutcome(task.id, disclosure);
    },
  };
}

/** call_attempts.disclosed: true / false, or null when Banjo never spoke. */
function disclosedColumn(result: DisclosureResult): boolean | null {
  return result === 'no_speech' ? null : result === 'disclosed';
}
