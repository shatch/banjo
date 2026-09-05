# Competitive landscape & roadmap

Research pass (2026-09-05, `deep-research` workflow — 102 agent calls, 20 sources, 85 claims extracted, 25
adversarially verified) comparing Banjo against other open-source projects in the same space, to answer two
questions: is Banjo differentiated enough to publish, and is there a better foundation to build on. Full
sourced report: [Banjo Gap Analysis](https://claude.ai/code/artifact/b68822b6-c23c-4a35-afc2-83552c562905).

## Verdict

Open source Banjo as-is. No surveyed project combines its five layers — swappable voice-AI + telephony
provider abstractions, contacts with cross-channel preference, a task/negotiation state machine, direct
calendar booking, and an MCP server exposing calling as a tool to an AI coding assistant. Every close analog
covers one or two of those layers, not the set.

The one real caveat: Banjo's own voice/telephony abstraction — the layer *underneath* what makes it
distinctive — is less mature than frameworks purpose-built for exactly that problem. That's a hardening item,
not a reason to hold the release. See [Roadmap](#roadmap-voicetelephony-abstraction) below.

## How Banjo compares

| Project | Covers | Missing, vs. Banjo |
| --- | --- | --- |
| [`ai-dialer`](https://github.com/askjohngeorge/ai-dialer) | Outbound scheduling calls | All-in on VAPI.ai, no provider abstraction; self-disclosed demo, not production |
| [`audiocall`](https://github.com/Iamsdt/audiocall) | Twilio + Gemini Live bridge (closest architectural analog) | No contacts, task/negotiation state machine, calendar, or MCP layer |
| [`ai-calling-agent`](https://github.com/revolutionarybukhari/ai-calling-agent) | Call handling + STT/TTS | No booking, calendar, contacts, or negotiation |
| [`appointment-agent`](https://github.com/mjunaidca/appointment-agent) | LangGraph + Bland.com booking calls | Single hardcoded vendor call, no state machine; calls are confirmation-only, not live negotiation |
| [`Outbound-Real-State-Voice-AI-Agent`](https://github.com/Awaisali36/Outbound-Real-State-Voice-AI-Agent-) | Scheduled sales-lead dialing (n8n + VAPI) | Not general-purpose booking; fully SaaS-dependent |
| [`Mcp_calender_agent`](https://github.com/kristofferv98/Mcp_calender_agent) | Calendar via MCP (macOS only) | No phone-calling capability at all |

## The real gap: the abstraction layer, not the product

Generic open-source voice-AI/telephony frameworks — **Pipecat**, **LiveKit Agents**, **Vocode**, **Bolna** —
already solve the problem `src/voice/` and `src/telephony/` solve, and in places do it better:

- **Pipecat** ships maintained serializers for six telephony providers (Twilio, Telnyx, Plivo, Exotel,
  Genesys, Vonage) vs. Banjo's one (Twilio only; Gemini/ElevenLabs voice-AI adapters are still "scaffolded
  but unverified" per `docs/ARCHITECTURE.md`).
- **LiveKit Agents** has native SIP trunking plus its own self-hostable, Apache-licensed media server, built-in
  MCP tool support, and multi-agent handoffs.
- **Vocode** supports full DTMF and call-transfer on both Twilio and Vonage — Banjo only reaches DTMF on
  Twilio via a synthesized-audio workaround (`src/telephony/dtmf.ts`), because Twilio's WebSocket protocol has
  no signaling-level way to inject DTMF tones.
- **Bolna** and Vocode both treat outbound dialing as first-class, same as Banjo.

(Sources: forasoft.com, roomkit.live, thinnest.ai, webrtc.ventures — see the full report for quotes and
verification votes.)

## Roadmap: voice/telephony abstraction

**Not swapping now.** Replacing `VoiceAIProvider`/`TelephonyProvider` means rewriting the core session engine
(`src/session/callSession.ts`, `audioPipeline.ts`) that the orchestrator, MCP tools, and contacts layer all sit
on top of — rewrite-scale risk to a path that already carries live traffic and has absorbed real-call-driven
fixes (the timezone bug, the retryable-vs-fatal error handling fix, see `docs/ARCHITECTURE.md`'s Open Risks).
Native SIP trunking and six-provider telephony coverage don't serve any need Banjo has today: Twilio + OpenAI
Realtime already works end to end for the only path carrying real traffic.

Documented candidates for if/when that changes:

- **Wrap Pipecat underneath the existing interfaces** if broader telephony-provider coverage (Telnyx, Plivo,
  Exotel, Genesys, Vonage) becomes a real requirement — e.g. a user needs a provider Twilio doesn't serve well
  in their region.
- **Wrap LiveKit Agents underneath the existing interfaces** if native SIP trunking becomes a real requirement
  — e.g. DTMF reliability against real automated IVRs (open item #5 in `docs/ARCHITECTURE.md`) turns out to
  need signaling-level DTMF rather than synthesized audio, or multi-provider telephony without a Twilio bridge
  becomes worth the switch.

Either is an **incremental adapter behind the current `VoiceAIProvider`/`TelephonyProvider` interfaces**, not a
rewrite of `callSession.ts` or anything above it — the abstraction boundary already exists for exactly this
reason. Revisit only when one of the trigger conditions above is real, not pre-emptively.

## Feature roadmap: two-way SMS with contacts

Today's SMS (`src/notifications/twilioSms.ts`) is one-way and owner-facing only — task-outcome summaries and
ad-hoc alerts sent *to* `NOTIFY_TO_PHONE_NUMBER`. It has no relationship to the contact being called and can't
carry a conversation. A genuinely new capability — negotiating or confirming a booking over text with the
*contact*, not the owner — would be a real differentiator: none of the surveyed projects offer a contact-facing
texting channel either (this wasn't a dedicated search target, so treat as directionally true, not verified).
Also directly useful on its own: plenty of real businesses (salons, restaurants) are text-first and don't pick
up calls from unknown numbers at all.

**Why it's not a small bolt-on:** the call path's whole shape — realtime audio, `VoiceAIProvider`'s
audio-chunk/turn-taking events, the silence/tool-call watchdogs — doesn't apply to text. A text conversation
also isn't bounded by "the call is still connected"; it can go quiet for hours between replies. This needs a
parallel, simpler orchestration path, not a mode flag inside `callSession.ts`.

What it would take, roughly in dependency order:

1. **Inbound SMS webhook.** New Hono route (analogous to Twilio's existing voice/AMD webhooks in
   `src/server.ts`) verifying Twilio's signature, parsing `From`/`Body`, and looking up the task by phone
   number + open text-conversation state.
2. **A text-session driver**, structurally much simpler than `CallSession`: no audio pipeline, no VAD race —
   just "append inbound message → run one LLM tool-calling turn → send outbound reply and/or transition task
   state." Could reuse the same Zod tool schemas from `src/voice/tools/callTools.ts` where the tool is
   content-agnostic (`confirm_appointment`, `escalate_and_end_call`-equivalents), converted through the
   existing `defineVoiceTool.ts` JSON-Schema path (or a renamed, provider-agnostic sibling) rather than
   duplicating tool definitions.
3. **New persistence**, mirroring how `call_attempts` is deliberately kept separate from a task's business
   outcome: a `text_attempts`-shaped table (message log, direction, timestamps) alongside `tasks`/`contacts` in
   `src/tasks/schema.ts` / a new `src/texting/schema.ts`. `transitionTask` (`src/tasks/service.ts`) stays the
   only writer of task status/outcome, unchanged.
4. **Orchestrator awareness.** `src/tasks/orchestrator.ts`'s state machine needs a channel dimension (phone vs.
   sms) and, since texting isn't bounded like a call, a reply-timeout that escalates or fails a task after N
   hours of silence — the existing periodic poller (already self-healing across restarts) is the natural place
   to drive this, not a new watchdog class.
5. **Contact model.** `contacts.preferredChannel` (currently online vs. phone) needs a third value, or a
   separate `acceptsSms` capability flag distinct from channel preference, since a contact could accept both a
   call and a text.
6. **MCP surface.** `placeCall` either grows a `channel` param or gets an analogous `sendText`/`startTextTask`
   tool; `getTaskStatus`/`listRecentTasks` are already channel-agnostic and need no change.

**Rough sizing:** not a quick patch — new provider-shaped abstraction, new webhook surface, new schema +
migration, and a new (if simpler) orchestration path with its own tests mirroring existing conventions
(`tests/texting/...` mocking at the interface boundary, matching `tests/session/callSession.test.ts`'s
pattern). Comparable in shape to the original inbound-calling feature (`src/inbound/`), not a few-hour addition.

## White space (lower confidence — worth leaning into, not yet confirmed as unclaimed)

- **MCP-server bridge to an AI coding assistant** — no verified competing project exposes outbound calling as
  an MCP tool. Most defensible differentiator found, but this is an absence-of-evidence finding from a
  non-exhaustive search; worth a sharper, dedicated search on "MCP + outbound calling" before leaning on it in
  public-facing copy.
- **Data-integrity model** (Postgres source of truth, server-generated idempotent confirmation keys, a
  self-healing state-machine poller) — no surveyed project's description mentions anything comparable, but this
  wasn't verified against their source, only their README-level descriptions.
- **Shared `preferredChannel` routing** between an online-booking agent and a phone-calling fallback — exactly
  the seam between Banjo and the sibling `schedule-appointment` skill. No comparable project appears to treat
  channel choice as a persistent, per-contact decision at all.

## Caveats

Several sources are vendor-comparison blogs with a possible commercial angle; this surveyed a sample of repos
and blog comparisons, not an exhaustive census (a few of the most exciting-sounding "direct competitor"
candidates — e.g. `dograh-hq/dograh`, `soulee-dev/AICaller` — were refuted on direct inspection). The space
moved fast through 2025–2026, so any framework-capability claim here has a shelf life of months. "Has the
feature" was verified — not "the feature works well at scale," license compatibility, or community health.
