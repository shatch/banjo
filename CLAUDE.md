# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`banjo` (package name `banjo`, internal naming still says `ea` in places — see below) is an open-source, self-hostable AI executive assistant that places real outbound phone calls on a user's behalf (e.g. "Schedule a haircut," "Make a reservation at Luigi's for Friday at 7pm"). It's the phone-calling half of a two-part system — the other half is a Claude Code skill (`schedule-appointment`, shipped in this repo at `skills/schedule-appointment/`) that decides whether to book online or delegate to this service, and calls in only for the phone path.

Full design rationale, the "why" behind every architectural seam, known open risks, and a running log of real-call-driven fixes live in **`docs/ARCHITECTURE.md`** — read it before making non-trivial changes to call flow, provider adapters, or the data model. Operational procedures (e.g. rotating `MCP_API_KEY`) live in **`docs/RUNBOOKS.md`**.

Note: the repo was recently renamed from `ea` to `banjo` (see git history — "chore: scaffold Banjo from ea"). Some internal identifiers, docs prose, and test fixtures still say `ea`/`EA` — don't be surprised by the mismatch.

## Commands

```bash
npm run dev              # tsx watch src/index.ts — local dev server with hot reload
npm run build             # tsc -p tsconfig.build.json
npm start                 # node dist/index.js (run build first)
npm test                  # vitest run — full suite
npm run test:watch        # vitest, watch mode
npx vitest run tests/session/callSession.test.ts   # single test file
npx vitest run -t "test name substring"            # single test by name
npm run typecheck         # tsc --noEmit
npm run db:generate        # drizzle-kit generate (runs build first)
npm run db:migrate         # drizzle-kit migrate (runs build first)
npm run db:studio          # drizzle-kit studio
npm run test:call          # tsx scripts/manual-test-call.ts — places a real outbound call for manual testing
docker compose up          # Postgres + Banjo in Docker (migrations applied on boot)
docker compose up -d postgres   # just Postgres (banjo/banjo/banjo on :5432), for `npm run dev`
```

Env schema is Zod-validated at process start (`src/config/index.ts`, imported first in `src/index.ts`) — copy `.env.example` to `.env` and fill in credentials for whichever `VOICE_AI_PROVIDER`/telephony/notification vendor you're using; cross-field `.refine()` checks only require the vars matching the *selected* providers.

Tests don't need a real `.env` — `vitest.config.ts` injects a full baseline of fake-but-valid env vars so provider/tool modules can be imported in isolation. `tests/config.test.ts` is the one place that deliberately overrides individual vars to exercise validation itself.

`drizzle/` is committed, and `runMigrations()` (`src/db/migrate.ts`) applies unapplied migrations at startup, gated on `RUN_MIGRATIONS_ON_BOOT` (default true). After changing any `schema.ts`, run `npm run db:generate` and commit the generated SQL with it. Boot migrations only touch `DATABASE_URL`, so `banjo_test` is always migrated explicitly — see README's "Test database".

## Architecture

The system is two independently-swappable vendor abstraction layers, glued together by one component that's aware of both.

