import { z } from 'zod';
import { defineVoiceTool, toToolDefinition } from '../voice/tools/defineVoiceTool.js';
import type { CallContext } from '../session/types.js';

/**
 * press_digits — send DTMF tones on the phone line (e.g. to navigate an IVR
 * menu: "press 2 for reservations").
 *
 * ARCHITECTURAL NOTE FOR FUTURE MAINTAINERS: this tool looks like it belongs
 * next to the other live-call tools in src/voice/tools/callTools.ts, and it
 * is registered into the model's tool list the same way (via
 * defineVoiceTool/toToolDefinition, VoiceTool<T> shape, handler(input, ctx)
 * signature). But its handler does NOT call into a backend/domain service —
 * it routes straight into the TELEPHONY layer (ctx.telephony.sendDigits),
 * because DTMF is phone signaling, not a business/domain action. There's
 * nothing to look up, persist, or reason about; it's a direct pass-through
 * to whichever TelephonyProvider (Twilio) is running this call. That's why
 * this file lives in src/telephony/ instead of
 * src/voice/tools/callTools.ts alongside the domain tools (e.g.
 * check_availability, confirm_appointment) — don't move it there or start
 * threading it through a service layer "for consistency" without
 * remembering it's a telephony primitive, not a domain operation.
 */
export const pressDigitsTool = defineVoiceTool({
  name: 'press_digits',
  description: 'Send DTMF tones on the phone line, e.g. to navigate an IVR menu.',
  schema: z.object({
    digits: z.string().regex(/^[0-9*#]+$/, 'digits must only contain 0-9, *, or #'),
  }),
  handler: async (input, ctx: CallContext) => {
    await ctx.telephony.sendDigits(ctx.callId, input.digits);
    return { ok: true };
  },
});

export const pressDigitsToolDefinition = toToolDefinition(pressDigitsTool);
