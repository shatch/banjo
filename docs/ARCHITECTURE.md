# Banjo — Architecture

## What this is

Banjo is the phone-calling half of a two-part system that lets you hand errands to Claude in normal conversation — "Schedule a haircut with Clauda," "Schedule an appointment with Dr. Smith," "Make a reservation at Luigi's for Friday at 7pm" — and have them actually get done. This half handles the outbound-calling flow described below; Banjo also supports an inbound booking line — see `src/inbound/` — gated behind `INBOUND_BOOKING_ENABLED` until you're ready to expose it.

**The other half is a Claude Code skill** (`schedule-appointment`, shipped in this repo at [`skills/schedule-appointment/SKILL.md`](../skills/schedule-appointment/SKILL.md) — symlink it into `~/.claude/skills/schedule-appointment` to install). See [Skill vs. service split](#skill-vs-service-split) for why the system is split this way and what each half owns.

![Banjo runtime architecture — primary outbound-call path, the inbound path bypassing the orchestrator, provider abstractions, and trust boundaries](architecture-diagram.png)

---

## Skill vs. service split

Two genuinely different kinds of work are involved in "get this errand done," and they don't belong in the same place:

- **Placing a real phone call requires persistent infrastructure.** A running process holding a telephony account, streaming bidirectional audio over WebSockets to a real-time Voice AI model, for the duration of a live call — that can't be a lightweight, ephemeral thing. It has to be a deployed backend that's always on. This is Banjo.
- **Deciding how to book something, and attempting an online booking, is an open-ended per-website task.** Every business's booking flow is different — a form, a third-party platform (Vagaro, Booksy, Resy, ...), or nothing online at all. Writing bespoke scraper/API integrations into a backend for every possible booking site doesn't scale and isn't worth maintaining. Claude already has general-purpose browser automation tools, which is a far better fit for "go figure out how to book this specific website" than custom service code. This decision layer — and the online-booking attempts themselves — lives in the `schedule-appointment` skill, which calls into Banjo only when a phone call is the right move.

**Channel priority:** the skill prefers online booking when available, except where you have an established per-contact preference for calling instead (e.g. a specific business is bookable online, but you prefer a direct call there). When no preference is on file, the skill asks you once and persists the answer on the contact record (`preferredChannel`) — it doesn't re-ask on future requests to that contact, and it doesn't gate the actual time-negotiation on a live call behind a confirmation step (that stays autonomous-within-constraints; see [Error handling & state](#error-handling--state)).

---

## Architecture overview: task lifecycle

```
Steve, in conversation with Claude: "Schedule a haircut with Clauda"
  → Claude (running the schedule-appointment skill) calls find_contact("Clauda")
  → contact.preferredChannel known? if not, ask Steve once, persist via update_contact
  │
  ├─ ONLINE path (handled entirely by the skill, synchronously, via browser automation +
  │  the Google Calendar MCP tools already connected in Steve's environment):
  │     check availability → book on the site → create calendar event → record_task_outcome
  │
  └─ PHONE path (delegated to Banjo):
        Claude calls place_call(contactId, taskDescription, constraints)
        → Banjo: createTask (status: pending) → returns { taskId, ackMessage } immediately
        → Claude tells Steve: "Started calling Clauda's Salon, I'll let you know how it goes."
        → [async, in Banjo's orchestrator — src/tasks/orchestrator.ts]
           checking_availability (query Steve's Google Calendar → candidateWindows)
           → calling (build call system prompt, TelephonyProvider.originateCall() — Twilio outbound)
           → negotiating (call connects → CallSession pipes audio between TelephonyProvider ⇄ VoiceAIProvider)
              ├─ tool: check_my_availability  → live re-check if the offered time is outside candidateWindows
              ├─ tool: press_digits           → routed to TelephonyProvider (DTMF), not a backend service call
              ├─ tool: confirm_appointment    → writes event to Steve's calendar, idempotent → status: confirmed
              ├─ tool: leave_voicemail_and_end_call → status: voicemail_left
              ├─ tool: report_negotiation_failed    → status: negotiation_failed (reached a human, nothing fit)
              └─ tool: escalate_and_end_call        → status: escalated (genuinely stuck)
        → NotificationChannel.notify(taskId, outcome, summary) → Steve gets a text either way
        → Steve later asks Claude "how'd that go?" → get_task_status / list_recent_tasks
```

### Data lifecycle for one live call

```
Twilio (carrier-facing edge)
    │  outbound call originated via TelephonyProvider.originateCall()
    ▼
Call connects → CallSession created (src/session/callSession.ts)
    │
    ├─ TelephonyProvider normalizes inbound audio frames → AudioChunk (canonical PCM16, or passthrough mu-law)
    ▼
CallSession opens a VoiceAIProvider connection (factory picks impl from VOICE_AI_PROVIDER)
    │  VoiceAIProvider.connect(sessionConfig) — system instructions, tool definitions, audio format negotiation
    │
    ├─ inbound audio: TelephonyProvider → audioPipeline.inbound() → VoiceAIProvider.sendAudioChunk()
    │
    ├─ VoiceAIProvider emits normalized events:
    │     audio_chunk | transcript | tool_call | turn_end | interrupted | error | disconnected
    │
    ├─ on tool_call → CallSession looks up the tool by name, runs its handler against CalendarProvider/
    │        TelephonyProvider as needed → voiceAI.sendToolResult()
    │
    ├─ outbound audio: VoiceAIProvider audio_chunk → audioPipeline.outbound() → TelephonyProvider.sendAudio()
    │
    ▼
Call ends → CallSession.end() → VoiceAIProvider.disconnect() → notify Steve if the task reached a terminal state
```

The `CallSession` is the only component that touches both a `TelephonyProvider` and a `VoiceAIProvider` at once — neither provider layer is aware the other exists. This is what makes both sides independently swappable.

---

## Voice AI abstraction layer (`src/voice/`)

A normalized `VoiceAIProvider` interface (`src/voice/types.ts`), EventEmitter-style: `connect(config)`, `sendAudioChunk(chunk)`, `sendToolResult(id, result, isError?)`, `interrupt()`, `triggerResponse()`, `sayVerbatim(text)`, an optional `verbatimDeliveryReport()`, `disconnect()`, emitting a normalized `VoiceAIEvent` union (`connected | audio_chunk | transcript | tool_call | turn_end | interrupted | error | disconnected`). Canonical internal audio format is PCM16; each adapter negotiates/converts to its vendor's actual wire format. Tool definitions are Zod schemas (`src/voice/tools/callTools.ts`) converted once to JSON Schema and injected identically into every provider.

Four adapters (`src/voice/providers/{openai,openaiLive,gemini,elevenlabs}.ts`):

- **OpenAI Realtime** — `session.update` for config/tools, `input_audio_buffer.append` inbound, `response.output_audio.delta` outbound (GA event name — renamed from the beta `response.audio.delta`), function-calling via `conversation.item.create`/`response.create`. Supports G.711 µ-law passthrough — when paired with Twilio, audio can skip resampling entirely.
- **OpenAI GPT-Live** (`VOICE_AI_PROVIDER=openai-live` — ships dark, never verified on a live call) — `gpt-live-1`, a full-duplex voice front-end that delegates reasoning and tool calls to a separate Responses backend model (`OPENAI_LIVE_BACKEND_MODEL`). `session.start` on `wss://api.openai.com/v1/live/sessions`; tool schemas go under `delegation.responses.tools`, function calls arrive nested in `response.event`, and results return via `response.item.create` + `response.create`. The voice layer gets a narrower prompt (`VoiceAISessionConfig.frontendInstructions`, built by `buildCallFrontendPrompt`/`buildInboundFrontendPrompt` from `buildFrontendSystemPromptGuidance`) while the backend gets the full one. Two capabilities the rest of the system relies on don't exist on this wire and are synthesized inside the adapter: `turn_end` (an output-idle debounce — there is no `response.done`; GPT-Live streams digital-silence frames between utterances, which the adapter drops so they don't count as speech) and verbatim delivery (speak-then-verify: `sayVerbatim` appends an instruction, then `verbatimDeliveryReport()` compares the output transcript using `src/voice/verbatimMatch.ts`, and `leave_voicemail_and_end_call` records `voicemail_left` only on a match, escalating otherwise). `interrupt()` is a no-op. µ-law passthrough, with one audio format shared by both directions. Open risks #15–20.
- **Gemini Live** — hard-requires 16kHz PCM16 input / 24kHz PCM16 output; always needs the codec layer. Exact WebSocket message envelope names (setup/tool-call/tool-response) were not confirmed during design and are marked NEEDS VERIFICATION in the source.
- **ElevenLabs Conversational AI** — `conversation_initiation_client_data` init, `user_audio_chunk`/`audio` events, tool calls via `client_tool_call`/`client_tool_result` (ElevenLabs expects the WS client — us — to execute tools, which maps directly onto our tool registry). Also supports mu-law passthrough.

Provider selection is a factory/registry (`src/voice/factory.ts`) keyed by the `VOICE_AI_PROVIDER` env var. Adding a future provider (Grok, etc.) means: implement `VoiceAIProvider`, register it in the factory, add its env vars — nothing else in the codebase changes. (GPT-Live needed one additive exception: the optional `frontendInstructions` prompt and `verbatimDeliveryReport()` seam described above, which every other provider ignores.)

---

## Telephony gateway (`src/telephony/`) — outbound origination

```ts
export interface TelephonyProvider {
  originateCall(opts: { to: string; callId: string; answeringMachineDetection?: boolean }): Promise<{ providerCallId: string }>;
  sendAudio(callId: string, chunk: AudioChunk): void;
  sendDigits(callId: string, digits: string): Promise<void>; // DTMF, for IVR navigation
  interrupt(callId: string): void; // flush outbound buffer on caller barge-in
  hangUp(callId: string): Promise<void>;
  on(event: 'event', listener: TelephonyEventListener): void;
}
```

`TelephonyProvider` is kept as its own interface (rather than folded directly into `TwilioProvider`) so `CallSession` and its tests depend on a vendor-neutral audio-in/audio-out and control-action contract, the same seam `src/voice/`'s `VoiceAIProvider` abstraction uses. Twilio is the only implementation today — a LiveKit adapter was scaffolded early on but never got past non-functional audio I/O placeholders and carried zero live traffic, so it was removed rather than kept as unmaintained dead code (see git history around the `TELEPHONY_PROVIDER` env var if resurrecting a second provider is ever needed).

- **`providers/twilio.ts`** — `client.calls.create({ to, from, url: <TwiML that <Connect><Stream>s to our WS>, machineDetection: 'Enable', asyncAmd: true })`. Twilio's Answering Machine Detection (AMD) result arrives via a status-callback webhook — a concrete telephony-layer signal, not something the LLM has to infer from audio.
- **`dtmf.ts`** — the `press_digits` tool routes to `TelephonyProvider.sendDigits()`, not a domain/backend service. This is a deliberate architectural distinction from the calendar/task-backed tools in `voice/tools/callTools.ts`: DTMF is phone signaling, not AI speech, even though it's registered with the Voice AI provider exactly like any other tool.
- **`audio/codec.ts`** — `muLawToPcm16`, `pcm16ToMuLaw`, `resamplePcm16`. `src/session/audioPipeline.ts` resolves which conversion (if any) is needed once per call, based on `(telephony's native format, negotiated voice-AI format)`. When both sides support mu-law directly (OpenAI/ElevenLabs paired with Twilio), it's pure passthrough — a real latency/CPU win. A naive linear-interpolation resampler is used for v1; a proper resampling library is a flagged future upgrade, not a blocker.

---

## Data model (`src/contacts/`, `src/tasks/`)

**`contacts`** — shared by the skill (via MCP tools) and the calling flow:

```ts
{
  id, displayName, phoneNumber,           // E.164
  category,                                // salon | medical | restaurant | home_services | other
  preferredChannel,                        // 'phone' | 'online' | null — null = the skill asks once, then sets this
  bookingUrl,                              // for the skill's online-booking path
  notes,                                   // free text, injected into the live-call system prompt as context
}
```

**`tasks`** — generalized across both channels, so `list_recent_tasks` gives Steve one unified history:

```ts
{
  id, contactId, channel,                  // 'phone' | 'online'
  goalDescription, constraints,            // { dateWindows?, durationMinutes?, notes? }
  status, candidateWindows,                // phone path only — precomputed offerable slots
  outcome, calendarEventId,
}
```

**`call_attempts`** — child of a phone-channel task, tracks call *mechanics* separately from the task's *business outcome*:

```ts
{ id, taskId, providerCallId, status, answeredBy, startedAt, endedAt, errorDetail }
```

**Status lifecycle** (phone path):

```
pending → checking_availability → calling → negotiating
                                               ├─→ confirmed
                                               ├─→ voicemail_left
                                               ├─→ negotiation_failed   (reached a human, nothing fit)
                                               └─→ escalated            (AI got stuck)
any state → failed (technical/telephony error)   |   any pre-terminal state → cancelled
```

Separating `CallAttempt.status` (call mechanics) from `Task.status` (business outcome) distinguishes three failure shapes that need different framing when Steve is notified: "the call machinery broke" vs. "the call worked but nothing bookable came of it" vs. "the AI gave up mid-conversation." `src/tasks/service.ts`'s `transitionTask` is the only function that writes `Task.status`/`outcome`, avoiding races.

Online-path tasks skip the calling-specific intermediate states entirely — the skill logs them directly into a terminal status via `record_task_outcome`.

---

## Asynchronous tool interface for appointment scheduling

Tool schemas (`src/voice/tools/callTools.ts`, `src/telephony/dtmf.ts`) are Zod schemas — the single source of truth, converted once to JSON Schema (`src/voice/tools/defineVoiceTool.ts`) and injected identically into every provider's session config.

- **`check_my_availability(date, time, durationMinutes)`** — live query against Steve's calendar, used when the other party proposes a time outside the precomputed `candidateWindows` (which are an optimization/starting point, not the source of truth).
- **`confirm_appointment(confirmedStart, durationMinutes, details?)`** — writes the event to Steve's calendar. The idempotency key is derived **server-side** from `callAttemptId`, never trusted from model output — LLMs are unreliable at generating/reusing idempotency keys across retries. This means a dropped call right after a successful booking can't cause a duplicate calendar event if anything retries the tool call. Does **not** end the call itself — see `end_call` below.
- **`leave_voicemail_and_end_call(message)`**, **`report_negotiation_failed(reason)`**, **`escalate_and_end_call(reason)`** — the three distinct non-success terminal paths (see status lifecycle above); each ends the call itself.
- **`end_call(summary?)`** — the successful-completion path: ends the call after `confirm_appointment` has already recorded the outcome. Added after a real call was cut off mid-sentence because no existing tool represented "task succeeded, hang up cleanly" — the model reached for an ill-fitting tool instead. Doesn't set an outcome itself; if called without a prior outcome-setting tool having run, it's a safety net that marks the task `escalated` rather than leaving it stuck `negotiating` forever.
- **`press_digits(digits)`** — telephony-layer, not a domain-service tool (see Telephony gateway above).

**Ending a call without cutting off speech:** `TelephonyProvider.hangUp()` is a REST call that ends the Twilio leg immediately, but a tool call and the model's still-streaming trailing audio aren't sequenced against each other — there's no signal available for "the trailing audio has actually finished playing on the PSTN leg," only for when we finished sending chunks over the WS. All four call-ending tools go through `hangUpAfterSpeaking()` (`src/voice/tools/callTools.ts`), a pragmatic fixed grace period (2.5s) before the REST hangup fires — not a precise fix, but long enough for a short trailing sentence to finish playing. Caught for real on a live call: "Haircut appointment confirmed by phone for..." cut off mid-sentence before this existed.

**Timezone:** `CALENDAR_TIMEZONE` (IANA identifier, default `America/New_York`) is the single source of truth for what "2pm" means on a call and how times are written to the calendar — injected into the system prompt so the model knows which zone to speak in, and applied via `src/lib/timezone.ts`'s `zonedTimeToUtcIso()` (a dependency-free, DST-aware naive-local-time → UTC converter) wherever a tool receives a date/time. A real booking once landed 4 hours off (2pm requested, 10am on the calendar) because nothing told the model or the calendar-write path which zone was intended, and a bare `"2026-08-04T14:00:00"` with no offset was silently parsed as UTC.

**Handling calendar-API latency during a live call:** the shared system prompt (`src/voice/systemPrompt.ts`) instructs the model to tell the caller it's checking before waiting on a tool result — cheap, provider-agnostic, no architecture needed. Backed by a per-tool timeout (`TOOL_TIMEOUT_MS`, default 8s, via `src/lib/withTimeout.ts`) that returns a structured error the model can react to rather than hanging, and a session-level watchdog (`CallSession`) for tool calls stuck longer than expected regardless of cause.

**Voicemail vs. human vs. IVR:** lean on Twilio's AMD as a concrete telephony-layer signal rather than LLM audio inference where available. IVR menu navigation has no equivalent concrete signal — genuinely the least deterministic part of the system. The model listens to the menu transcript and calls `press_digits` when it identifies a relevant option; `escalate_and_end_call` is the honest fallback when it can't parse the menu, capped at a couple of attempts to avoid looping against a machine that won't accept what it keeps trying. Treat this path as best-effort, not reliable.

---

## Calendar (`src/calendar/`) — two separate integration points, by design

- **The skill's online-booking path** uses the Google Calendar MCP tools already connected in Steve's Claude Code environment directly — synchronous, inside the conversation, no reason to proxy through Banjo.
- **Banjo's phone-call path** (`src/calendar/googleCalendarProvider.ts`) has its own direct Google Calendar API client — OAuth2 user-consent flow (not service-account domain-wide delegation, which is the wrong fit for a personal calendar), because it must act autonomously during a live call, entirely outside any Claude conversation.

This is a deliberate duplication, not an oversight — the two paths genuinely can't share one client given their different execution contexts.

---

## Google Contacts (`src/googleContacts/`)

- **`src/googleContacts/`** — Google People API integration (same OAuth client as `src/calendar/`, a broader granted scope). A periodic full sync keeps a local cache of the principal's Google Contacts fresh; a cache-first lookup layer (with a live-API fallback on a miss, bounded by a hard timeout) resolves phone numbers/names for both directions — outbound `find_contact` and inbound caller ID — and auto-provisions/backfills matches into `src/contacts/`. See `docs/superpowers/specs/2026-09-07-google-contacts-integration-design.md` for the full design.

---

## MCP server (`src/mcp/`)

Exposed over **HTTP/SSE (remote MCP)**, since Banjo runs as a persistent AWS service rather than being spawned locally by Claude Code — the endpoint requires a bearer token (`MCP_API_KEY`) since it's internet-reachable. Tools:

- **`place_call(contactId, taskDescription, constraints)`** → creates a phone-channel `Task`, fires off orchestration asynchronously (a periodic poller also picks up any non-terminal task, so this is self-healing across a container restart), returns `{ taskId, ackMessage }` immediately.
- **`get_task_status(taskId)`**, **`list_recent_tasks(limit?)`** — status/history lookups.
- **`find_contact(query)`**, **`list_contacts(category?)`**, **`add_contact(...)`**, **`update_contact(id, { preferredChannel?, bookingUrl?, notes? })`** — contact directory management.
- **`record_task_outcome(contactId, goalDescription, outcome)`** — lets the skill log a completed online booking into the same task history as phone-based tasks.

---

## Error handling & state

- **Telephony socket drops mid-call:** no auto-resume is possible (PSTN doesn't support it) — `CallSession` disconnects the Voice AI leg immediately (avoids leaking billed connection time), records the failure, and the task moves to `failed`. Steve has to call back himself; that's a hard constraint of telephony, not a design gap.
- **Voice AI provider errors:** each adapter is responsible for surfacing errors via the normalized `error` event; `CallSession`'s current v1 behavior is to fail the call attempt rather than attempt an in-session reconnect (a reconnect-with-condensed-context-replay is a reasonable v1.1 addition, deliberately out of scope for the initial scaffold — these are short calls, so a failed attempt surfacing to Steve promptly is an acceptable v1 behavior).
- **Mid-call provider swap** is architecturally possible (both `TelephonyProvider` and `VoiceAIProvider` are swappable independently, and nothing in `CallSession` assumes a specific vendor) but not wired up as an automatic trigger — intentional scope, not a gap.
- **Appointment booking state — the critical correctness property:** Postgres is the source of truth, never "whatever the model said out loud" and never Google Calendar alone. `confirm_appointment`'s server-generated idempotency key (see above) means a call dropping immediately after a successful booking is not data loss — the row/event is already durably confirmed — just a UX gap where Steve might need to check `list_recent_tasks` to see it if he didn't hear the confirmation live.
- **Autonomous booking authority:** the AI can finalize/confirm on the call as long as the offered time fits the constraints Steve gave upfront — no mid-call check-back. This is a deliberate choice (see Skill vs. service split) distinct from channel selection, which *does* get a one-time check-in with Steve when unknown.

---

## Configuration

Zod-validated env schema (`src/config/index.ts`), parsed and validated at process start (imported first in `src/index.ts`) — the process fails fast on a missing/invalid value rather than discovering it mid-call. See `.env.example` for the full list of variables; cross-field `.refine()` checks enforce that only the credentials matching the *selected* `VOICE_AI_PROVIDER`/`TELEPHONY_PROVIDER`/`NOTIFICATION_CHANNEL` are required.

---

## Open risks / things to verify during real implementation

This list was written at design time, before any real-call testing had happened. Since then the project has been almost entirely live-call-driven (place a real call → read logs → fix the exact root cause), which has resolved some of these items and left others untouched. Triaged below by what actually needs doing next, not by original numbering.

See also [`docs/COMPETITIVE_LANDSCAPE.md`](COMPETITIVE_LANDSCAPE.md): a research pass comparing this project's `src/voice/`/`src/telephony/` abstraction against dedicated open-source frameworks (Pipecat, LiveKit Agents, Vocode, Bolna) that solve the same problem, and the roadmap for if/when wrapping one of them underneath the existing `VoiceAIProvider`/`TelephonyProvider` interfaces becomes worth doing.

### Must fix before any use beyond your own local live-testing

_(none currently open — #14 below was the one item here, now fixed)_

### Should fix soon (active call path, unverified, but degrades rather than breaks)

_(none currently open — #12 below was the one item here, now fixed)_

### Defer (theoretical, low-probability, or already-accepted tradeoff)

8. **[OPEN, accepted for v1]** `GoogleCalendarProvider`'s idempotency check-then-insert has a small race window (two near-simultaneous calls with the *same* idempotency key could both pass the check before either inserts) — this is distinct from the double-booking guard added in `d523f83` (which checks whether the slot is free at all) and remains exactly as originally documented. Requires near-simultaneous duplicate calls with the identical key; this system is single-caller-at-a-time by design, so real-world likelihood is low. A Postgres-backed idempotency table would close it fully if concurrent usage ever becomes real.
9. **[OPEN, accepted tradeoff]** Naive linear-interpolation resampler (`src/telephony/audio/codec.ts`) is correctness-only, not production audio quality — already self-documented as an accepted v1 tradeoff. Only exercised on the Gemini path, which isn't the active provider, so it currently affects nothing live.

### Don't fix — inactive/aspirational code paths, no live traffic today

`VOICE_AI_PROVIDER=openai` is the only actively-used voice provider. Gemini is fully scaffolded but carries zero live traffic — investing further here has no payoff until there's an actual decision to switch:

2. **[OPEN, unused]** Gemini Live's exact WebSocket message envelope names (setup/tool-call/tool-response) — `src/voice/providers/gemini.ts` is explicitly labeled a "best-effort structural sketch," every method still flagged NEEDS VERIFICATION.

### GPT-Live (`openai-live`) — ships dark; verify on a real call before any switch

`src/voice/providers/openaiLive.ts` was built against openai-node's SDK types (2026-09-12), then taken on seven live test calls the same evening: a short smoke test, a ~7.5-minute conversation, a voicemail, a ~5.5-minute conversation, and three short scripted calls (a song, a critique conversation, and a lullaby). `session.start`, audio both ways, transcripts, and delegation all work, and the callee confirmed the headline improvement unprompted — background music no longer made the assistant stop talking. The first conversation call also found GPT-Live streams output audio continuously, padding gaps with digital-silence frames: forwarded as-is, `turn_end` never fired once and no assistant transcript was ever logged. The adapter now drops silent frames, confirmed on every later call (for example 3 and 23 synthesized `turn_end`s, with assistant transcripts logged). `gpt-realtime` remains the default and the only provider carrying traffic. Before considering a switch:

15. **[OPEN]** No barge-in flush. GPT-Live has no interruption event, so `CallSession` never sends Twilio's `clear` control frame (`src/telephony/providers/twilio.ts`), and queued outbound audio keeps playing if the callee talks over the model. Full duplex may make this moot — the model is meant to handle overlap itself — but that is unverified.
16. **[OPEN]** Both debounce values are guesses. `OUTPUT_IDLE_TURN_END_MS` (600ms) synthesizes `turn_end`: too low fires inside a natural pause, too high adds latency to every hang-up tool's `TURN_END_WAIT_MS` wait. `TRANSCRIPT_IDLE_FINAL_MS` (1200ms — raised from 600ms after the first live call split caller speech at nearly every pause) synthesizes final transcripts for both sides, including the user transcript that arms the silence watchdog — and a full-duplex model that deliberately stays quiet through a long "hold on, let me check" could trip `SILENCE_WATCHDOG_MS`'s nudge-then-fail path in a way turn-based `gpt-realtime` never did. Tune both on a real call.
17. **[OPEN]** Backend model id unconfirmed. OpenAI's docs show `gpt-5.6-terra` and `gpt-5.6-luna` in different examples (both are valid Responses model ids in openai-node), so `OPENAI_LIVE_BACKEND_MODEL` is configurable, defaulting to `gpt-5.6-terra`. Confirm against the live API.
18. **[OPEN]** Error classification unimplemented. Like the other three adapters, every GPT-Live error is emitted `retryable: true` — load-bearing on the teardown path since #14 — and GPT-Live's error codes are not yet known.
19. **[OPEN]** Cost has a different shape: $0.05/min for the voice layer plus backend model tokens, billed separately, vs `gpt-realtime`'s audio-token pricing. The adapter logs `session.usage.updated`'s cumulative `usage.seconds`; compare real call spend before any default switch.
20. **[OPEN]** Speak-then-verify has matched real audio once — a voicemail call recorded `voicemail_left` after its output transcript matched the intended message — but one pass is not a track record. `sayVerbatim` uses `session.instructions.append` (500-token cap; `session.commentary.append` is the untried alternative), and `src/voice/verbatimMatch.ts` is deliberately strict — a contraction the model expands, or a number it spells out ("twenty"), fails the match and routes a voicemail to `escalated`. That false-negative direction is intentional (a false match would re-open #13); watch the real escalation rate. The prompt split is untuned too: the voice layer has no candidate windows or timezone contract, so every time check is a delegation round-trip.
21. **[OPEN, seen live — blocks conversation mode on `openai-live`]** The voice layer does not end free-form conversations. (a) On the 7.5-minute call, when the callee said "we should hang up now… Bye", the model did not delegate `end_conversation_call`; the callee hung up and the task landed in `failed` (reason `stop`) rather than `conversation_completed`. Its three delegations all came back as text (`response.output_text.delta`), with no function call. (b) Reproduced on a ~5.5-minute call whose goal said explicitly to end the call itself after a goodbye: the model said goodbye three times but made **zero** delegations the entire call, so again the callee hung up into `failed`. By contrast, the smoke test did delegate `end_call` and a voicemail call delegated `leave_voicemail_and_end_call` correctly — the gap is specifically ending a free-form conversation. (c) On that voicemail call the voice layer said its reasoning aloud to the machine ("Okay, that's a voicemail greeting, so I should leave a message now") before delegating; the frontend prompt should forbid narrating decisions. (d) The 7.5-minute call's callee twice said the assistant "cut out"; none were reported on the later 5.5-minute call. **Mitigation applied:** the voice-layer prompt (`DELEGATION_GUIDANCE` in `src/voice/systemPrompt.ts`, plus the conversation-mode guidance in `buildCallFrontendPrompt`) now says outright that saying goodbye does not hang up, that ending the call must be delegated immediately after the goodbye, and that reasoning must never be said aloud. The base prompt other providers receive is unchanged. If a live call still stays open through goodbyes, the fallback is to record a callee hang-up after a normal conversation as `conversation_completed` rather than `failed`. **First live result (2026-09-12, ~1.5-minute call):** the model delegated `end_conversation_call` right after its goodbye — the hang-up request went out ~4 seconds after "Bye!" and the task landed in `conversation_completed` with a model-written summary. A second call (~2 minutes, a back-and-forth conversation) did the same — hang-up ~3 seconds after the callee's "Bye", outcome `conversation_completed` — though the voice layer said "Great, ending the call now" aloud as it hung up, a small slip against the no-narration rule. A third (a ~40-second lullaby call) also hung up by itself, with no narration. Keep watching on later calls.

### Removed (was #3: LiveKit telephony provider)

The LiveKit `TelephonyProvider` adapter (`src/telephony/providers/livekit.ts` — self-labeled "THE LEAST-VERIFIED FILE IN THE SCAFFOLD," with `sendAudio`/`sendDigits`/`interrupt` as non-functional placeholders and no media-bridge dependency even installed) was deleted outright rather than kept as unmaintained dead code. Twilio is now the only telephony provider; `TELEPHONY_PROVIDER`/`LIVEKIT_*` env vars are gone. If LiveKit support is ever wanted again, treat it as a fresh implementation against current LiveKit SIP/Agents docs rather than resurrecting this one.

### Already resolved (doc was stale)

1. **[FIXED]** Exact OpenAI Realtime event name for "tool call arguments complete" — verified directly against `openai-node`'s source after two live-call failures (commits `1eafc4c`, `1f42342`, `2b6932a`); `src/voice/providers/openai.ts` now documents the confirmed event names.
4. **[FIXED]** Twilio AMD parameter/webhook field names — confirmed against current Twilio docs: `machineDetection`/`asyncAmd`/`asyncAmdStatusCallback` are the correct SDK mapping, and `MachineDetection: 'Enable'` (the mode requested) returns one of `human`/`machine_start`/`fax`/`unknown`. Verifying this surfaced a real bug beyond the param names themselves: the AMD callback route (`src/server.ts`) called `telephony.handleAmdCallback?.(...)` on a method `TwilioProvider` never implemented, so the optional call silently no-op'd on every real call — AMD was requested but its result never reached `CallSession` or the DB. Now implemented (`TwilioProvider.handleAmdCallback`); `TelephonyEvent`'s `answeredBy` union corrected to match what `Enable` mode can actually return (dropped a `DetectMessageEnd`-only value it never used, added the missing `fax`).
5. **[FIXED]** `press_digits` — confirmed on two fronts. (a) Mechanism: confirmed against Twilio's Media Streams WebSocket Messages docs that a server can only send `media`/`mark`/`clear` to Twilio over a bidirectional stream; Twilio's `dtmf` message type is inbound-only (detecting the *caller's* keypresses), so there is no signaling-level way to inject DTMF outbound — synthesizing tone-pair audio and sending it as a `media` frame (already implemented) isn't a workaround, it's the only mechanism Twilio offers. (b) Live-verified: a real test call had the model invoke `press_digits('123')` mid-call; Steve, live on the line, confirmed hearing three clear, distinct touch-tone beeps. Still open: whether a real automated IVR's DTMF *recognizer* (as opposed to a human ear) reliably registers these synthesized tones is unverified — different, lower-priority question than "does audio actually get sent."
6. **[FIXED in practice]** `@modelcontextprotocol/sdk`'s exact HTTP/SSE transport API surface — `src/mcp/server.ts` still carries stale NEEDS VERIFICATION comments, but this session's own `claude mcp add` + live tool use against it just proved the SSE wiring works end-to-end.
10. **[FIXED, process]** `MCP_API_KEY` needed a real secrets-management story since the endpoint is internet-reachable (confirmed reachable this session via the ngrok `PUBLIC_HOSTNAME` and a working `claude mcp add`). No code gap existed — bearer-auth was already enforced (`src/mcp/server.ts`'s `requireAuth`) — the actual gap was no documented rotation procedure. Written up as `docs/RUNBOOKS.md`'s "Rotating MCP_API_KEY". Full secrets-manager integration (automatic rotation, audit trail) is still not in place; the runbook is the manual stopgap until Banjo has a real cloud deployment to integrate one against.
12. **[FIXED]** Outbound calls had no path for a purely conversational task (no booking/negotiation goal) — see design spec `docs/superpowers/specs/2026-08-12-outbound-conversational-call-design.md` and implementation plan `docs/superpowers/plans/2026-08-12-outbound-conversational-call.md`. `place_call` now accepts an optional `mode: 'booking' | 'conversation'` (defaults to `'booking'`, so every existing call site is unaffected); conversation-mode tasks get the full existing toolset plus a new `end_conversation_call(summary)` tool, and the outbound system prompt gains explicit guidance not to treat "no booking outcome" as a reason to end the call early. Implemented via a 5-task multi-agent workflow (commits `a7baaa9`..`cc766de`), each task reviewed individually plus a final whole-plan review, all clean — 230/230 tests, typecheck and build both clean. Not yet re-verified against a real live call (the two failures that motivated this were both live-call reproductions); worth one more real test call before fully trusting this closes the gap.
11. **[FIXED]** `CallSession`'s transcript logging (`src/session/callSession.ts`) previously wrote raw spoken conversation content to application logs at info level, unconditionally — call transcripts can contain PII, medical/appointment details, identity-verification info a business asks for. Now gated behind `LOG_TRANSCRIPTS` (`src/config/index.ts`, off by default) — logging is opt-in for local-dev debugging rather than unconditional. Redaction of known-sensitive patterns / routing to a properly access-controlled log sink is still a further hardening step, not yet done, but the unconditional-exposure risk itself is closed.
13. **[FIXED, structural — not yet exercised against a live call]** Call-ending tools accepted the spoken content as an *argument* but never uttered it, so a message could be recorded as delivered while the callee heard nothing. Reproduced live twice on `leave_voicemail_and_end_call` (`src/voice/tools/callTools.ts`): the model said a short preamble, passed the real message as the tool argument, and the handler ran `transitionTask(... 'voicemail_left' ...)` then `hangUpAfterSpeaking(ctx)` — which only waits for whatever had already been spoken. Result: the callee got a truncated fragment while the DB, `get_task_status`, and the outcome SMS all asserted a full message had been left. An earlier same-day prompt-only mitigation (telling the model to speak the message itself before calling the tool) was superseded by this fix rather than kept — it depended on the model getting the sequencing right, a prompt-shaped guarantee for a correctness-shaped problem. Same bug family as `6c058eb` ("require a spoken goodbye before ending any call"), which fixed the `end_call` path but not this one.

    **Fix:** delivery no longer depends on the model. `VoiceAIProvider` gained `sayVerbatim(text)` (`src/voice/types.ts`) — implemented for OpenAI (`src/voice/providers/openai.ts`) via `response.create`'s `response.instructions` field, confirmed against OpenAI's Realtime API docs (2026-09-01) to override the session's standing instructions for one response only; Gemini/ElevenLabs get best-effort stubs consistent with their existing NEEDS-VERIFICATION posture, since neither carries live traffic. `VoiceTool` gained an optional `verbatimMessage(input): string` (`src/voice/tools/defineVoiceTool.ts`) — when a tool declares it, `CallSession.handleToolCall` (`src/session/callSession.ts`) calls `sayVerbatim` with the extracted text and waits for its `turn_end` (bounded by `SPEAK_VERBATIM_TIMEOUT_MS`, 20s, with the session's `toolPendingWatchdog` re-armed to a larger budget for this case) *before* the tool's handler ever runs — so the handler still just records the outcome and hangs up, unchanged, but the recorded outcome and the delivered audio now come from the same forced turn and cannot diverge. `leaveVoicemailAndEndCallTool` is the only tool that declares `verbatimMessage`; its prompt copy (the tool description, `src/tasks/promptBuilder.ts`, `src/voice/systemPrompt.ts`) was updated to tell the model to pass the message as the argument and NOT say it itself first, since the system now speaks it and saying it twice would be a regression.

    **Audit of the other `endsCall: true` tools**, per this item's original note: `report_negotiation_failed`, `escalate_and_end_call`, and `end_conversation_call` all take a `reason`/`summary` argument, but on inspection those are metadata for Steve's benefit (why the call ended a certain way), never content the other party is meant to hear — none of them declare `verbatimMessage`, and that's correct, not an oversight (asserted directly in `tests/voice/callTools.test.ts`).

    **Test coverage added:** `tests/session/callSession.test.ts` asserts `sayVerbatim` is called with the exact extracted text and that `buildToolContext`/the handler do not run until its `turn_end` resolves (plus a timeout-fallback test); `tests/voice/callTools.test.ts` asserts `verbatimMessage` extraction and the negative case on the other three tools. Typecheck and the full suite (244/244) pass, and every touched file's `tsx watch` restart came up clean.

    **Still not done:** this has never been exercised against a real phone call — `response.create.response.instructions` is confirmed against OpenAI's docs, not against live audio, and the model is documented as *guided*, not *forced*, by an instructions override (it could still paraphrase or add words). The next real voicemail call after this change should be checked against the transcript in `/tmp/banjo-dev.log`, not the recorded outcome, the same caution that applied to the superseded prompt-only mitigation.

14. **[FIXED, not yet re-verified against a live call]** A retryable Voice AI error could kill the whole call abruptly (no goodbye) instead of being tolerated. Reproduced live on a conversation-mode call to a test contact (2026-09-01, `callId d38b79ab`): the assistant delivered its opening line in full, the contact replied ("Oh my God.") and then had a few turns of cross-talk with someone else in the room. `SILENCE_WATCHDOG_MS` (`src/session/callSession.ts`) fired its recovery nudge — `voiceAI.triggerResponse()`, which sends OpenAI a `response.create` — at the same moment OpenAI's own server-side VAD had already started a response on its own. OpenAI rejected the collision: `"Conversation already has an active response in progress... conversation_already_has_active_response"`, `retryable: true`. `CallSession.handleVoiceAIEvent`'s `case 'error'` unconditionally called `this.fail('voice_ai_error', ...)` for *any* Voice AI error — `VoiceAIError.retryable` (`src/voice/types.ts`) was set correctly by the OpenAI adapter but was never read anywhere in `callSession.ts`, so a genuinely recoverable "you already have a response in flight" condition tore down the whole call exactly like a fatal one. Net effect: the message got through, but the contact's line just went dead afterward with no goodbye, indistinguishable to them from a crash.

    **Fix (both independent gaps closed):** (a) `CallSession` now tracks `responseActive` — set on `tool_call`/`audio_chunk` (evidence a response is under way by any means) and whenever `CallSession` triggers a response itself (the opening greeting, the silence-watchdog nudge — both routed through a new `triggerVoiceAIResponse()` helper), cleared on `turn_end`. `handleSilenceWatchdogFired`'s first-firing branch now skips sending the nudge (logging instead) when `responseActive` is already true — this closes the reachable case, a caller talking over a still-in-progress response `CallSession` itself started (e.g. barging in on the greeting) before it reaches `turn_end`; it deliberately does not mark the nudge as "sent" in that case, so the give-up path on a genuinely stuck call still fires on schedule. (b) `handleVoiceAIEvent`'s `case 'error'` now consults `event.error.retryable`: a retryable error is logged and the call continues; a non-retryable error still calls `fail()` exactly as before.

    **Test coverage added:** `tests/session/callSession.test.ts` — a retryable `VoiceAIError` doesn't fail the call (no `onStatusChange({kind: 'failed'})`, no hangup, no voice-AI disconnect) while a non-retryable one still does, unchanged; and the silence watchdog doesn't send a second `triggerResponse()` when the greeting response it already triggered hasn't reached `turn_end` yet. 247/247 tests pass, typecheck clean.

    **Still not done:** not yet exercised against a real phone call — the exact race (our watchdog firing at the same instant OpenAI's server-side VAD auto-starts a response, before any client-observable event tells us so) can't be fully closed from `CallSession`'s side without an additional provider-level signal; fix (a) closes the one reachable case (a response `CallSession` itself knows it started) but the truly simultaneous VAD-vs-watchdog race relies on fix (b) tolerating the resulting error rather than preventing it outright. Next real conversation-mode call should be checked against `/tmp/banjo-dev.log` for another `conversation_already_has_active_response` and confirmed the call continued normally afterward, the same caution as every other fix in this list.

### Operational, not a code fix

7. IVR navigation reliability — genuinely the least deterministic part of the system; no IVR-specific logic exists to patch. Track the real rate of `escalated` outcomes on IVR-heavy contacts over time; improves only with prompt tuning against real usage, not a bug to find.
