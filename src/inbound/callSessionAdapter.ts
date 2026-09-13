import type { CalendarProvider } from '../calendar/types.js';
import type { CallSessionOptions } from '../session/callSession.js';
import type { TelephonyProvider } from '../telephony/providers/types.js';
import { updateInboundCall } from './service.js';
import { inboundTools } from './tools.js';
import type { InboundCall } from './schema.js';
import type { InboundCallContext } from './types.js';

/**
 * Inbound counterpart of src/tasks/callSessionAdapter.ts's
 * buildOutboundCallSessionOptions — reproduces the same CallSessionOptions
 * seam for an inbound call. Used by src/server.ts's
 * `POST /telephony/twilio/inbound` route.
 */
export function buildInboundCallSessionOptions(params: {
  inboundCall: InboundCall;
  callerPhoneNumber: string;
  telephony: TelephonyProvider;
  calendar: CalendarProvider;
  systemPrompt: string;
  frontendSystemPrompt?: string;
}): CallSessionOptions<InboundCallContext> {
  const { inboundCall, callerPhoneNumber, telephony, calendar, systemPrompt, frontendSystemPrompt } = params;

  return {
    // Twilio's own CallSid — the id every TelephonyProvider method is keyed
    // by for this call (see TwilioProvider.registerInboundCall). NOT
    // inboundCall.id, which is our DB row id, used only as the FK target
    // for inboundBookings (see InboundCallContext's doc comment).
    callId: inboundCall.twilioCallSid,
    telephony,
    systemPrompt,
    frontendSystemPrompt,
    tools: inboundTools,
    greetOnConnect: true,

    async beginCall() {
      // The call already exists by the time this runs — it was registered
      // via telephony.registerInboundCall() in the webhook route (src/
      // server.ts), before this CallSession was ever constructed. There is
      // nothing to originate; just report back the identity CallSession
      // already knows as `callId` above.
      return { providerCallId: inboundCall.twilioCallSid };
    },

    async buildToolContext(estimatedAudioDoneAt: number): Promise<InboundCallContext> {
      return {
        inboundCallId: inboundCall.id,
        callId: inboundCall.twilioCallSid,
        callerPhoneNumber,
        telephony,
        calendar,
        estimatedAudioDoneAt,
      };
    },

    async onStatusChange(patch) {
      switch (patch.kind) {
        case 'started':
          // providerCallId is already inboundCall.twilioCallSid, known
          // before this CallSession was even constructed — nothing new to
          // persist.
          break;
        case 'answering_machine_detected':
          // AMD is an outbound-only concept — Twilio's MachineDetection is
          // only ever requested on originateCall (see
          // src/tasks/callSessionAdapter.ts), never on an inbound leg, so
          // this case is unreachable in practice for an inbound call.
          // Handled explicitly (not folded into `default`) so a future
          // change to CallSessionStatusPatch can't silently regress this
          // into an unhandled case.
          break;
        case 'ended':
          await updateInboundCall(inboundCall.id, { status: 'ended' });
          break;
        case 'failed':
          await updateInboundCall(inboundCall.id, { status: 'error' });
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

    async onFailure() {
      // No task-equivalent "outcome" to fail for an inbound call — status
      // is already persisted to 'error' via onStatusChange's 'failed' case
      // above (CallSession's fail() calls onStatusChange before onFailure).
    },

    async notifyIfTerminal() {
      // No-op — inbound has no call-level "outcome" notification the way
      // outbound's buildOutcomeSummary/createNotificationChannel does. Each
      // booking/reschedule already sent its own SMS inline (see
      // src/inbound/tools.ts's sendOwnerSms calls) at the moment it
      // happened, not deferred to call-end.
    },
  };
}
