import type { CalendarProvider } from '../calendar/types.js';
import type { Contact } from '../contacts/schema.js';
import { getContact } from '../contacts/service.js';
import type { CallSessionOptions } from '../session/callSession.js';
import type { CallContext } from '../session/types.js';
import { config, disclosureLine, disclosureLineWithoutNotice } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { buildOutcomeSummary, withDisclosureNote, withSavedAnswers } from '../notifications/channel.js';
import type { DisclosureResult } from '../session/disclosure.js';
import { createNotificationChannel, sendOwnerMessage } from '../notifications/owner.js';
import { buildWebhookText, sendTaskWebhook } from '../notifications/webhook.js';
import { pressDigitsTool } from '../telephony/dtmf.js';
import type { TelephonyProvider } from '../telephony/providers/types.js';
import { defineTransferTool } from '../telephony/transfer.js';
import {
  bookingCallTools,
  commonCallTools,
  endConversationCallTool,
  recordAnswerTool,
  reportAnswersAndEndCallTool,
  waitOnHoldTool,
} from '../voice/tools/callTools.js';
import { modeRules } from './modes.js';
import { askOwnerTool } from '../ownerQuestions/tool.js';
import { canAskOwner } from '../voice/systemPrompt.js';
import type { VoiceTool } from '../voice/tools/defineVoiceTool.js';
import { unregisterLiveCall } from './liveCalls.js';
import { getTask, isTerminalStatus, transitionTask, updateCallAttempt } from './service.js';
import { collectedAnswersFor } from './answers.js';
import type { CallAttempt, Task } from './schema.js';
import { saveTranscriptTurn } from '../transcripts/service.js';

/**
 * Fires the outcome notification for a task that has reached a terminal
 * status. Extracted from the CallSessionOptions closure so the stale-call
 * sweep can notify too — a task whose process died mid-call has no session
 * left to do it, which is exactly why those failures used to be silent.
 *
 * Also sends the task webhook (TASK_WEBHOOK_URL, docs/ROADMAP.md 4.4) from
 * here rather than from transitionTask: an outcome is usually settled
 * mid-call, and this runs only once the call has ended, so the agent that
 * hears back can read a complete transcript. Sent alongside the owner's
 * notification (allSettled, so neither can stop the other), unless
 * OUTCOME_SUMMARY_VIA=webhook: then the agent behind the webhook tells the
 * owner, and the owner's notification goes out only if the webhook wasn't
 * delivered, so the owner hears about each call once.
 */
export async function notifyTaskOutcome(taskId: string, disclosure?: DisclosureResult): Promise<void> {
  const current = await getTask(taskId);
  if (!current || !current.outcome || !isTerminalStatus(current.status)) return;
  const contact = await getContact(current.contactId);
  if (!contact) return;
  const outcome = current.outcome;
  // An ask call that ended some other way keeps its own outcome; the answers
  // it saved before that go with it (#148 review).
  const saved = modeRules(current).asks && outcome.kind !== 'answered' ? collectedAnswersFor(current) : [];
  const summary = withDisclosureNote(withSavedAnswers(buildOutcomeSummary(contact, outcome), contact, saved), disclosure);
  // Built inside the async function, not as an argument: an exception while
  // building the event then rejects this promise, which allSettled holds,
  // instead of throwing before allSettled runs and skipping the owner's
  // notification with it (caught in CI, 2026-10-05).
  const sendWebhook = async (): Promise<boolean> => {
    if (!config.TASK_WEBHOOK_URL) return false;
    return sendTaskWebhook({
      event: 'task.finished',
      taskId: current.id,
      status: current.status,
      outcome,
      contact: { id: contact.id, name: contact.displayName },
      text: buildWebhookText(contact, outcome, disclosure, saved),
      finishedAt: current.updatedAt.toISOString(),
    });
  };
  const notifyOwner = () => createNotificationChannel().notify(current.id, outcome, summary);
  if (config.OUTCOME_SUMMARY_VIA === 'webhook') {
    const delivered = await sendWebhook().catch((err: unknown) => {
      logger.error({ err, taskId }, 'Failed to send task webhook');
      return false;
    });
    if (!delivered) {
      logger.warn({ taskId }, 'Task webhook not delivered; sending the outcome summary to the owner instead');
      await notifyOwner();
    }
    return;
  }
  const [notified, webhook] = await Promise.allSettled([notifyOwner(), sendWebhook()]);
  if (webhook.status === 'rejected') logger.error({ err: webhook.reason, taskId }, 'Failed to send task webhook');
  if (notified.status === 'rejected') throw notified.reason;
}

/**
 * transfer_to_owner for outbound calls (#7). Defined here, beside the
 * outbound tool list that offers it, rather than in voice/tools/callTools.ts:
 * callTools.ts holds the tools every outbound call gets, and this one is
 * built from telephony/transfer.ts's defineTransferTool and offered only when
 * TRANSFER_ENABLED is on.
 *
 * The hook only records the outcome. It does not notify: the redirect ends
 * the media stream, so CallSession.end() runs and its notifyIfTerminal sends
 * the one text, with the disclosure note — the same as every other outcome
 * tool. Notifying here as well texted the owner twice.
 *
 * Retried once: the call is already with the principal, and a task left at
 * 'negotiating' would be marked failed (and texted as a failure) when the
 * call ends (#7 review).
 */
export const transferToOwnerTool = defineTransferTool<CallContext>({
  async onTransferred(input, ctx) {
    const record = () => transitionTask(ctx.task.id, 'transferred', { outcome: { kind: 'transferred', reason: input.reason } });
    try {
      await record();
    } catch (err) {
      logger.error({ err, taskId: ctx.task.id, callId: ctx.callId }, 'call transferred, but recording it failed; retrying once');
      await record();
    }
  },
});

