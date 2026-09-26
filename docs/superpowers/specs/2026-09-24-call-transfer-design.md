# Call Transfer (cold, behind a flag) — Design

Issue: #7. Roadmap: `docs/ROADMAP.md` item 2.

## Context

When a call needs the principal personally, Banjo's only move today is `escalate_and_end_call` (outbound) or
`flag_for_owner_and_end_call` (inbound): hang up and send a notification. The other party has to wait for a
callback, and the principal hears about it after the fact. This design lets Banjo hand the live call to the
principal's phone instead.

`<Connect><Stream>` is terminal TwiML. The Media Streams WebSocket *is* the call, so there is no TwiML
continuation to `<Dial>` into. A transfer has to be a REST redirect of the live call:
`client.calls(sid).update({ twiml })`, the same call shape as `TwilioProvider.hangUp()`.

## Decisions (from brainstorming, 2026-09-24)

- **Both directions in v1:** outbound (Banjo hands the business to the principal) and inbound (a caller on
  Banjo's line reaches the principal).
- **One fixed destination:** a new `TRANSFER_TO_PHONE_NUMBER`. The model never chooses or supplies a number.
- **When:** only when the other side needs the principal personally, and only after they agree to be connected.
  Everything else still escalates.
- **No answer:** a fixed fallback line, then hang up. The principal's own voicemail answering counts as answered.
- **Cold transfer only.** Warm transfer needs a second concurrent leg, and `isAnyCallActive()` is the entire
  concurrency policy today.
- **Whisper deferred** to the next release (a short "Banjo transfer: <contact>, <reason>" played to the
  principal before bridging). With SMS blocked on 10DLC registration, v1 transfers arrive without context.

## Deviations from the issue's sketch

- **No `transfer_completed` / `transfer_failed` arm on `TelephonyEvent`.** A failed redirect is a thrown error
  from `transferCall()`, which the tool returns to the model directly. Whether the principal answered is only
  known from Twilio's `<Dial action>` callback, which fires after the bridged call ends, by which time the
  `CallSession` is gone and has no listener. The dial result is recorded from a webhook instead (below).
- **The tool is defined once but recorded per direction.** Signaling lives in `src/telephony/transfer.ts`
  (next to `dtmf.ts`, as the issue asks). Outcome recording is domain work, so each direction supplies it
  through a hook rather than the telephony layer knowing about tasks.

## Design

### 1. Telephony layer

**Interface** (`src/telephony/providers/types.ts`):

```ts
/** Cold-transfer a live call to `to` (#7). Optional, like startRecording: a provider without it can't transfer. */
transferCall?(callId: string, opts: { to: string }): Promise<void>;
```

**Twilio** (`src/telephony/providers/twilio.ts`):

1. Look up the call's `providerCallId`. None → throw (the tool reports `transfer_failed`).
2. If a recording is running on the call, stop it (`calls(sid).recordings(recSid).update({ status: 'stopped' })`).
   The callee agreed to a recorded call with Banjo, not to recording the principal's bridged conversation.
   The provider remembers the SID `startRecording()` returned in its per-call state, so no new interface method
   is needed. A failure to stop is logged and does not block the transfer.
3. `client.calls(sid).update({ twiml })` with:

   ```xml
   <Response>
     <Dial timeout="20" answerOnBridge="true" action="https://{PUBLIC_HOSTNAME}/telephony/twilio/transfer-callback?callId={callId}">
       <Number>{to}</Number>
     </Dial>
   </Response>
   ```

   Nothing follows the `<Dial>`: with an `action` URL, Twilio never reaches verbs after it and instead runs
   whatever TwiML the callback returns. So the fallback line comes from the callback (below): when
   `DialCallStatus` is `completed` it returns `<Response><Hangup/></Response>`; otherwise
   `<Response><Say>{fallbackMessage}</Say><Hangup/></Response>`, XML-escaped. The fallback plays only when
   the principal was not reached.
4. Only after the REST update succeeds: `clearInboundRegistrationTimeout(callId)` and `forgetCall(callId)`.
   This does two jobs:
   - `isAnyCallActive()` doesn't latch true and wedge the inbound line.
   - `CallSession`'s teardown `hangUp()` (`callSession.ts`, `hangUpTelephony`) becomes a no-op via
     `recentlyEnded`. Without it, a teardown that runs before Twilio's stream `stop` arrives would hang up the
     bridged call.

   Unlike `hangUp()`, this is not in a `finally`. If the redirect fails, the call may still be live, and
   forgetting it would cut Banjo off from a call it has to keep talking on. The media stream's `stop` and
   socket-close handlers already forget the call whenever it really ends, so nothing is left behind either way.

**Callback route** (`src/server.ts`): `POST /telephony/twilio/transfer-callback`. Signature-validated like the
other Twilio routes. Replies with the TwiML above, and maps `DialCallStatus` to a `TransferResult`:

| `DialCallStatus` | `transfer_result` |
|---|---|
| `completed`, `answered` | `answered` |
| `no-answer` | `no_answer` |
| `busy` | `busy` |
| `failed`, `canceled`, anything else | `failed` |

For an outbound call (`callId` is a `call_attempts.id`), it writes `call_attempts.transfer_result`. For an
inbound call (`callId` is a Twilio CallSid with no `call_attempts` row), it only logs. An unknown `callId` is
logged and ignored. Route errors never fail the response: Twilio gets its TwiML regardless, since a failed
record must not leave the caller in silence.

**Logging:** `src/server.ts` and the provider stop logging TwiML bodies at `info` (they log `callId` and the
TwiML length). A transfer TwiML contains the principal's number, and the logger's phone redaction covers
known fields, not XML bodies.

### 2. The tool

`src/telephony/transfer.ts` exports:

- `transferAfterSpeaking(ctx, opts)`: waits for the handoff line to finish playing (the same
  `estimatedAudioDoneAt` math and caps as `hangUpAfterSpeaking`, sharing its constants), then calls
  `ctx.telephony.transferCall(ctx.callId, { to: config.TRANSFER_TO_PHONE_NUMBER })`.
  Throws if the provider has no `transferCall`.
- `defineTransferTool<Ctx>({ onTransferred })`: builds `transfer_to_owner`.
  - Schema: `{ reason: string }`. The reason is metadata for the principal, not spoken to the callee, so no
    `verbatimMessage`.
  - `endsCall: true`, so `CallSession` waits for the current turn (the handoff line) before running it.
  - Handler: `transferAfterSpeaking(ctx)`, then `onTransferred(input, ctx)`, then
    `{ ok: true }`. If `transferAfterSpeaking` throws, it returns
    `{ ok: false, error: 'transfer_failed', message }` and does not call `onTransferred`.
    Not wrapped in `runToolSafely`: its `TOOL_TIMEOUT_MS` could fire while the redirect is in flight and tell
    the model a transfer failed that then went through. Instead the tool declares `handlerBudgetMs`
    (`TRANSFER_HANDLER_BUDGET_MS`), which `CallSession`'s tool-pending watchdog and its `end()`/`fail()` wait
    honor (final review of #7).

**Outbound tool** (`transferToOwnerTool` in `src/tasks/callSessionAdapter.ts`, beside `outboundToolsFor`),
whose hook does: `transitionTask(task.id, 'transferred', { outcome: { kind: 'transferred', reason } })`, retried
once if it throws. It does not notify: the redirect ends the stream, so `CallSession.end()`'s `notifyIfTerminal`
sends the one text, as for every other outcome (an earlier draft also called `notifyTaskOutcome` here, which
texted the owner twice). The transition runs after the redirect succeeds, never before: a failed
redirect must not leave a task marked transferred while its call is still live. The `end()`/`fail()` wait for
running tools (#62) means this write lands before the adapter's fallback `failed` when the stream closes.

**Inbound tool** (`src/inbound/tools.ts`), whose hook does: `sendOwnerSms("Transferring inbound caller <number> to you — <reason>")`.
A failed SMS is logged and doesn't affect the transfer.

### 3. Data model and config

**Migration `0004`** (via `npm run db:generate`, applied on boot):

- `task_status` enum gains `transferred`. It's terminal automatically: `isTerminalStatus` is "not in
  `NON_TERMINAL_STATUSES`".
- `call_attempts.transfer_result` — nullable `text`, typed in Drizzle as
  `'answered' | 'no_answer' | 'busy' | 'failed'`.

**`TaskOutcome`** gains `{ kind: 'transferred'; reason: string }`. `buildOutcomeSummary` gets
`Transferred ${contact.displayName} to you — ${reason}.` `get_task_status` and `list_recent_tasks` already
return status and outcome as-is, and the `schedule-appointment` skill's status handling learns `transferred`.

**Config** (`src/config/index.ts`):

- `TRANSFER_ENABLED`: `z.enum(['true','false']).default('false')`, transformed to boolean.
- `TRANSFER_TO_PHONE_NUMBER`: optional `e164`. A `.refine()` requires it when `TRANSFER_ENABLED` is true.
- `TRANSFER_FALLBACK_MESSAGE`: optional string, default
  `"Sorry, they couldn't be reached right now. They'll get back to you soon. Goodbye."`

All three go in `.env.example` and the README's configuration table.

### 4. Tool lists and prompts

- `outboundToolsFor(task)` appends the outbound `transfer_to_owner` when `config.TRANSFER_ENABLED`.
- A new `inboundToolsFor()` in `src/inbound/tools.ts` does the same for inbound. The flat `inboundTools` array
  stays as the base list, and the inbound session setup switches to `inboundToolsFor()`.
- `CallSession` derives the model's tool definitions from `opts.tools` (`callSession.ts:193`), so a disabled
  tool never reaches the model.
- One shared `transferGuidance(direction)` (in `src/voice/systemPrompt.ts`, beside the other fixed rules), added
  only when enabled, to:
  - the outbound system prompt (`src/tasks/promptBuilder.ts`),
  - the inbound system prompt (`src/inbound/systemPrompt.ts`),
  - both openai-live voice-layer prompts, with an added line to delegate the transfer to the backend.
- **The rule:** transfer only when the other party needs <principal> personally (they ask for them, need payment
  or personal details only the principal can give, or a decision you can't make). Ask first whether they'd like
  to be connected, and call `transfer_to_owner` only after a clear yes. Say one short handoff line ("Connecting
  you now, one moment."), then call the tool and say nothing after. If it returns `transfer_failed`, apologize
  and use `escalate_and_end_call` (outbound) or `flag_for_owner_and_end_call` (inbound).
- The guidance sits with the fixed rules, before the owner profile (`PROMPT_PROFILE_FILE`), so the profile can't
  widen when transfer is allowed. The disclosure and recording-notice rules are untouched.

### 5. Error handling

| Situation | Behavior |
|---|---|
| `TRANSFER_ENABLED=true`, no number | Config validation fails at startup. |
| Redirect REST call fails | Tool returns `transfer_failed`; call continues; model escalates per the prompt. Task stays `negotiating`. |
| Callee hangs up during the handoff line | `transferCall` finds no live call and throws; tool returns `transfer_failed`; the adapter's normal end-of-call path records `failed`. |
| Principal doesn't answer / busy | Fallback `<Say>`, hang up. `transfer_result` = `no_answer`/`busy`. Task stays `transferred`. |
| Stopping the recording fails | Logged; transfer proceeds. |
| Callback for unknown `callId` | Logged and ignored. |

A `transferred` task whose dial went unanswered is not re-notified in v1: SMS is blocked, and `transfer_result`
is visible in the DB. A missed-transfer text can follow once SMS works.

## Testing

Mirrors `src/`:

- `tests/telephony/transfer.test.ts`: waits for playback before `transferCall`; passes `TRANSFER_TO_PHONE_NUMBER`; a throw becomes `transfer_failed` and skips `onTransferred`; a provider without
  `transferCall` gives `transfer_failed`.
- `tests/telephony/twilio.test.ts`: TwiML shape (`<Dial>` with `action`, nothing after it); a running recording is stopped first; the call
  is forgotten after a successful redirect (a later `hangUp()` is a no-op) and kept after a failed one.
- `tests/server.test.ts`: callback signature validation, `DialCallStatus` mapping, `<Hangup/>` for `completed`
  vs the XML-escaped fallback `<Say>` otherwise, unknown `callId` ignored.
- `tests/tasks/callSessionAdapter.test.ts`, `tests/inbound/tools.test.ts` and `tests/inbound/callSessionAdapter.test.ts`: the tool is present only when the flag is
  on; outbound records `transferred` and notifies; inbound texts; a failed redirect leaves the task
  `negotiating`.
- `tests/config.test.ts`: the `.refine()`.
- Prompt tests: the guidance appears only when enabled, in all four prompts, before the owner profile.
- `tests/notifications/channel.test.ts`: the `transferred` summary.
- A DB-backed test (`banjo_test`) for `transfer_result` writes from the callback.

**Live check before merge:** Banjo calls a test number and transfers to the principal's cell.

1. Principal answers → bridged, `transfer_result = answered`, task `transferred`, no Banjo audio after the handoff.
2. Principal declines → the fallback line plays to the caller, `transfer_result` = `no_answer` or `busy`.

## Docs

- `docs/ARCHITECTURE.md`: a transfer section, including why the event arm was dropped and why forgetting the call after a successful redirect also
  protects the bridged call.
- `README.md`: remove the "No call transfer" limitation; document the three env vars.
- `docs/ROADMAP.md` item 2: cold transfer done; warm transfer and the whisper remain.
- `CLAUDE.md`: add `transfer_to_owner` and the flag gating to the architecture notes.

## Out of scope

- Whisper to the principal (next release).
- Warm transfer / concurrent calls.
- Per-task or model-chosen destinations.
- Reconnecting the caller to Banjo after an unanswered transfer.
