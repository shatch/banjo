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
| [`dograh`](https://github.com/dograh-hq/dograh) | **The primary comparable** (added 2026-09-21). Open-source self-hostable voice-AI platform; MCP-native, BYOK across LLM/STT/TTS, 7+ telephony providers, one-command Docker self-host, visual workflow builder, hosted cloud | Not an errand-runner: no task/negotiation state machine for booking on your behalf, no contacts with cross-channel preference, no direct calendar booking. Ahead of Banjo on packaging, provider breadth and adoption |
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

- ~~**MCP-server bridge to an AI coding assistant** — no verified competing project exposes outbound calling as
  an MCP tool. Most defensible differentiator found~~ — **retracted 2026-09-21.** The caveat on this bullet
  ("an absence-of-evidence finding from a non-exhaustive search; worth a sharper, dedicated search before
  leaning on it in public-facing copy") turned out to be the operative part. Dograh is MCP-native in its own
  repo tagline and ships a Claude Code setup plugin. Do not use MCP-native as a differentiator in public copy.
- **Data-integrity model** (Postgres source of truth, server-generated idempotent confirmation keys, a
  self-healing state-machine poller) — no surveyed project's description mentions anything comparable, but this
  wasn't verified against their source, only their README-level descriptions.
- **Shared `preferredChannel` routing** between an online-booking agent and a phone-calling fallback — exactly
  the seam between Banjo and the sibling `schedule-appointment` skill. No comparable project appears to treat
  channel choice as a persistent, per-contact decision at all.

## Caveats

Several sources are vendor-comparison blogs with a possible commercial angle; this surveyed a sample of repos
and blog comparisons, not an exhaustive census (`soulee-dev/AICaller` was refuted on direct inspection —
`dograh-hq/dograh` was dismissed here too, and **that call was wrong**; see the
[2026-09-21 correction](#2026-09-21-correction-dograh-is-the-primary-comparable)). The space
moved fast through 2025–2026, so any framework-capability claim here has a shelf life of months. "Has the
feature" was verified — not "the feature works well at scale," license compatibility, or community health.

---

# 2026-09-17 update: ElevenLabs Reception

ElevenLabs announced [Reception](https://elevenlabs.io/blog/reception) (reception.ai) on **2026-09-16** — a
packaged vertical SaaS AI receptionist built on ElevenAgents, aimed at small businesses (home services,
salons, clinics, real estate, property management). This section records what it actually ships and where it
does and doesn't touch Banjo.

Sources: [product page](https://elevenlabs.io/reception), [launch post](https://elevenlabs.io/blog/reception),
[docs overview](https://elevenlabs.io/docs/reception-ai/overview),
[receptionist capabilities](https://elevenlabs.io/docs/reception-ai/receptionist/overview),
[scheduling](https://elevenlabs.io/docs/reception-ai/scheduling/overview),
[inbox](https://elevenlabs.io/docs/reception-ai/features/inbox),
[knowledge base](https://elevenlabs.io/docs/reception-ai/knowledge-base/overview).

## What Reception ships

| Area | Capability |
| --- | --- |
| Direction | **Inbound only.** No outbound calling or automated callbacks appear anywhere in the docs. |
| Onboarding | Point it at your website; it scrapes services, hours, team and location into a knowledge base. Claimed sub-5-minute setup. |
| Calls | 24/7 answering, personalized greetings, 70+ languages with automatic mid-call language detection, 2,000+ voices |
| Booking | Four-way resource model — services x staff x assets (rooms/equipment) x availability. Multi-location with per-location hours and staff. Time-off blocking. Google Calendar sync. |
| Channels | Phone + web chat + public self-serve booking page, all backed by one agent |
| Transfers | Up to 10 intent-routed transfer rules per receptionist |
| Messages | Takes messages with priority levels; **texts an SMS confirmation to the caller** |
| Inbox | Every call stored with transcript, metadata, outcome summary; voicemails; and *knowledge gaps* (questions the agent couldn't answer) |
| CRM | Auto-built client profiles with interaction history |
| Analytics | Performance and revenue tracking |
| Integrations | Google Calendar, Zapier (all paid tiers), webhooks (Plus/Premium) |
| Scale | Multiple receptionists per account on higher tiers (per department, location or language) |
| Pricing | $29 / 75 min / 1 concurrent call; $79 / 275 min / 3; $199 / 1,000 min / 10. Overage $0.45 -> $0.30/min. |
| Stated gaps | No HIPAA compliance. No outbound. No self-hosting or multi-tenant deployment. |

## The framing: these are near-inverse products

Reception answers calls *for a business*. Banjo places calls *for a person*. Reception has no outbound
capability at all, which means Banjo's entire primary path (`place_call` -> negotiate -> confirm -> notify,
plus AMD-driven voicemail, DTMF, and scheduled calls) has **zero overlap** with it.

The overlap is exactly one module: `src/inbound/`, still gated off behind `INBOUND_BOOKING_ENABLED`. That's
where this analysis has teeth, and everything below is scoped to it.

**Strategic stance: not a race.** Banjo isn't trying to beat Reception on features or price — a funded vendor
will always win a packaged-SMB-SaaS feature race. The goal is to be the version companies and individuals can
read, self-host, and fork into their own. Capability gaps matter only where they stop someone from building
their own Reception on top of Banjo; they don't matter as scorecard entries.

## Where Reception is ahead (all of it inbound)

| Capability | Reception | Banjo | Notes |
| --- | --- | --- | --- |
| Knowledge base | Website-scraped, automatic | none | `src/inbound/systemPrompt.ts` is a static prompt. No business-facts store. |
| Booking resource model | services x staff x assets x locations | single calendar, single duration | `INBOUND_DEFAULT_DURATION_MINUTES` + one `GOOGLE_CALENDAR_ID`. |
| Business hours | per-location, per-staff, time-off | one global window | `src/inbound/businessHours.ts` is a single rectangle — no holidays or exceptions. |
| Call transfer | 10 intent-based rules | none | Banjo's only escape hatch is `flag_for_owner_and_end_call` — hang up and notify. |
| Caller-facing SMS | confirmation texted to caller | none | Banjo's SMS is one-way, owner-facing only (`NOTIFY_TO_PHONE_NUMBER`). See the two-way SMS roadmap item above. |
| Transcripts / recordings | stored, searchable inbox | transcripts, opt-in | `PERSIST_TRANSCRIPTS` stores every line (`call_transcript_turns`, 30-day default retention), read with `get_call_transcript`. No audio recording, no search or inbox UI. |
| Knowledge-gap capture | logs unanswered questions for review | none | Cheap to copy and genuinely useful. |
| Language auto-detect | 70+, switches mid-call | provider default, unconfigured | |
| Web chat + booking page | yes | none | Banjo is phone-only. |
| Analytics / CRM history | dashboard, revenue tracking | none | Banjo has no UI; `listRecentTasks` over MCP is the entire reporting surface. |
| Multi-agent / multi-tenant | multiple receptionists | single-tenant | Deliberate design choice, not a defect. |

## Where Banjo is ahead

1. **Outbound calling, full stop.** The negotiation state machine, AMD-driven voicemail, DTMF against IVRs,
   and scheduled calls with compare-and-set claiming. Not a feature flag away for Reception — a different
   product.
2. **MCP surface.** Nine tools exposed to an AI coding assistant. Reception offers Zapier and webhooks;
   nothing agent-native.
3. **Vendor-swappable voice AI.** Four adapters behind one interface; Reception is ElevenLabs-locked by
   construction.
4. **Data-integrity model.** Postgres as source of truth, server-generated idempotency keys from
   `callAttemptId`, `transitionTask` as sole status writer with terminal-status refusal, self-healing poller.
5. **Timezone discipline.** `zonedTimeToUtcIso()` enforced on every calendar-write path.
6. **Self-hosting and data ownership.** Your Twilio, your calendar, your Postgres, MIT-licensed. Reception has
   no HIPAA story; a self-hosted instance makes that a conversation you control.
7. **Cross-channel contact routing.** `contacts.preferredChannel` persisting the online-vs-phone decision
   across the skill and the call path.

## What's worth taking

Three cheap, high-leverage items. (#1 turned out not to be inbound-only: the write path goes through `callSession.ts` and both adapters. It shipped in #6.)

1. **Persist transcripts + outcome summaries.** Every provider adapter already emits `transcript` events that
   currently go only to the logger. A table keyed to `call_attempts`/`inbound_calls` is a schema change plus a
   write, and it unblocks everything else here. Highest value per line of code in the repo today.
2. **Knowledge-gap logging.** When the inbound agent can't answer, record the question rather than only
   flagging the owner. Nearly free given #1.
3. **Caller-facing SMS confirmation.** A deliberate narrowing of the two-way-SMS roadmap item above: one-way
   "you're booked for X" to the *caller* after `book_appointment` needs no inbound webhook, no text-session
   driver, and no message-log schema — roughly 10% of that item's cost for most of its perceived value.

Explicitly **not** chasing: the services/staff/assets resource model and the analytics dashboard. Both are
SMB-business features. Banjo is a single-person assistant; building a staff scheduler into it means chasing
Reception into a market it has already packaged and priced for. If a forker needs that, the right answer is
that the seams let them build it — not that Banjo ships it.

## Pricing note

$29/month for 75 minutes resets the floor of this category. It doesn't threaten Banjo's outbound path, but it
does mean the inbound booking line has to justify itself on ownership and integration (your data, your
calendar, MCP-native, agent-controllable) rather than on capability or cost — at 75 min/month, self-hosting is
not obviously cheaper once realtime audio tokens are counted alongside Twilio minutes.

---

# 2026-09-21 correction: Dograh is the primary comparable

The 2026-09-05 pass listed [`dograh-hq/dograh`](https://github.com/dograh-hq/dograh) among "exciting-sounding
direct competitor candidates" that "were refuted on direct inspection." **That was wrong.** Verified live via
the GitHub API on 2026-09-21: 5,692 stars, 1,423 forks, BSD-2-Clause, pushed that day. Its own repo
description reads "Open source voice AI platform. Self-hosted alternative to Vapi and Retell. On Prem, BYOK
across Speech to Speech or LLM/STT/TTS, with a visual workflow builder, MCP native and telephony support."
It was #1 Product of the Day, Week and Month on Product Hunt, self-hosts via a single `curl` + start script,
and ships an official Claude Code plugin so a coding agent can install it.

## What this changes

- **"MCP-native" is not a differentiator.** Retracted above in [White space](#white-space-lower-confidence--worth-leaning-into-not-yet-confirmed-as-unclaimed).
  Dograh is MCP-native and better packaged. Do not put it in public-facing copy as a wedge.
- **"Open-source self-hostable vendor-swappable voice AI" is taken**, by a project with a year's head start,
  a hosted-cloud revenue line, and a deployment story Banjo does not currently match.
- **The Verdict's five-layer claim still holds, but for a narrower reason than stated.** Dograh has the
  provider abstractions and the MCP surface; it does not have the task/negotiation state machine, contacts
  with cross-channel preference, or direct calendar booking. The differentiator is the *errand-running
  assistant*, not the voice/telephony plumbing.
- **Positioning implication:** Banjo is an AI assistant that makes your phone calls for you, that you run
  yourself — an errand-runner, not a receptionist and not a voice-agent platform. Reception answers calls for
  a business; Dograh is a platform for building business voice agents; Banjo places calls for a person.

Full sourced analysis, including the ranked fork-blockers, per-minute cost table, the TCPA/AI-disclosure
exposure on the outbound path, and an explicit list of refuted and unverified claims:
[Banjo vs Reception — Strategy](https://claude.ai/code/artifact/a050344f-b407-4496-8531-56b86885a117).

**Method note.** The deep-research harness's adversarial verification stage did not complete (session limits);
3 claims reached a full 3-0 vote, 4 were refuted, 18 were extracted but never voted on. The decisive sources
above were opened and verified directly instead. One refuted item to avoid repeating anywhere: the
"16% of failed projects had contributing guidelines vs 72% of top projects / 27% vs 68% for CI" statistic did
not survive verification against its cited source.

---

# 2026-10-21 update: LiveKit revisited

A fresh look at [LiveKit](https://livekit.com/) (Agents framework, SIP, Cloud), since the 2026-09-05 pass only
covered it as an abstraction-layer candidate. Sources were LiveKit's own docs, blog and pricing page, read
directly. LiveKit's accuracy numbers are from their own, unpublished datasets.

## The framing: infrastructure, not a competitor

LiveKit is a voice-agent framework (Apache-2.0, Python and Node), a media server, a SIP gateway and a paid
cloud. It has nothing at Banjo's product layer: no task state machine, booking or calendar, no contacts,
approvals or call caps, no disclosure or recording-consent ordering, no owner notifications, no MCP surface
for an assistant to delegate calls to. The overlap is everything under `CallSession`.

## What it now ships that touches Banjo's open problems

| Area | Banjo | LiveKit |
| --- | --- | --- |
| DTMF | Tones synthesized as audio (`dtmf.ts`); IVR recognition unverified (Open Risks #5) | RFC 2833/4733 at the SIP level |
| Transfer | Twilio redirect to `<Dial>`; warm via conference (#149) | SIP REFER cold transfer, plus built-in warm transfer |
| Answering machines | None since Twilio AMD was turned off (#23, #32) | Rule + LLM classifier on the first transcript, out of band, defaults to human; human/voicemail/IVR/unavailable; ~97% macro F1, 840 ms median ([blog](https://livekit.com/blog/answering-machine-detection)) |
| Phone menus | `wait_on_hold` judging plus menu rules | Detects a menu and navigates it with DTMF automatically (Python only) |
| Interruptions | OpenAI server-side voice detection | Audio model that tells barge-in from "uh-huh" (LiveKit Cloud only) |
| Noise | OpenAI noise reduction | Krisp noise cancellation per trunk or call |
| Testing | `npm run sim`, by hand | Text-mode unit tests that assert tool calls (pytest/Vitest), plus multi-turn simulations ([docs](https://docs.livekit.io/agents/build/testing/)) |

Pricing (LiveKit Cloud, 2026-10): about $0.01/min per agent session and $0.003–0.004/min for third-party SIP,
on top of the carrier. The turn detector model is under a separate LiveKit Model License, not Apache.

## What to take

- **The answering-machine design, rebuilt on Banjo's hold judging:** [#187](https://github.com/shatch/banjo/issues/187).
  `judgeHoldLine` already does the out-of-band judgment; run it on the first line after pickup.
- **Scenario evals on top of the sim,** modeled on LiveKit's text-mode tool-call tests:
  [#188](https://github.com/shatch/banjo/issues/188).

## What not to take (for now)

- **Moving `CallSession` onto LiveKit Agents.** All of Banjo's call-conduct logic lives there, so it would be a
  rewrite. Same verdict as the [Roadmap](#roadmap-voicetelephony-abstraction) above.
- **A LiveKit SIP `TelephonyProvider`.** It would get real DTMF and REFER, through a self-hosted LiveKit server,
  SIP server and Redis (on a 4 GB node) or through LiveKit Cloud. The trigger is still the one named in the
  Roadmap: IVRs rejecting the synthesized tones. The Xfinity menu passed on 2026-10-18, so it hasn't fired. It
  would be a fresh implementation; the earlier adapter never worked and was deleted (`docs/ARCHITECTURE.md`).
- **Turn detector, adaptive interruption, IVR auto-navigation.** The turn detector needs OpenAI's own turn
  detection turned off and has a separate model license. Adaptive interruption is Cloud-only. IVR
  auto-navigation is Python-only, and Banjo is TypeScript.

---

# 2026-11-01 update: Vaani

A look at [Vaani](https://vaanivoice.ai/) (docs at [docs.vaani.dev](https://docs.vaani.dev/), also served from
docs.vaanivoice.ai). Sources were all 51 pages in its [docs index](https://docs.vaanivoice.ai/llms.txt), its
marketing site and its package registry entries. No account was created and no test call was placed, so "not
documented" below doesn't prove a feature is absent. Vaani's accuracy, latency, compliance and customer claims
are its own and weren't verified.

## Verdict: do nothing with Vaani

Vaani is a closed, hosted platform for businesses running voice agents at volume. Banjo places calls for one
person, on infrastructure that person runs. Don't integrate it, and don't build its feature set. The one thing
to take is a maximum call duration ([#241](https://github.com/shatch/banjo/issues/241)).

## What it is

- **Company:** based in Bangalore and San Francisco. The site is labeled "Stealth Mode — Private Beta", while
  also claiming SOC2, HIPAA and 50+ teams.
- **Product:** a dashboard for building agents, with a swappable speech-to-text, LLM and text-to-speech pipeline
  (Deepgram, ElevenLabs, Sarvam, Cartesia and others) and a focus on Indian languages. It also has campaigns, a
  knowledge base, a web widget, WhatsApp and Cal.com, plus a REST API, a Python SDK and an MCP server.
- **Openness:** `vaani-sdk` and `vaani-research-mcp` are MIT, but the platform is closed. Self-hosting is offered
  to companies with "at-least half a million calls a month".
- **Price:** no public price list. The docs show `₹5.42/min (est.)` as an example, derived from speech-to-text,
  LLM and text-to-speech choices, so telephony appears to be extra. That's roughly $0.06/min at about ₹88 to the
  dollar, against Banjo's $0.11–$0.17 all-in. At personal call volume, the difference is too small to matter.
- **Docs quality:** the docs contradict themselves (`call.analyzed` vs `call_postprocessing`, `phone_number` vs
  `contact_number`), and the linked `vaani-mcp` GitHub repo returned a 404 on 2026-11-01.

## Gaps

| Vaani has | Banjo today | Decision |
| --- | --- | --- |
| Maximum call duration | Only vendor limits (OpenAI's 60-minute session, Twilio's 4-hour default), plus hold and silence limits | **Build:** [#241](https://github.com/shatch/banjo/issues/241) |
| Answering machine detection | Open as [#187](https://github.com/shatch/banjo/issues/187); [#238](https://github.com/shatch/banjo/issues/238) is a live miss | **Already tracked:** LiveKit's design (above) is the better model |
| Pronunciation dictionary | Per-contact field in open PR [#239](https://github.com/shatch/banjo/pull/239) | **Finish #239** |
| Speech-to-text keyword boosting | Not checked | **Wait:** only if transcripts keep mishearing names |
| Memory across calls | Inbound sees recent calls; outbound appears limited to notes, with the calling agent holding history | **Wait:** only if a real call suffers from it |
| Indian languages, code-switching | English in practice | **Wait:** only if real users ask |
| Separate speech/LLM pipeline with provider failover | OpenAI speech-to-speech only | **Skip:** an outage costs one call, which can be retried |
| Automated call scoring and sentiment | Evals plus a disclosure check | **Skip:** at this volume, the transcripts can just be read |
| Campaigns | Per-number call cap | **Never:** works against the cap |
| Dashboard, builder, web widget, knowledge base, receptionist | Non-goals in `CONTRIBUTING.md` | **Never** |
| Background office sounds, voice cloning | None | **Never:** both make an AI sound more human, which cuts against the disclosure rules |

Banjo is ahead on what errands depend on. None of this appears in Vaani's docs: pressing digits in phone menus,
waiting on hold, asking the owner mid-call, approval before dialing, per-number call caps, call screening,
checking AI disclosure, playing the recording notice before recording starts, a task state machine, or Postgres
as the source of truth for bookings.

## Why not integrate

- **As a `VoiceAIProvider`:** doesn't fit. Vaani's API dispatches a whole call and owns the carrier, with no
  audio stream for `CallSession` to use.
- **Through Bring Your Own LLM, with Banjo as the brain:** the only plausible route, but the
  [documented protocol](https://docs.vaanivoice.ai/guides/byol.md) is just text turns plus `end_call`, with no
  digit presses, hold, transfer or verbatim speech. Most of `CallSession` would need rewriting, Banjo could no
  longer guarantee disclosure and recording order, and call audio would pass through a closed third party.
- **Running its MCP server alongside Banjo:** needs no Banjo code, but its `trigger_call` bypasses Banjo's
  approval flow and call caps, so don't give it to an agent that has the Banjo agent key.

## What would change this

- **Real demand for Indian-language calls:** test `gpt-realtime` in those languages first, then revisit Vaani or
  its voice vendor, Sarvam.
- **A streaming audio API or an affordable self-hosted tier from Vaani:** the provider route would then be worth
  another look.

---

# 2026-11-03 update: Phonic-1

A look at [Phonic-1](https://phonic.ai/blog/phonic-1), a speech-to-speech model announced on 2026-10-29. Sources
were its launch post, [pricing page](https://phonic.ai/pricing), [docs](https://docs.phonic.ai/),
[WebSocket spec](https://docs.phonic.ai/asyncapi.yaml) and the
[Artificial Analysis index](https://artificialanalysis.ai/speech-to-speech), read on 2026-11-02. No account was
created and no test call was placed, so "not documented" below doesn't prove a feature is absent. Phonic's latency,
compliance and customer claims are its own and weren't verified.

## Verdict: test it, don't switch yet

Unlike Vaani, Phonic-1 is a real candidate for a `VoiceAIProvider`: its API streams audio and leaves the call to
Banjo. It scores far ahead of `gpt-realtime` and modestly ahead of `gpt-live-1`. But no benchmark found tests what
Banjo does on calls: voicemail, phone menus, holds and outbound etiquette. Run a throwaway test before building an
adapter, and before making `gpt-live-1` the default ([#230](https://github.com/shatch/banjo/pull/230)–[#232](https://github.com/shatch/banjo/pull/232)).

## What it is

- **Company:** $31.5M raised in total, including a $27.5M Series A announced with the model.
- **Product:** a closed model reached through a WebSocket API, TypeScript and Python SDKs, a CLI or a no-code agent
  builder. Phonic claims 50+ languages, and tool calls that can run while the caller is still speaking.
- **Price:** $0.07/min on Starter, $0.065/min on Pro with a $200 monthly minimum, with no per-token charges. Twilio
  appears to be extra. At personal call volume, the difference from Banjo's current cost is too small to decide this.
- **Self-hosting:** on-prem and VPC deployment are Enterprise-only.

## Benchmarks

From Artificial Analysis: simulated customer-service calls and audio question sets. The page doesn't say whether
8kHz phone audio was tested.

| Model | Banjo status | Index | τ-Voice | Task success | Time to first audio | Preference (Elo) | Cost/hour of input audio |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Phonic 1 (High) | Not integrated | 87.1 | 79.9% | 92.3% | 0.61s | 1012 | $4.20 |
| Grok Voice 3.0 | Not integrated | 86.9 | 71.6% | 94.8% | 0.81s | 1059 | $4.80 |
| GPT-Live-1 (Astra, medium) | `openai-live`, off by default | 83.2 | 74.5% | 87.4% | 1.34s | 1027 | $5.83 |
| Gemini 3.8 Live (Extended Thinking, High) | Newer than the unverified `gemini` adapter | 82.6 | 68.6% | 89.1% | 1.35s | 966 | $3.50 |
| GPT-Realtime-2.1 High | Not tried | 75.2 | 45.7% | 91.5% | 1.21s | 931 | $10.75 |
| GPT Realtime (Aug '25) | Assumed match for the `openai` default, `gpt-realtime` | 69.1 | 30.4% | 89.4% | 0.98s | 967 | $11.08 |

- **The lead is thin:** Phonic is 0.2 ahead of Grok on the index, on the strength of its speed and agentic scores.
- **Preference results conflict:** Phonic's post reports listeners preferring it to GPT-Live 61.5% to 32.0% in blind
  tests by Podonos. Artificial Analysis has it slightly behind GPT-Live, and behind at least six listed models.
- **Weak evidence:** the post's 1.1s vs 15.7s comparison with GPT-Live is a single demo. Artificial Analysis's
  GPT-Live scores for τ-Voice used one trial, against three where available.

## Fit with Banjo

Read from the docs, not tested.

| Banjo needs | Phonic offers | Fit |
| --- | --- | --- |
| Twilio audio without conversion | `mulaw_8000` both ways, and a documented Twilio Media Stream example | Good |
| Exact voicemail wording (`sayVerbatim`) | `say`, 1–1000 characters, optionally uninterruptible | Promising; exact delivery untested. GPT-Live has no equivalent |
| Mid-call notes and nudges | `add_system_message`, `generate_reply` | Good |
| Barge-in and transcripts | `interrupted_response`, `input_text`, text on audio chunks | Good |
| Banjo's own tools | `tool_call` and `tool_call_output`; 5s default timeout, up to 180s | Good, with the timeout raised |
| Digit presses | `keypad_input`; Banjo's tone-based `press_digits` should still work | Probably fine |
| Reply control per tool result (`respond`, [#133](https://github.com/shatch/banjo/issues/133), [#251](https://github.com/shatch/banjo/issues/251)) | `forbid_speech_after_tool_call`, set per tool | **Gap:** this logic would need rework |
| Silent tool calls | Speech before a tool call is on by default, and can be turned off | **Risk:** the default can recreate #251 |
| Tools that must finish, like `confirm_appointment` | Caller speech cancels sync tools by default; `uninterruptible` overrides it | **Risk:** needs setting per tool |
| Answers saved only after confirmation | Tools can run while the caller is still talking | **Risk:** could add false answers |
| `report_answers_and_end_call`'s list of answers | Pre-defined tools show flat parameters; inline tools use an OpenAI-style schema | **Unconfirmed:** nested parameters aren't documented |
| Hold and voicemail detection | Neither documented; `choose_not_to_respond` is the nearest control | Banjo keeps its own logic; needs testing |
| No third-party retention by default | Audio and transcripts kept indefinitely unless set otherwise; zero retention is a per-agent setting | **Must be on.** Some models aren't available with it; confirm `phonic-1` is |
| Scenario evals | No text mode documented, the same blocker as GPT-Live | Phone-line fixtures only, unless `generate_reply`'s `user_message` can drive a text sim |

## What to do

1. **Hold the GPT-Live default:** that plan assumed GPT-Live was the obvious next model.
2. **Run a throwaway test, not an adapter:** the voicemail, hold and phone-menu fixtures, plus one ask call and one
   booking call to see how tools behave mid-speech.
3. **Judge it on Banjo's own failures:** false answers, silences, voicemail delivery and booking correctness, not
   the index score.
4. **Put GPT-Realtime-2.1 through the same test:** it may be the cheapest improvement, since it needs no new vendor.
   Whether it works with the current `openai` adapter unchanged wasn't checked.

Phonic offers $250 in free credits for sign-ups by November 30.

## What would change this

- **The test passes on real calls:** build the adapter, then choose a default from those results.
- **Tools fired mid-speech cause false answers or early bookings, and the settings can't stop it:** drop it, whatever
  the benchmarks say.
- **Nested tool parameters aren't supported:** `report_answers_and_end_call` could be flattened, since `record_answer`
  already saves one answer at a time, but that changes a tool all ask calls rely on.