/** All live-call tools for an outbound call, keyed by name — check_my_availability/confirm_appointment/etc.
 *  (backend-service tools) plus press_digits (telephony-layer, routed differently — see telephony/dtmf.ts).
 *  'ask' tasks (#148) drop the booking tools and get record_answer and report_answers_and_end_call.
 *  Conversation-mode tasks additionally get end_conversation_call — see docs/superpowers/specs/
 *  2026-08-12-outbound-conversational-call-design.md for why this is additive, not a separate restricted set.
 *  transfer_to_owner is added only when TRANSFER_ENABLED is on (#7). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function outboundToolsFor(task: Task): VoiceTool<any, CallContext>[] {
  // A call that can't book (an 'ask' call, #148) gets none of the booking
  // tools: matched by identity, so a renamed or new booking tool can't slip
  // back onto it.
  const shared = modeRules(task).books ? [...bookingCallTools, ...commonCallTools] : commonCallTools;
  const base: VoiceTool<any, CallContext>[] = [...shared, pressDigitsTool];
  if (config.TRANSFER_ENABLED) base.push(transferToOwnerTool);
  if (canWaitOnHold()) base.push(waitOnHoldTool);
  if (canAskOwner()) base.push(askOwnerTool);
  return [...base, ...(MODE_TOOLS[task.mode] ?? [])];
}

/**
 * Each mode's own tools, on top of the common ones: its way to end a call,
 * and for an ask call record_answer, which saves each answer as it's settled
 * (#148 review). Keyed by mode so a new one can't be left out.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODE_TOOLS: Record<Task['mode'], VoiceTool<any, CallContext>[]> = {
  booking: [],
  conversation: [endConversationCallTool],
  ask: [recordAnswerTool, reportAnswersAndEndCallTool],
};

/** Only OpenAI Realtime implements VoiceAIProvider.setHold/judgeHoldLine so far (#151). */
export function canWaitOnHold(): boolean {
  return config.VOICE_AI_PROVIDER === 'openai';
}

/** "12 minutes", "1 minute": for the owner's hold messages. */
function minutes(ms: number): string {
  const n = Math.max(1, Math.round(ms / 60_000));
  return `${n} minute${n === 1 ? '' : 's'}`;
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
  /** Whether the owner has been told about the hold Banjo is in, or stepping in and out of (onHoldChange). */
  let toldOwnerOnHold = false;

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
  //
  // An ask call with answers saved by record_answer is recorded 'answered'
  // from them instead (tasks/modes.ts's unfinishedCallOutcome, #148 review),
  // and a conversation they'd replied in 'conversation_completed' (#179).
  async function failTaskIfStillNonTerminal(
    reason: string,
    { endedOnItsOwn, theirReplies = 0 }: { endedOnItsOwn: boolean; theirReplies?: number },
  ): Promise<void> {
    const current = await getTask(task.id);
    if (current && !isTerminalStatus(current.status)) {
      // A call the owner stopped, or whose session failed, keeps its reason:
      // stop_call promises "recorded as failed with that reason" (#148 review r2).
      const unfinished = endedOnItsOwn ? modeRules(current).unfinishedCallOutcome(current, { theirReplies }) : undefined;
      if (unfinished) await transitionTask(task.id, unfinished.status, { outcome: unfinished.outcome });
      else await transitionTask(task.id, 'failed', { outcome: { kind: 'failed', reason } });
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
    // What a silence nudge says if Banjo hasn't spoken yet, so the call still
    // opens with the disclosure (#118).
    openingLine: disclosureLine(),
    // Nothing is recorded after a hold (#151), so no notice in the reopening.
    pickupLine: disclosureLineWithoutNotice(),
    judgeFirstLine: true,
    ...(task.constraints?.maxHoldMinutes ? { maxHoldMs: task.constraints.maxHoldMinutes * 60_000 } : {}),

    // #151: the owner hears when a hold starts and when someone picks up. A
    // hold that runs out ends the call, and its outcome says so. A phone menu
    // can take Banjo off hold and back on at each step: that's one hold to the
    // owner, until someone picks up.
    async onHoldChange(change) {
      if (change.kind === 'menu') return;
      if (change.kind === 'started') {
        if (toldOwnerOnHold) return;
        toldOwnerOnHold = true;
        await sendOwnerMessage(`Banjo is on hold with ${contact.displayName} and will wait up to ${minutes(change.maxMs)}.`);
        return;
      }
      toldOwnerOnHold = false;
      await sendOwnerMessage(`Someone picked up at ${contact.displayName} after ${minutes(change.waitedMs)} on hold. Banjo is talking to them now.`);
    },

    async onHoldLimit(waitedMs) {
      await transitionTask(task.id, 'escalated', {
        outcome: {
          kind: 'escalated',
          reason: `Waited on hold for ${minutes(waitedMs)} and nobody picked up, so Banjo hung up.`,
          stuckAt: 'hold_limit',
        },
      });
    },

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
        case 'answer_judged':
          // #187: Banjo's own verdict, in the column Twilio's AMD left empty
          // since #32. A second judgment of an unclear first line replaces it.
          await updateCallAttempt(callAttempt.id, { answeredBy: patch.verdict });
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
          await failTaskIfStillNonTerminal(patch.reason, { endedOnItsOwn: !patch.stopped, theirReplies: patch.theirReplies });
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
      await failTaskIfStillNonTerminal(reason, { endedOnItsOwn: false });
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
