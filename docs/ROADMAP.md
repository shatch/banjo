# Roadmap

Three pieces of work, in dependency order. Each has a tracking issue; this file holds the
reasoning and the seams, so the issues can stay short.

Everything here is deliberately scoped to what Banjo already is. What it isn't — and won't become —
is in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## 1. Persist transcripts

> **Shipped** in [#6](https://github.com/shatch/banjo/issues/6): `call_transcript_turns`, opt-in via
> `PERSIST_TRANSCRIPTS`, 30-day default retention, read with `get_call_transcript`. The notes below are
> the design reasoning. Still open from them: transcriber confidence (logprobs), and persisting
> `openai-live` deltas.

**Why first:** it's the highest value per line of code in the repo. Every provider adapter already
emits normalized `transcript` events; today they reach `logger` (gated behind `LOG_TRANSCRIPTS`, off
by default) and are then dropped. Nothing else — dispute resolution, call QA, knowledge-gap logging,
"what did it actually say" — is possible until they land in Postgres.

### Seams

**Schema.** A new `src/transcripts/schema.ts`, re-exported from `src/db/schema.ts` — that barrel is
drizzle-kit's only entrypoint, so a table missing from it won't appear in a migration.

The two call paths identify calls differently and a transcript row has to key to both. Outbound's
identity is `callAttempts.id`, our own uuid. Inbound's is Twilio's `CallSid` (`inboundCalls.twilioCallSid`,
unique), with `inboundCalls.id` as a separate uuid used only as an FK target. So: two nullable FKs
with a check constraint, or a polymorphic `(call_kind, call_id)` pair. Two nullable FKs keeps
referential integrity; prefer it unless it gets ugly.

**Write path.** Through `CallSessionOptions`, not `transitionTask`.

`transitionTask` (`src/tasks/service.ts`) is deliberately the only function that writes task
status/outcome, and its compare-and-set refuses to move a task out of a terminal status. A transcript
write routed through it would be silently dropped for exactly the calls you most want a transcript of.
Add an `onTranscript` option alongside the existing `onStatusChange` / `onFailure` / `notifyIfTerminal`.
Both adapters (`src/tasks/callSessionAdapter.ts`, `src/inbound/callSessionAdapter.ts`) switch
exhaustively with a `never` check, so adding an arm is compile-guarded in exactly two files.

Note this contradicts `docs/COMPETITIVE_LANDSCAPE.md`, which claims the change lands "all in
`src/inbound/`, none touching `callSession.ts`". That's wrong for the outbound path.

### Known gaps to handle, not discover

- **No timestamps.** The `transcript` event (`src/voice/types.ts`) carries `role`, `text`, `isFinal`
  and an optional `answered` — no timestamp, no sequence number, no utterance id. Stamp arrival time
  and a monotonic sequence at the `CallSession` boundary, or transcripts come back unorderable.
- **Gemini emits no user transcripts at all.** Its `setup` message requests no input transcription,
  so a Gemini call would persist a one-sided record. Either request input transcription or store a
  marker saying the record is partial — don't let it look complete.
- **`openai-live` finals are synthesized**, from a 1200ms idle debounce, not vendor-authoritative.
  Its boundaries are heuristic and `flushPendingTranscripts()` exists so the last words before
  hangup aren't lost. Persisting deltas as well as finals may be worth it there.
- **User-side transcription is separately billed** on the OpenAI path — it's an extra STT pass
  (`transcription: { model: 'gpt-4o-mini-transcribe' }`), not free with the realtime session. It was
  silently never firing before it was added explicitly.

### Do not

Persist transcripts and leave the PII posture where it is. This is the change that turns a
debug-only log line into durable personal data, so it lands with retention and access decisions
made, not deferred. See item 3 — if only one of the two ships, ship them together.

---

## 2. Call transfer, behind a flag

> **Cold transfer shipped** with #7: `TRANSFER_ENABLED`,
> `TRANSFER_TO_PHONE_NUMBER`, a REST-redirect `<Dial>` to one fixed number, only after the other
> party agrees, gated on both the tool and the prompt rule. See `docs/ARCHITECTURE.md`'s "Call
> transfer (#7)" section for how it works. Still open: **warm transfer** (needs a second concurrent
> call leg — `isAnyCallActive()` is still the entire concurrency policy) and, as the next step
> before that, **a whisper to the principal before bridging** (a short "Banjo transfer: `<contact>`,
> `<reason>`" played to you before the call connects — deferred because SMS is blocked on 10DLC
> registration today, so v1 transfers arrive with no context at all).

**Why:** the current escape hatch when a call needs a human is `escalate_and_end_call` /
`flag_for_owner_and_end_call` — hang up and notify. Handing the live call to a person instead is the
difference between "it gave up" and "it got you there". Vocode has this on both Twilio and Vonage;
Banjo reaches only DTMF.

### The constraint that shapes everything

`<Connect><Stream>` is terminal TwiML. The Media Streams WebSocket **is** the call as far as Twilio
is concerned — when the stream ends, the call ends, and there is no TwiML continuation to `<Dial>`
into. So transfer cannot be done in TwiML from inside the call.

It has to be a REST redirect: `client.calls(sid).update({ twiml: '<Response><Dial>…</Dial></Response>' })`.
That is the same call shape as the existing `hangUp()` in `src/telephony/providers/twilio.ts`, which
is the thing to copy — **including its `finally` block**. That cleanup exists because
`isAnyCallActive()` otherwise latches true forever, and a transfer that forgets it silently wedges
the inbound line.

> **[Superseded]** Shipped `transferCall()` does *not* copy the `finally` block: it forgets the call
> only after the REST redirect succeeds, not unconditionally. A `finally` here would forget a call
> whose redirect failed — one Banjo still has to keep talking on. Forgetting it also turns
> `CallSession`'s teardown `hangUp()` into a no-op, so when that call later ended, nothing would hang
> it up: an untransferred call left live and silent. See `docs/ARCHITECTURE.md`'s "Call transfer (#7)"
> section.

### Seams

- Add `transferCall` to the `TelephonyProvider` interface (`src/telephony/providers/types.ts`) and a
  corresponding arm to `TelephonyEvent` (`transfer_completed` / `transfer_failed`). **[Superseded]**
  `transferCall` was added as sketched; the `TelephonyEvent` arm was deliberately not. The dial
  result (who answered) arrives via Twilio's `<Dial action>` callback only after the bridged call
  ends, by which point the `CallSession` that would have held the listener is already gone. A failed
  *redirect* is a different, immediate failure, and is returned to the model directly instead. See
  the design spec's "Deviations from the issue's sketch" and `docs/ARCHITECTURE.md`'s "Call transfer
  (#7)" section.
- The tool itself belongs in `src/telephony/`, next to `dtmf.ts`, not in `src/voice/tools/`. The
  18-line header on `dtmf.ts` is the argument: this is phone signaling, so its handler routes
  straight into the telephony layer rather than a domain service.
- Reuse the `hangUpAfterSpeaking()` wait-then-act pattern from `src/voice/tools/callTools.ts` —
  speak the handoff line, wait for playback to drain, *then* redirect. Redirecting immediately cuts
  the model off mid-word; that bug has already been fixed once, for hangup.

### Flag gating has to be built, not extended

There is no existing pattern in this repo for omitting a tool from the model's schema based on a
config flag. `INBOUND_BOOKING_ENABLED` is the closest idiom but gates at the *route* level — no
`CallSession` is ever constructed. The only conditional tool-list construction is in
`src/tasks/callSessionAdapter.ts`, and it's additive by task mode, not by flag;
`src/inbound/tools.ts` exports a flat array. A flag-gated transfer tool needs adding to both lists.

Use the `z.enum(['true','false'])` boolean idiom, never `z.coerce.boolean()`.

### Ship cold transfer first

Warm transfer needs a second call leg, and `isAnyCallActive()` — `this.calls.size > 0` — is the
entire concurrency policy today; the inbound route declines any call while it's true. Real
concurrent-call handling is a prerequisite, and a bigger change than the transfer itself.

Also: `src/server.ts` logs the entire TwiML body at `info`. That's harmless now and leaks the
transfer destination number the moment `<Dial>` appears in it.

> **[Fixed]** with #7: `src/server.ts` and `TwilioProvider` now log
> `{ callId, twimlLength }`, never the TwiML body.

---

## 3. Disclosure, recording toggle, PII redaction

**Why:** these are features, not compliance paperwork. The TCPA/FCC and California AB 2905 exposure
sits on the *outbound* path, which is Banjo's whole product — an AI that calls people who did not
agree to be called by an AI. Getting this right is also just the decent thing to do to whoever picks
up the phone.

### Disclosure is weaker than it looks

> **Shipped** (#8, second PR) as a prompt rule plus a check, not the enforced verbatim opener
> sketched below. The decision on #8 was that a checked prompt rule was enough for now.
> `DISCLOSURE_LINE` (must say "AI") is Banjo's required first sentence on outbound calls, and the
> inbound greeting says it's an AI assistant. After each call, `call_attempts.disclosed` records
> whether Banjo's first line said "AI", and a miss is noted in the owner's notification.

`src/voice/systemPrompt.ts` currently says, in prose:

- "briefly identify yourself as calling on behalf of `<principal>`" — which does not require saying
  it's an AI, and
- "Never claim to be human **if directly asked**" — which is reactive.

Every greeting is model-generated from that guidance. There is no enforced string anywhere, so
whether a given call discloses at all depends on what the model felt like saying.

The enforcement primitive already exists: `sayVerbatim()` forces the next turn to speak exact text,
and `CallSession` already has `greetOnConnect` (currently true only for inbound). A fixed disclosure
line, spoken verbatim as the opening turn on outbound, is the fix — and `verbatimDeliveryReport()`
can verify it was actually said, on the provider that implements it.

### Recording

> **Shipped** (#8, third PR): `RECORD_CALLS`, off by default. A two-track Twilio recording starts only
> after Banjo has said the recording notice, which is appended to `DISCLOSURE_LINE`. Deleted after
> `RECORDING_RETENTION_DAYS` (30) by a daily sweep. Outbound only.

Nothing exists today: `calls.create` passes no `record` param and no audio is written anywhere.
Add it opt-in, with a retention window and a deletion job in the same change — a recording feature
without expiry is a liability generator. Recording consent is jurisdiction-dependent and the
disclosure line above is what makes it defensible.

### PII

> **Shipped** (#8, first PR): `src/lib/logger.ts` now has a `redact` config: phone fields masked to
> the last 4 digits, `outcome.message`/`outcome.details`/`argsStr` logged as a length, and the SMS
> failure log records only `outcome.kind`. Not covered: numbers quoted inside vendor error messages.

`src/lib/logger.ts` is 14 lines and has **no pino `redact` config**. Concretely:

- Inbound caller phone numbers are logged unredacted at `info`, on by default, at five sites in
  `src/server.ts` plus one in `src/inbound/callerContext.ts`.
- `src/notifications/twilioSms.ts` logs the whole `outcome` object at `error` level. That includes
  `voicemail_left.message` — the actual text spoken to the other party. Transcript-grade content,
  ungated.

The good pattern is already in the codebase: the provider adapters log `textLength` instead of
`text`. Generalise it, and add a `redact` config for phone-number-shaped fields.

### Open blocker, adjacent

Whether OpenAI Realtime's *audio* modality falls inside BAA scope is publicly unanswered. Get it in
writing from OpenAI before Banjo makes any HIPAA claim, or goes anywhere near a medical booking use
case as a supported path.
