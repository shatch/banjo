import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallContext } from '../../src/session/types.js';
import type { CallAttempt, Task } from '../../src/tasks/schema.js';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';
import { pressDigitsTool, pressDigitsToolDefinition } from '../../src/telephony/dtmf.js';

// leaveVoicemailAndEndCallTool/reportNegotiationFailedTool/escalateAndEndCallTool/
// endCallTool all call transitionTask (and endCallTool also getTask) — stub the
// whole persistence layer so those handlers can be exercised directly, without
// hitting a real DB, matching the pattern already used in
// tests/voice/confirmAppointmentTool.test.ts. vi.hoisted() is required here
// (rather than a bare top-level const) because these mock fns are referenced
// inside vi.mock's factory below, which vitest hoists above every import.
const { transitionTask, getTask } = vi.hoisted(() => ({
  transitionTask: vi.fn(async () => {}),
  getTask: vi.fn(async () => undefined as Task | undefined),
}));
vi.mock('../../src/tasks/service.js', () => ({
  getTask,
  transitionTask,
  NON_TERMINAL_STATUSES: ['pending', 'checking_availability', 'calling', 'negotiating'],
}));

const {
  callToolDefinitions,
  callTools,
  combineDateTimeToIso,
  confirmAppointmentTool,
  endCallTool,
  endConversationCallTool,
  escalateAndEndCallTool,
  hangUpAfterSpeaking,
  leaveVoicemailAndEndCallTool,
  reportNegotiationFailedTool,
} = await import('../../src/voice/tools/callTools.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('voice tools: schema + JSON Schema conversion', () => {
  it('registers all 6 call tools with unique names', () => {
    const names = callTools.map((t) => t.name);
    expect(names).toEqual([
      'check_my_availability',
      'confirm_appointment',
      'leave_voicemail_and_end_call',
      'report_negotiation_failed',
      'escalate_and_end_call',
      'end_call',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("leave_voicemail_and_end_call declares verbatimMessage so CallSession forces the message to actually be spoken — regression coverage for a real bug where the recorded outcome and the delivered audio diverged", () => {
    // Live-reproduced bug: the model said a short preamble, then called this
    // tool with the real message as an argument that was never itself
    // spoken — the callee heard only the preamble while the DB/SMS asserted
    // full delivery. verbatimMessage is what CallSession (session/callSession.ts)
    // uses to force VoiceAIProvider.sayVerbatim before this handler ever runs;
    // this test only asserts the extraction is wired correctly, not
    // CallSession's enforcement of it (covered in tests/session/callSession.test.ts).
    expect(leaveVoicemailAndEndCallTool.verbatimMessage).toBeDefined();
    expect(leaveVoicemailAndEndCallTool.verbatimMessage!({ message: 'please call back at 555-1234' })).toBe('please call back at 555-1234');
  });

  it('report_negotiation_failed/escalate_and_end_call/end_conversation_call do NOT declare verbatimMessage — their arguments are metadata for Steve, not content meant for the other party', () => {
    // Explicit audit conclusion (docs/ARCHITECTURE.md item 13): only
    // leave_voicemail_and_end_call's argument is content the other party is
    // supposed to hear. reason/summary on these other tools record why the
    // call ended a certain way for Steve's benefit — forcing them to be
    // spoken aloud to the other party would be wrong, not a fix.
    expect(reportNegotiationFailedTool.verbatimMessage).toBeUndefined();
    expect(escalateAndEndCallTool.verbatimMessage).toBeUndefined();
    expect(endConversationCallTool.verbatimMessage).toBeUndefined();
  });

  it('end_call exists as a distinct way to finish a call without setting an outcome itself', () => {
    // Regression coverage for a real gap: confirm_appointment doesn't end
    // the call, and none of the other outcome tools fit a successful
    // booking — a live call was cut off mid-sentence because the model had
    // no tool that both fit the situation and ended the call cleanly.
    expect(endCallTool.name).toBe('end_call');
    expect(endCallTool.schema.safeParse({}).success).toBe(true); // summary is optional
    expect(endCallTool.schema.safeParse({ summary: 'wrapped up fine' }).success).toBe(true);
  });

  it('converts every call tool into a ToolDefinition with a non-empty JSON Schema', () => {
    expect(callToolDefinitions).toHaveLength(callTools.length);
    for (const def of callToolDefinitions) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.parameters).toBeTypeOf('object');
    }
  });

  it("confirm_appointment's schema accepts valid input and rejects invalid input", () => {
    const valid = confirmAppointmentTool.schema.safeParse({
      confirmedStart: '2026-08-05T14:00:00Z',
      durationMinutes: 30,
    });
    expect(valid.success).toBe(true);

    const invalid = confirmAppointmentTool.schema.safeParse({
      confirmedStart: '2026-08-05T14:00:00Z',
      durationMinutes: -5, // must be positive
    });
    expect(invalid.success).toBe(false);
  });

  it("confirm_appointment's JSON Schema never declares an idempotencyKey field the model could supply", () => {
    // The idempotency key is server-generated inside the handler (from
    // ctx.callAttempt.id), specifically so the model can never influence it —
    // this test guards against that invariant regressing. Checked via the
    // generated JSON Schema (what's actually injected into the provider's
    // session config), not schema.shape, since VoiceTool.schema is typed as
    // the generic z.ZodType — .shape is only on the concrete ZodObject.
    const def = callToolDefinitions.find((d) => d.name === 'confirm_appointment');
    expect(def).toBeDefined();
    const properties = (def!.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties).not.toHaveProperty('idempotencyKey');
    expect(properties).toHaveProperty('confirmedStart');
  });

  it('press_digits is a distinct, telephony-routed tool registered alongside the backend-service tools', () => {
    expect(pressDigitsTool.name).toBe('press_digits');
    expect(pressDigitsToolDefinition.name).toBe('press_digits');
    expect(pressDigitsTool.schema.safeParse({ digits: '1234*#' }).success).toBe(true);
    expect(pressDigitsTool.schema.safeParse({ digits: 'abc' }).success).toBe(false);
  });

  it('never generates OpenAPI-3.0-style boolean exclusiveMinimum/exclusiveMaximum flags', () => {
    // Regression test: zod-to-json-schema's `target: 'openApi3'` renders
    // .positive()/.int() constraints as `"exclusiveMinimum": true` alongside
    // a separate "minimum", which is valid OpenAPI 3.0 but not valid JSON
    // Schema. A live call rejected this with "Invalid schema for function
    // 'check_my_availability': True is not of type 'number'" — OpenAI's
    // Realtime function-parameter validator expects the numeric JSON Schema
    // form (`"exclusiveMinimum": 0`). toToolDefinition() must keep using a
    // plain JSON Schema target ('jsonSchema7'), not 'openApi3'.
    for (const def of [...callToolDefinitions, pressDigitsToolDefinition]) {
      const json = JSON.stringify(def.parameters);
      expect(json, `${def.name}'s schema`).not.toContain('"exclusiveMinimum":true');
      expect(json, `${def.name}'s schema`).not.toContain('"exclusiveMaximum":true');
    }
  });

  it('does not include a $schema meta key in generated tool parameters', () => {
    for (const def of callToolDefinitions) {
      expect(def.parameters).not.toHaveProperty('$schema');
    }
  });

  it("confirm_appointment's schema accepts a naive local date-time (no UTC offset)", () => {
    // The schema now explicitly asks the model for a naive local time in
    // CALENDAR_TIMEZONE, not a self-computed UTC instant — the handler
    // (not covered here, needs a DB) converts it via zonedTimeToUtcIso. A
    // real booking landed 4 hours off before this was fixed: see
    // tests/lib/timezone.test.ts for the conversion correctness itself.
    const valid = confirmAppointmentTool.schema.safeParse({
      confirmedStart: '2026-08-05T14:00:00',
      durationMinutes: 30,
    });
    expect(valid.success).toBe(true);
  });
});

describe('combineDateTimeToIso: AM/PM normalization', () => {
  // CALENDAR_TIMEZONE defaults to America/New_York; August is EDT (UTC-4).
  it('normalizes a bare-hour AM/PM time ("11am") to 24-hour before parsing', () => {
    expect(combineDateTimeToIso('2026-08-10', '11am')).toBe('2026-08-10T15:00:00.000Z');
  });

  it('normalizes "2:30pm" to 24-hour before parsing', () => {
    expect(combineDateTimeToIso('2026-08-10', '2:30pm')).toBe('2026-08-10T18:30:00.000Z');
  });

  it('normalizes "2:30 PM" (space before meridiem, uppercase) to 24-hour before parsing', () => {
    expect(combineDateTimeToIso('2026-08-10', '2:30 PM')).toBe('2026-08-10T18:30:00.000Z');
  });

  it('leaves a bare 24-hour time ("14:00") unchanged', () => {
    expect(combineDateTimeToIso('2026-08-10', '14:00')).toBe('2026-08-10T18:00:00.000Z');
  });

  it('handles the 12am/12pm edge cases correctly (midnight and noon)', () => {
    expect(combineDateTimeToIso('2026-08-10', '12am')).toBe('2026-08-10T04:00:00.000Z');
    expect(combineDateTimeToIso('2026-08-10', '12pm')).toBe('2026-08-10T16:00:00.000Z');
  });

  it('still throws for an unrecognized time format', () => {
    expect(() => combineDateTimeToIso('2026-08-10', 'three-ish')).toThrow(/Could not parse date\/time/);
  });
});

describe('hangUpAfterSpeaking: audio-aware wait time', () => {
  it('waits until estimatedAudioDoneAt (plus the safety margin) when playback is still in the future', async () => {
    vi.useFakeTimers();
    const telephony = { hangUp: vi.fn(async () => {}) } as unknown as TelephonyProvider;
    const now = Date.now();

    const promise = hangUpAfterSpeaking({ telephony, callId: 'call-1', estimatedAudioDoneAt: now + 1000 });
    await vi.advanceTimersByTimeAsync(1399);
    expect(telephony.hangUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(telephony.hangUp).toHaveBeenCalledWith('call-1');
    await promise;

    vi.useRealTimers();
  });

  it('collapses to just the safety margin when estimatedAudioDoneAt is already in the past', async () => {
    vi.useFakeTimers();
    const telephony = { hangUp: vi.fn(async () => {}) } as unknown as TelephonyProvider;
    const now = Date.now();

    const promise = hangUpAfterSpeaking({ telephony, callId: 'call-2', estimatedAudioDoneAt: now - 5000 });
    await vi.advanceTimersByTimeAsync(399);
    expect(telephony.hangUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(telephony.hangUp).toHaveBeenCalledWith('call-2');
    await promise;

    vi.useRealTimers();
  });

  it('waits exactly the safety margin when estimatedAudioDoneAt is exactly now', async () => {
    vi.useFakeTimers();
    const telephony = { hangUp: vi.fn(async () => {}) } as unknown as TelephonyProvider;
    const now = Date.now();

    const promise = hangUpAfterSpeaking({ telephony, callId: 'call-3', estimatedAudioDoneAt: now });
    await vi.advanceTimersByTimeAsync(399);
    expect(telephony.hangUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(telephony.hangUp).toHaveBeenCalledWith('call-3');
    await promise;

    vi.useRealTimers();
  });

  it('never waits longer than MAX_HANGUP_WAIT_MS even when estimatedAudioDoneAt is far in the future (e.g. a long trailing voicemail message)', async () => {
    // Regression test for a critical finding: an unbounded wait could exceed
    // TOOL_TIMEOUT_MS (default 8000ms), causing the enclosing tool call to
    // time out before hangUp() ever runs. MAX_HANGUP_WAIT_MS (6000ms) caps
    // the wait comfortably under that budget regardless of how far in the
    // future estimatedAudioDoneAt is.
    vi.useFakeTimers();
    const telephony = { hangUp: vi.fn(async () => {}) } as unknown as TelephonyProvider;
    const now = Date.now();

    const promise = hangUpAfterSpeaking({ telephony, callId: 'call-4', estimatedAudioDoneAt: now + 60_000 });
    await vi.advanceTimersByTimeAsync(5999); // MAX_HANGUP_WAIT_MS - 1
    expect(telephony.hangUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // MAX_HANGUP_WAIT_MS
    expect(telephony.hangUp).toHaveBeenCalledWith('call-4');
    await promise;

    vi.useRealTimers();
  });
});

describe('outcome-recording order relative to hangUpAfterSpeaking (regression for Finding 1)', () => {
  // Task 6-era bug: leaveVoicemailAndEndCallTool/reportNegotiationFailedTool/
  // escalateAndEndCallTool all awaited hangUpAfterSpeaking BEFORE recording
  // the task's outcome via transitionTask; endCallTool awaited it before its
  // own getTask/transitionTask safety net. Combined with hangUpAfterSpeaking's
  // wait being unbounded (now capped at MAX_HANGUP_WAIT_MS, see above), a long
  // trailing utterance could blow runToolSafely's TOOL_TIMEOUT_MS budget and
  // the outcome-recording call would simply never run. The fix reorders each
  // handler so outcome-recording happens first — asserted here via mock
  // invocationCallOrder, the same pattern already used in
  // tests/session/callSession.test.ts for fail()'s ordering.
  function makeCtx(hangUp: TelephonyProvider['hangUp'], estimatedAudioDoneAt: number): CallContext {
    return {
      task: { id: 'task-1', goalDescription: 'Book a haircut' } as Task,
      callAttempt: { id: 'call-attempt-1' } as CallAttempt,
      callId: 'call-attempt-1',
      telephony: { hangUp } as unknown as TelephonyProvider,
      calendar: {} as CallContext['calendar'],
      estimatedAudioDoneAt,
    };
  }

  it('leave_voicemail_and_end_call: transitionTask runs before hangUp, even with a long trailing wait', async () => {
    vi.useFakeTimers();
    const hangUp = vi.fn(async () => {});
    const now = Date.now();

    const promise = leaveVoicemailAndEndCallTool.handler({ message: 'please call back' }, makeCtx(hangUp, now + 60_000));
    await vi.advanceTimersByTimeAsync(6000); // MAX_HANGUP_WAIT_MS
    await promise;
    vi.useRealTimers();

    expect(transitionTask).toHaveBeenCalledWith('task-1', 'voicemail_left', expect.anything());
    expect(hangUp).toHaveBeenCalledTimes(1);
    const transitionOrder = transitionTask.mock.invocationCallOrder[0]!;
    const hangUpOrder = vi.mocked(hangUp).mock.invocationCallOrder[0]!;
    expect(transitionOrder).toBeLessThan(hangUpOrder);
  });

  it('leave_voicemail_and_end_call: records voicemail_left when the provider reports the message was delivered verbatim', async () => {
    vi.useFakeTimers();
    const hangUp = vi.fn(async () => {});
    const ctx: CallContext = {
      ...makeCtx(hangUp, Date.now()),
      verbatimDelivery: { intended: 'please call back', spoken: 'please call back', matched: true },
    };

    const promise = leaveVoicemailAndEndCallTool.handler({ message: 'please call back' }, ctx);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;
    vi.useRealTimers();

    expect(transitionTask).toHaveBeenCalledWith('task-1', 'voicemail_left', {
      outcome: { kind: 'voicemail_left', message: 'please call back' },
    });
    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it("leave_voicemail_and_end_call: records escalated — never voicemail_left — when the provider reports the spoken audio didn't match, and still hangs up", async () => {
    // Speak-then-verify (openai-live): Postgres must record what the callee
    // actually heard, not what the model was asked to say.
    vi.useFakeTimers();
    const hangUp = vi.fn(async () => {});
    const ctx: CallContext = {
      ...makeCtx(hangUp, Date.now()),
      verbatimDelivery: { intended: 'please call back at 555-1234', spoken: 'please call back', matched: false },
    };

    const promise = leaveVoicemailAndEndCallTool.handler({ message: 'please call back at 555-1234' }, ctx);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;
    vi.useRealTimers();

    expect(transitionTask).toHaveBeenCalledTimes(1);
    expect(transitionTask).toHaveBeenCalledWith('task-1', 'escalated', {
      outcome: { kind: 'escalated', reason: expect.stringContaining('could not be verified') },
    });
    expect(hangUp).toHaveBeenCalledTimes(1);
    const transitionOrder = transitionTask.mock.invocationCallOrder[0]!;
    const hangUpOrder = vi.mocked(hangUp).mock.invocationCallOrder[0]!;
    expect(transitionOrder).toBeLessThan(hangUpOrder);
    expect(result).toEqual({ ok: false, error: 'voicemail_delivery_unverified' });
  });

  it('report_negotiation_failed: transitionTask runs before hangUp, even with a long trailing wait', async () => {
    vi.useFakeTimers();
    const hangUp = vi.fn(async () => {});
    const now = Date.now();

    const promise = reportNegotiationFailedTool.handler({ reason: 'no overlapping times' }, makeCtx(hangUp, now + 60_000));
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    vi.useRealTimers();

    expect(transitionTask).toHaveBeenCalledWith('task-1', 'negotiation_failed', expect.anything());
    expect(hangUp).toHaveBeenCalledTimes(1);
    const transitionOrder = transitionTask.mock.invocationCallOrder[0]!;
    const hangUpOrder = vi.mocked(hangUp).mock.invocationCallOrder[0]!;
    expect(transitionOrder).toBeLessThan(hangUpOrder);
  });

  it('escalate_and_end_call: transitionTask runs before hangUp, even with a long trailing wait', async () => {
    vi.useFakeTimers();
    const hangUp = vi.fn(async () => {});
    const now = Date.now();

    const promise = escalateAndEndCallTool.handler({ reason: 'hostile caller' }, makeCtx(hangUp, now + 60_000));
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    vi.useRealTimers();

    expect(transitionTask).toHaveBeenCalledWith('task-1', 'escalated', expect.anything());
    expect(hangUp).toHaveBeenCalledTimes(1);
    const transitionOrder = transitionTask.mock.invocationCallOrder[0]!;
    const hangUpOrder = vi.mocked(hangUp).mock.invocationCallOrder[0]!;
    expect(transitionOrder).toBeLessThan(hangUpOrder);
  });

  it('end_call: the getTask/transitionTask safety-net check runs before hangUp, even with a long trailing wait', async () => {
    vi.useFakeTimers();
    getTask.mockResolvedValueOnce({ id: 'task-1', status: 'negotiating' } as unknown as Task);
    const hangUp = vi.fn(async () => {});
    const now = Date.now();

    const promise = endCallTool.handler({ summary: 'no outcome recorded yet' }, makeCtx(hangUp, now + 60_000));
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    vi.useRealTimers();

    expect(getTask).toHaveBeenCalledWith('task-1');
    expect(transitionTask).toHaveBeenCalledWith('task-1', 'escalated', expect.anything());
    expect(hangUp).toHaveBeenCalledTimes(1);
    const transitionOrder = transitionTask.mock.invocationCallOrder[0]!;
    const hangUpOrder = vi.mocked(hangUp).mock.invocationCallOrder[0]!;
    expect(transitionOrder).toBeLessThan(hangUpOrder);
  });

  it('end_call on a conversation-mode task completes the conversation instead of escalating — the model can reach the generic end_call tool on these tasks too (see outboundToolsFor), and treating that as an escalation mislabels a normal close as needing Steve follow-up', async () => {
    vi.useFakeTimers();
    getTask.mockResolvedValueOnce({ id: 'task-1', status: 'negotiating', mode: 'conversation' } as unknown as Task);
    const hangUp = vi.fn(async () => {});
    const now = Date.now();

    const promise = endCallTool.handler(
      { summary: 'Caught up about the day; asked them to grab some groceries.' },
      makeCtx(hangUp, now + 60_000),
    );
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    vi.useRealTimers();

    expect(getTask).toHaveBeenCalledWith('task-1');
    expect(transitionTask).toHaveBeenCalledWith(
      'task-1',
      'conversation_completed',
      expect.objectContaining({
        outcome: {
          kind: 'conversation_completed',
          summary: 'Caught up about the day; asked them to grab some groceries.',
        },
      }),
    );
    expect(transitionTask).not.toHaveBeenCalledWith('task-1', 'escalated', expect.anything());
    expect(hangUp).toHaveBeenCalledTimes(1);
    const transitionOrder = transitionTask.mock.invocationCallOrder[0]!;
    const hangUpOrder = vi.mocked(hangUp).mock.invocationCallOrder[0]!;
    expect(transitionOrder).toBeLessThan(hangUpOrder);
  });

  it('end_conversation_call: transitionTask runs before hangUp, even with a long trailing wait', async () => {
    vi.useFakeTimers();
    const hangUp = vi.fn(async () => {});
    const now = Date.now();

    const promise = endConversationCallTool.handler(
      { summary: 'Thanked them for hosting; said the visit was great.' },
      makeCtx(hangUp, now + 60_000),
    );
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    vi.useRealTimers();

    expect(transitionTask).toHaveBeenCalledWith(
      'task-1',
      'conversation_completed',
      expect.objectContaining({ outcome: { kind: 'conversation_completed', summary: 'Thanked them for hosting; said the visit was great.' } }),
    );
    expect(hangUp).toHaveBeenCalledTimes(1);
    const transitionOrder = transitionTask.mock.invocationCallOrder[0]!;
    const hangUpOrder = vi.mocked(hangUp).mock.invocationCallOrder[0]!;
    expect(transitionOrder).toBeLessThan(hangUpOrder);
  });
});

describe('endConversationCallTool: not part of the base booking toolset', () => {
  it('is not included in callTools — only added conditionally for conversation-mode calls', () => {
    expect(callTools.some((t) => t.name === 'end_conversation_call')).toBe(false);
  });

  it('requires a summary argument', () => {
    expect(endConversationCallTool.schema.safeParse({}).success).toBe(false);
    expect(endConversationCallTool.schema.safeParse({ summary: 'All good.' }).success).toBe(true);
  });
});
