import { z } from 'zod';
import { config } from '../config/index.js';
import { childLogger } from '../lib/logger.js';
import { runToolSafely, waitForPlayback } from '../voice/tools/callTools.js';
import { defineVoiceTool, type VoiceTool } from '../voice/tools/defineVoiceTool.js';
import type { TelephonyProvider } from './providers/types.js';

const log = childLogger({ module: 'telephony.transfer' });

/**
 * transfer_to_owner — cold-transfer the live call to the principal (#7).
 *
 * Lives here, next to dtmf.ts, for the same reason press_digits does: the
 * transfer itself is phone signaling. What a transfer MEANS differs by
 * direction (an outbound task's outcome; a text about an inbound caller), so
 * each side builds its own tool from defineTransferTool with an
 * onTransferred hook — tasks/callSessionAdapter.ts and inbound/tools.ts.
 * Offered to the model only when TRANSFER_ENABLED is on.
 */
export const TRANSFER_TOOL_NAME = 'transfer_to_owner';

export type TransferContext = { telephony: TelephonyProvider; callId: string; estimatedAudioDoneAt: number };

/** Lets the handoff line finish ("connecting you now"), then redirects the call to TRANSFER_TO_PHONE_NUMBER. */
export async function transferAfterSpeaking(ctx: TransferContext): Promise<void> {
  if (!ctx.telephony.transferCall) throw new Error(`transfer: telephony provider ${ctx.telephony.name} cannot transfer calls`);
  if (!config.TRANSFER_TO_PHONE_NUMBER) throw new Error('transfer: TRANSFER_TO_PHONE_NUMBER is not set');
  await waitForPlayback(ctx);
  await ctx.telephony.transferCall(ctx.callId, { to: config.TRANSFER_TO_PHONE_NUMBER });
}

export function defineTransferTool<Ctx extends TransferContext>(opts: {
  onTransferred: (input: { reason: string }, ctx: Ctx) => Promise<void>;
}): VoiceTool<{ reason: string }, Ctx> {
  return defineVoiceTool<{ reason: string }, Ctx>({
    name: TRANSFER_TOOL_NAME,
    description: `Connect the other party to ${config.ASSISTANT_PRINCIPAL_NAME} directly, by phone. Use only when they need ${config.ASSISTANT_PRINCIPAL_NAME} personally and have said yes to being connected. Say one short handoff line first; you are off the call once this runs.`,
    schema: z.object({
      reason: z
        .string()
        .min(1)
        .describe(`Why they need ${config.ASSISTANT_PRINCIPAL_NAME}, e.g. "they need a card number to hold the table". Sent to ${config.ASSISTANT_PRINCIPAL_NAME}; not spoken to the other party.`),
    }),
    endsCall: true,
    handler: async (input, ctx: Ctx) => {
      return runToolSafely(TRANSFER_TOOL_NAME, async () => {
        try {
          await transferAfterSpeaking(ctx);
        } catch (err) {
          log.warn({ err, callId: ctx.callId }, 'transfer failed — the call is still ours');
          return { ok: false as const, error: 'transfer_failed' as const, message: err instanceof Error ? err.message : String(err) };
        }
        // The call is already with the principal, so a failure to record it
        // must not tell the model the transfer failed; it has no call to act on.
        try {
          await opts.onTransferred(input, ctx);
        } catch (err) {
          log.error({ err, callId: ctx.callId }, 'call transferred, but recording the transfer failed');
        }
        return { ok: true as const };
      });
    },
  });
}