- **`src/voice/`** — `VoiceAIProvider` interface (`types.ts`), normalized events (`audio_chunk | transcript | tool_call | turn_end | interrupted | error | disconnected`), canonical internal audio format PCM16. Four adapters in `providers/{openai,openaiLive,gemini,elevenlabs}.ts` — **OpenAI Realtime is the only one carrying live traffic today**; `openai-live` (GPT-Live) ships dark: tested on live calls, but not the default; Gemini and ElevenLabs are scaffolded but unverified (see Open Risks in `docs/ARCHITECTURE.md`). Selected via `VOICE_AI_PROVIDER` through the factory in `factory.ts`. Tool schemas are Zod (`tools/callTools.ts`), converted once to JSON Schema (`tools/defineVoiceTool.ts`) and injected identically into every provider.
- **`src/telephony/`** — `TelephonyProvider` interface, Twilio is the only implementation (`providers/twilio.ts`); a LiveKit adapter was scaffolded and later deleted outright as unmaintained dead code rather than kept around. `dtmf.ts` handles the `press_digits` tool by synthesizing DTMF tones as outbound audio (Twilio's WS protocol has no signaling-level way to inject DTMF). `audio/codec.ts` handles µ-law↔PCM16 conversion — passthrough (no conversion) when both telephony and voice-AI sides support µ-law directly, which is the current OpenAI+Twilio path.
- **`src/session/callSession.ts`** — the only component that touches both a `TelephonyProvider` and a `VoiceAIProvider` at once. Owns per-call state (`responseActive` tracking to avoid colliding with server-side VAD, the silence watchdog, the tool-call watchdog), pipes audio both directions via `audioPipeline.ts`, and dispatches `tool_call` events to the right handler.
- **`src/tasks/orchestrator.ts`** — drives a phone-channel task through its async state machine (`pending → checking_availability → calling → negotiating → {confirmed | voicemail_left | negotiation_failed | escalated | conversation_completed | failed}`, or `cancelled` before the call starts). A periodic poller picks up any non-terminal task, making the flow self-healing across a process restart; it also starts scheduled calls (`place_call`'s `scheduledFor`) once due, claiming a `pending` task with a compare-and-set so two processes can't both dial it.
- **`src/calendar/googleCalendarProvider.ts`** — direct Google Calendar API client (OAuth2 user-consent, not service-account) used only by the phone-call path, since it must act autonomously mid-call with no Claude conversation involved. This is deliberately separate from the skill's own (out-of-repo) use of Google Calendar MCP tools during online booking — the two paths can't share a client given their different execution contexts.
- **`src/mcp/server.ts`** — the surface Claude Code (running the `schedule-appointment` skill) talks to. Exposed over HTTP/SSE (remote MCP, since this runs as a persistent service) with a required bearer token (`MCP_API_KEY`). Tools live in `src/mcp/tools/`: `placeCall`, `getTaskStatus`, `cancelTask`, `stopCall` (hangs up a call already in progress, via the per-process `src/tasks/liveCalls.ts` registry — `cancelTask` only reaches calls not yet placed), `listRecentTasks`, `getCallTranscript` (reads `call_transcript_turns`), `findContact`, `listContacts`, `addContact`, `updateContact`, `recordTaskOutcome`.
- **`src/contacts/`, `src/tasks/`, `src/inbound/`** (Drizzle schemas in each dir's `schema.ts`, combined in `src/db/schema.ts`) — `contacts` (shared by skill and calling flow, `preferredChannel` persists the online-vs-phone decision per contact), `tasks` (unified history across both channels), `call_attempts` (call *mechanics*, kept separate from a task's *business outcome* — `src/tasks/service.ts`'s `transitionTask` is the only function that writes task status/outcome, to avoid races; it refuses to move a task out of a terminal status, and its `from` option makes a transition a compare-and-set). `src/inbound/` supports an inbound booking line, gated fully off by `INBOUND_BOOKING_ENABLED` until ready.

**Notifications:** `NOTIFICATION_CHANNEL` (`twilio_sms` | `pushover` | `none`). End-of-call summaries go through `createNotificationChannel()`, and one-off messages to the owner (inbound bookings, flagged calls, late-booking corrections) through `sendOwnerMessage()`, both in `src/notifications/owner.ts` — call those, never a specific channel's sender. Sending must never throw into a call.

**Critical correctness property:** Postgres is the source of truth for whether an appointment was booked — never "whatever the model said out loud," never Google Calendar alone. `confirm_appointment`'s idempotency key is generated server-side from `callAttemptId`, never trusted from model output.

**Timezone:** `CALENDAR_TIMEZONE` (default `America/New_York`) is the single source of truth for what a spoken time means; conversions go through `src/lib/timezone.ts`'s `zonedTimeToUtcIso()`. A real booking once landed 4 hours off because this wasn't enforced everywhere — don't reintroduce a bare unzoned timestamp on any call-facing or calendar-write path.

**AI disclosure:** outbound calls must open with `DISCLOSURE_LINE` (config-validated to say "AI"). It's a prompt rule in `src/voice/systemPrompt.ts`, checked afterwards by `session/disclosure.ts` into `call_attempts.disclosed`. Don't weaken the rule's wording or the "AI" validation; they are the only disclosure mechanism.

**Recording:** `RECORD_CALLS` recordings must start only after Banjo has said the recording notice (`RECORDING_NOTICE`, appended to the opener by `disclosureLine()`). Never start recording at answer: disclosure isn't enforced, so this ordering is the consent guarantee.

**Transcripts:** `call_transcript_turns` (`src/transcripts/`) is written only through `CallSessionOptions.onTranscript`, never `transitionTask` (its compare-and-set would drop transcripts of finished calls), and is off unless `PERSIST_TRANSCRIPTS=true`. A failed save must never affect the call. Retention (`TRANSCRIPT_RETENTION_DAYS`) runs even with saving off.

**Owner profile:** `PROMPT_PROFILE_FILE` (`src/tasks/ownerProfile.ts`) is the only user-customizable part of the call prompt: added to outbound prompts after every fixed rule, which it's told it cannot override. Put new customization there, not in a way that lets users replace the rules in `src/voice/systemPrompt.ts`.

**Call-ending tools** (`leave_voicemail_and_end_call`, `report_negotiation_failed`, `escalate_and_end_call`, `end_call`, `end_conversation_call`) all route through `hangUpAfterSpeaking()` (`src/voice/tools/callTools.ts`) rather than hanging up immediately, so trailing speech isn't cut off. `leaveVoicemailAndEndCallTool` is the only tool that declares `verbatimMessage` (forces the exact message to be spoken via `VoiceAIProvider.sayVerbatim`, so delivered audio and recorded outcome can't diverge) — don't add `verbatimMessage` to the other terminal tools; their `reason`/`summary` args are metadata for the user, not content the callee is meant to hear.

## Testing conventions

- Tests mirror `src/` structure under `tests/`.
- Provider/session tests mock at the `VoiceAIProvider`/`TelephonyProvider` interface boundary rather than vendor SDKs directly, matching the abstraction layers above.
- When touching call-ending or error-handling logic in `callSession.ts`, check `VoiceAIError.retryable` semantics — not every Voice AI `error` event should fail the call (see the retryable-vs-fatal fix in `docs/ARCHITECTURE.md`'s Open Risks item #14).
- DB-backed suites run against the dedicated `banjo_test` database (`vitest.config.ts`), never the dev `banjo` database. Files run serially against that one shared database, so clear every table a file writes both before each test and after its last one — a row left behind breaks another file's setup, and only when vitest happens to order that file next.
