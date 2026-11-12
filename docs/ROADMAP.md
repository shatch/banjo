# Roadmap

Items 1–3 were the first three pieces of work, in dependency order; most of each has shipped.
[Next](#next) is what comes after them. Each item has (or will get) a tracking issue; this file
holds the reasoning and the seams, so the issues can stay short.

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

> **Cold transfer shipped** with #7 ([PR #67](https://github.com/shatch/banjo/pull/67)): `TRANSFER_ENABLED`,
> `TRANSFER_TO_PHONE_NUMBER`, a REST-redirect `<Dial>` to one fixed number, only after the other
> party agrees, gated on both the tool and the prompt rule. See `docs/ARCHITECTURE.md`'s "Call
> transfer (#7)" section for how it works. Since then: the principal's phone hears "press 1 to take
> it" before a cold transfer is bridged (#74), so a voicemail can't take the call, and **warm
> transfer** is built as `TRANSFER_MODE=warm` ([#149]): Banjo briefs the principal on a second line
> and bridges only on a 1. Warm mode is opt-in and not yet verified on a live call. Still open: a
> cold transfer arrives with no spoken context about who is on the line or why.

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

---

## Next

**Why:** the gap now is reach, not capability. Banjo works, but almost nobody who would want it can
find it, and almost nobody who finds it can try it. Meanwhile hosted calling services (Ring-a-Ding
and others) have started filling the "give my agent a phone" slot in the OpenClaw and MCP
ecosystems. They can't offer what Banjo can: self-hosted, your own number, your calendar and
contacts, Postgres-checked bookings, and guardrails (call cap, AI disclosure) that make it safe to
hand to an autonomous agent. Everything below either gets that in front of people or makes it
easier to try. None of it changes what Banjo is (see `CONTRIBUTING.md`): no UI, no tenants,
outbound first.

Where this stands as of v0.1.21 (2026-11-12): 4.1–4.6 have shipped, and so has everything in 4.7
except cancel-or-reschedule. What's left, in order:

1. **Open call-conduct issues** found on real calls, such as [#204] (a Spanish-first menu) and
   [#250] (a wrong number's sales menu).
2. **4.7 cancel or reschedule.**
3. **4.8 easier self-hosting and more vendors.**

The order the shipped items were built in, and why: the text simulator first (wait-on-hold couldn't
be built without one, since the per-number call cap rules out redialling one phone tree over and
over); then call and ask ([#148]), which every other errand is built on; then warm loop-in
([#149]), which wait-on-hold hands off through; then wait on hold ([#151]); then owner approval and
pre-dial screening ([#150]).

### 4.1 Streamable HTTP transport for the MCP server

> **Shipped** in v0.1.4.

`src/mcp/server.ts` serves only the legacy HTTP+SSE transport (`/mcp/sse` + `/mcp/messages`),
which the MCP spec has deprecated in favour of Streamable HTTP. Newer clients and the official MCP
Registry expect Streamable HTTP, so this is the prerequisite for 4.2 and 4.3. Add a `/mcp` endpoint
on `StreamableHTTPServerTransport` behind the same bearer-token middleware, and keep SSE for now
so existing Claude Code configs don't break. Stateless mode is worth considering: it would also
stop every app restart from dropping the client's MCP session.

### 4.2 Agent-neutral skill, published to the skill registries

> **Shipped** in v0.1.4.

`skills/schedule-appointment/SKILL.md` is already in the open SKILL.md format that ClawHub
(OpenClaw), agentskills.io (Hermes Agent) and skills.sh index. What ties it to Claude Code is
its step 3, which names `mcp__plugin_playwright_playwright__*` and `claude-in-chrome` for the
online path. Rewrite those references by capability ("whatever browser and calendar tools are
connected") so one file works in any agent, then publish it. Consider a second, smaller skill
(`phone-errand`) for non-booking calls, once 4.7 makes them first-class.

### 4.3 Directory listings and per-agent setup guides

> **Shipped** in v0.1.4.

- List the MCP server where people search for one: the official MCP Registry (needs a
  `server.json`), Glama, Smithery, and the Claude Code plugin marketplaces.
- A `docs/AGENTS.md` (or README section) with a tested connection snippet for each client: Claude
  Code, OpenClaw, Hermes Agent. Hermes and OpenClaw both sit behind messaging gateways (Telegram,
  WhatsApp, …), which is the best demo Banjo has: text your agent "get me a haircut Thursday",
  and a booking confirmation arrives on your phone.
- A Claude Code plugin bundling the skill and the MCP server config, so it installs in one step.

Each guide must say whether it was tested against a real install. Listing an untested client as
supported is how a two-star repo gets a one-star review.

### 4.4 Push task results to the caller

> **Shipped** in v0.1.4.

Agents learn a call's outcome today by polling `get_task_status`. Claude Code with the skill can
manage that, but an autonomous agent woken by a chat message has nothing to poll from. Add an
opt-in outbound webhook (`TASK_WEBHOOK_URL`, HMAC-signed) fired on every terminal transition, from
the same place `notifyIfTerminal` fires, so it can't disagree with the owner notification. Like
notifications, a failed webhook must never throw into a call or a transition.

### 4.5 A text-mode simulator

> **Shipped** as `npm run sim` (`src/sim/`; `scripts/sim.ts` is a wrapper). The voice side is OpenAI
> Realtime in text-only mode (`OpenAIRealtimeProvider({ textOnly: true })`), so it runs the same
> model, prompt and tools as a call. The phone line, calendar and voice provider are swapped in
> through override seams in the three factories. The sim uses its own `banjo_sim` database. Since
> v0.1.21 it also runs from the published image with only Docker and an OpenAI key
> (`docker compose run --rm sim`). Built on it: scripted runs that can play a phone menu or hold
> queue, and scenario evals (`npm run eval`, `evals/scenarios/`) that run against the real model
> when the prompt changes. What text can't test, audio, is covered by phone-line fixtures on a
> number of our own (`npm run fixtures:call`: voicemail, phone menu, hold). Not yet covered:
> inbound calls.

`CONTRIBUTING.md` says it plainly: there is no offline simulator. Trying Banjo today takes Twilio,
a voice-AI key, a public hostname and, for SMS, A2P registration. That's too much to ask of
someone who just landed on the README. `npm run sim` should run the real system prompt and real
tool handlers against a stub `TelephonyProvider` and a text-only model session, with you typing as
the business. A first-time visitor could watch Banjo negotiate a booking in two minutes, and a
contributor could exercise a prompt change without spending a call.

Seams: the `TelephonyProvider` interface is already the mock boundary in tests. The open question
is the voice side. A text-mode `VoiceAIProvider` (OpenAI Realtime supports text-only sessions)
keeps the real event flow through `CallSession`. Tools should hit a throwaway database, never the
dev `banjo` DB, and calendar writes should go to a dry-run `CalendarProvider`.

### 4.6 Owner approval before dialing

> **Shipped**, in a different shape from the sketch below. There is no `REQUIRE_CALL_APPROVAL`
> flag. Approval follows the key: a call placed with the agent key (`MCP_AGENT_API_KEY`) waits
> until the owner taps Approve on a signed link, and is cancelled after 30 minutes; a call placed
> with the owner's key dials at once. Screening shipped as `SCREEN_CALLS` ([#150], off by default),
> and it holds a call for the owner's approval; it never refuses one. It still fails closed: if the
> check can't run, the call waits for approval.

An autonomous agent can now place calls on a principal's behalf without a human in the loop. An
opt-in `REQUIRE_CALL_APPROVAL` makes `place_call` create the task as pending approval and send the
owner an accept/decline prompt (Pushover supports reply callbacks; a signed link works for any
channel). Dialing starts only on accept, and the task expires to `cancelled` if nobody answers.
Together with the per-number call cap and AI disclosure, this is the "safe to give an agent a
phone" story that hosted services don't tell.

**Pre-dial screening** ([#150]) is the automatic layer for installs that don't want to approve
every call. Opt-in `SCREEN_CALLS` checks a request before it's dialled. Refusing a number whose
last call ended with "don't call me again" needs no model. A model check covers the instructions
(e.g. a task asking Banjo to collect someone's card number or one-time code). The principal is
trusted, but the agent calling `place_call` may be wrong or prompt-injected. It shares 4.6's
refusal path, and fails closed: if the check errors, no call is placed.

### 4.7 Errands beyond booking

- **Call and ask** ([#148]): hours, stock, a quote, availability, with a structured answer back
  to the agent. **Shipped** as `place_call`'s `mode: 'ask'` with `questions`: the task ends
  `answered`, with `outcome.answers` holding one entry per question. Ask calls get no calendar
  tools, and they book and agree to nothing.
- **Cancel or reschedule** an appointment Banjo booked, keyed off the stored outcome so Postgres
  stays the source of truth.
- **Warm loop-in** ([#149]): today's `transfer_to_owner` is a cold transfer, so a principal who
  doesn't pick up sends the other party to voicemail. Instead, call the principal on a second
  line, brief them, and bridge only on a yes; on a no, no answer or their voicemail, Banjo goes
  back to the call and carries on. **Built** as `TRANSFER_MODE=warm` (opt-in; default stays
  `cold` until a live call verifies the accept and decline paths).
- **Wait on hold** ([#151]): get through the phone tree with `press_digits`, detect hold music
  or silence without hanging up, and loop in the principal when a human answers. Needs a
  hold-aware silence watchdog (today's would end the call), hold music kept from triggering server
  VAD, and an upper time limit. This is the feature people would share. **Shipped** as `wait_on_hold`
  (`openai` and `openai-live`) with `HOLD_MAX_MINUTES`, and checked on real calls against the hold
  fixture. It also covers a phone's call screen and a voicemail greeting that plays mid-hold
  (#238). On `openai-live` it is unverified on a live call.
- **Phone menus that ignore tones** (#225): `press_digits` plays tones as audio, which Twilio's own
  menus don't detect. **Shipped** in v0.1.21: the same digits pressed again go out as a real key
  press, by redirecting the call and reconnecting its audio.
- **Ask the owner mid-call**: **shipped** as `ask_owner` (`ASK_OWNER_ENABLED`). Banjo sends the
  principal a question with a signed link and relays the typed answer to the live call.

### 4.8 Easier self-hosting and more vendors

- A Home Assistant add-on, Unraid/CasaOS templates, and a Railway or Fly template.
- Notification channels people ask for: Telegram, ntfy, Discord, a generic webhook. All go
  behind `createNotificationChannel()` / `sendOwnerMessage()`.
- A second telephony provider (Telnyx or a generic SIP trunk). It's cheaper and avoids the 10DLC
  wall, and it would show the `TelephonyProvider` seam working with more than one vendor.
- Finish verifying the Gemini and ElevenLabs adapters (Open Risks in `docs/ARCHITECTURE.md`), and
  add a Microsoft 365 `CalendarProvider`.

[#204]: https://github.com/shatch/banjo/issues/204
[#250]: https://github.com/shatch/banjo/issues/250
[#148]: https://github.com/shatch/banjo/issues/148
[#149]: https://github.com/shatch/banjo/issues/149
[#150]: https://github.com/shatch/banjo/issues/150
[#151]: https://github.com/shatch/banjo/issues/151
