<img src="assets/logo.png" alt="Banjo logo" width="160" align="right">

# Banjo

**Banjo makes the phone calls you've been putting off.** Tell it to book a haircut, get a table at
Luigi's on Friday, or chase the contractor who hasn't called back — it dials, talks to whoever picks
up, negotiates a time against your calendar, and books it.

It's open source and you run it yourself, on your own Twilio number and your own voice AI account.
Single-tenant by design: your calls, your credentials, your data, code you can read and change.

Banjo is the phone half of a pair. The other half is a Claude Code skill
([`skills/schedule-appointment/`](skills/schedule-appointment/SKILL.md)) that decides whether an errand can
be done online — and only picks up the phone when it can't.

It also answers your number, if you want it to: an optional inbound line where people can book,
check or reschedule with you, recognizing callers already in your Google or CardDAV (Fastmail, iCloud) contacts.

## Hear it

https://github.com/user-attachments/assets/c599a672-8d4e-46f9-8868-64e0840c589b

**Listen to a real call (2:11)**: Banjo books a dog grooming appointment. The
call and the calendar are real; the groomer is role-played. Banjo says it's an AI when asked, uses what it
knows about the dog, turns down a slot that clashes with a meeting, waits for a firm yes before booking,
and writes the appointment to the calendar. This was an early call. Since then, Banjo reads the booking back
before hanging up ([#47](https://github.com/shatch/banjo/issues/47)) and opens every call by saying it's an
AI rather than waiting to be asked ([#8](https://github.com/shatch/banjo/issues/8)).

<details>
<summary>Transcript (auto-transcribed, lightly tidied)</summary>

> **Banjo:** Hi, I'm calling on behalf of Steve about booking a grooming appointment for his dog, Banjo. Is this Claudia's Fabulous Dog Grooming?
>
> **Claudia:** Yes, sorry about that. Claudia's Fabulous Dog Grooming, this call may be recorded. This is Claudia, how can I help?
>
> **Banjo:** Hi Claudia, thanks for taking this. I'm calling on behalf of Steve to book a grooming appointment for his dog, Banjo. A full groom is preferred. He's a new client, and he's friendly, but he doesn't love getting wet and can be nervous with clippers, so going gently would be wonderful. What availability do you have?
>
> **Claudia:** Sorry, am I talking to a real person?
>
> **Banjo:** I'm an AI assistant calling on behalf of Steve. I can help set this up if you're okay proceeding. Could you share what times you have available for a full groom for Banjo?
>
> **Claudia:** Wait, what's the dog's name?
>
> **Banjo:** His name is Banjo. He's Steve's dog.
>
> **Claudia:** What breed, and roughly how big?
>
> **Banjo:** Banjo is a small terrier mix, likely a Cairn Terrier. He's small, friendly, and this would be his first time there.
>
> **Claudia:** A full groom, or just a bath?
>
> **Banjo:** A full groom is preferred, please. If you need to adjust based on what's best for him, that's fine. We'd just like him cleaned up and trimmed.
>
> **Claudia:** I can fit him in Thursday the 24th at 3:30.
>
> **Banjo:** One moment. … Thanks, that time won't work on Steve's side. Could we try another option? If it helps, a start time earlier in the day would be better.
>
> **Claudia:** Friday, I might be able to squeeze him in at 10 in the morning. Let me look.
>
> **Banjo:** Sure, just a second. … Friday at 10 AM should work for Steve. Would you like to book that for Banjo's full groom?
>
> **Claudia:** Yeah, that could probably work.
>
> **Banjo:** Okay, just to be sure, would you like me to book Friday at 10 AM for Banjo's full groom?
>
> **Claudia:** Okay, yes. Friday the 25th at 10 a.m., full groom, 90 minutes. Let's book it.
>
> **Banjo:** One moment. … Great, thanks for confirming. Let me wrap this up.

</details>

## What it does

**On the phone**
- **Books appointments.** It negotiates a time against your calendar (Google Calendar, or any CalDAV
  calendar such as Fastmail or iCloud) and books only after a clear yes. Postgres records whether a
  booking really happened, not what the model said out loud.
- **Has conversations.** `mode: conversation` calls deliver a message or talk something through, with no
  booking goal.
- **Calls later.** `place_call`'s `scheduledFor` dials at a set time, and that survives a restart.
- **Handles voicemail and phone menus.** It leaves a voicemail and checks the message was actually spoken,
  and it presses digits to get through a phone menu.
- **Hands a call to you.** Optional cold transfer when the other party asks for a person, with your leg
  screened so only pressing 1 connects (`TRANSFER_ENABLED`).
- **Answers your number.** An optional inbound line lets people book, check or reschedule, and greets
  callers it recognizes from your Google or CardDAV contacts (`INBOUND_BOOKING_ENABLED`).

**Safeguards**
- **Says it's an AI.** Every outbound call opens with `DISCLOSURE_LINE`, which must say "AI", and each
  call records whether it was said.
- **Records only with notice.** Recording is optional (`RECORD_CALLS`), and starts only after Banjo has
  said the recording notice.
- **Won't pester anyone.** At most 3 calls to any number in a rolling 24 hours, with no override.
- **Keeps what you choose.** Transcripts are saved only if you turn them on (`PERSIST_TRANSCRIPTS`),
  and both transcripts and recordings are deleted after 30 days by default. Logs mask phone numbers
  and call content.

**Working with it**
- **11 MCP tools for Claude Code:** place, check, cancel and stop calls, read transcripts, and manage
  contacts.
- **Tells you how it went:** an outcome summary after every call, by SMS or [Pushover](https://pushover.net).
- **Tells your agent too:** set `TASK_WEBHOOK_URL` and every finished call is POSTed as a signed JSON
  event, so an agent such as OpenClaw or Hermes Agent hears back without polling.
- **Knows your preferences:** an owner profile of standing notes is added to every call (see
  [below](#making-it-yours-the-owner-profile)).
- **Easy to run:** `npm run setup` writes a checked `.env`, and `docker compose up` runs the published
  amd64/arm64 image. To keep it running when your laptop sleeps, see
  [Running Banjo on an always-on Linux host](docs/RUNBOOKS.md#running-banjo-on-an-always-on-linux-host).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, [`docs/ROADMAP.md`](docs/ROADMAP.md)
for what's coming next, [`docs/AGENT_SETUP.md`](docs/AGENT_SETUP.md) for connecting Claude Code, Hermes Agent or
OpenClaw, [`docs/RUNBOOKS.md`](docs/RUNBOOKS.md) for operational procedures, and
[`docs/COMPETITIVE_LANDSCAPE.md`](docs/COMPETITIVE_LANDSCAPE.md) for how it compares to other
open-source projects in this space.

[![Banjo runtime architecture](docs/architecture-diagram.png)](docs/ARCHITECTURE.md)

## Known limitations

Banjo places real calls and books real appointments, and has done so reliably. It is also a young,
small project. Things worth knowing before you build on it:

- **One voice provider is actually proven.** OpenAI Realtime is the only adapter carrying live
  traffic. `openai-live` (GPT-Live) has been tested on real calls but isn't the default. **Gemini
  Live and ElevenLabs are scaffolded and unverified** — Gemini additionally emits no caller-side
  transcripts at all.
- **AI disclosure is a prompt rule, checked after the call, not enforced.** Banjo is told to open every
  call with `DISCLOSURE_LINE` (default: *"Hi, I'm an AI assistant calling on behalf of {name}."*), and
  its first line is checked afterwards. A miss is recorded on the call attempt and noted in your
  notification, but it isn't prevented.
  **If you're in a jurisdiction with AI-disclosure or two-party-consent rules (TCPA/FCC, California
  AB 2905), check your own calls.** ([#8](https://github.com/shatch/banjo/issues/8))
- **Recording and transcripts cover outbound calls only.** Recordings live in your Twilio account
  (two-track), transcripts in Postgres. Both are off by default. Inbound calls are never recorded.
  ([#6](https://github.com/shatch/banjo/issues/6))
- **Call transfer is cold, to one fixed number.** Banjo transfers only after the other party says yes,
  and the model never chooses who to connect. You get no summary of the call before you're connected,
  and Banjo can't stay on the line. If you don't answer, the caller hears `TRANSFER_FALLBACK_MESSAGE`
  and the call ends. On the inbound line, only callers already in your contacts can be put through;
  anyone else who asks for you is flagged for you to call back, so a robocall can't ring your phone.
  ([#7](https://github.com/shatch/banjo/issues/7), [#66](https://github.com/shatch/banjo/issues/66))
- **SMS to US numbers needs carrier registration.** Without A2P 10DLC registration, outcome texts are
  blocked by the carrier. Pushover needs no registration. See `docs/RUNBOOKS.md`, "SMS notifications
  aren't arriving".
- **Logs are redacted, not access-controlled.** Phone numbers are logged with only the last 4 digits,
  and voicemail text and raw tool arguments as a length. Error messages from vendors can still quote a
  number, and `LOG_TRANSCRIPTS=true` deliberately logs full call text. Treat logs as sensitive.
- **One call at a time.** The inbound line declines anything arriving while another call is live.
- **It needs a publicly reachable hostname**, because Twilio dials back into it over HTTPS and a
  WebSocket. See the Quickstart, and
  [`docs/spikes/2026-09-21-outbound-registration-worker.md`](docs/spikes/2026-09-21-outbound-registration-worker.md)
  for why this is hard to remove.
- **Single-tenant, permanently.** One instance serves one person. See
  [`CONTRIBUTING.md`](CONTRIBUTING.md) for what else Banjo deliberately isn't.

## What a call costs

You pay vendors directly. Per-unit prices, checked 2026-09-21:

| What | Price | Source |
| --- | --- | --- |
| Twilio outbound voice, US local number | $0.0140 / min | [Twilio voice pricing](https://www.twilio.com/en-us/voice/pricing/us) |
| Twilio inbound voice, US local number | $0.0085 / min | same |
| Twilio US local phone number | $1.15 / month | same |
| OpenAI `gpt-realtime` audio input | $32.00 / 1M tokens | [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) |
| OpenAI `gpt-realtime` audio output | $64.00 / 1M tokens | same |
| OpenAI `gpt-4o-mini-transcribe` (caller-side transcription) | $1.25 in / $5.00 out per 1M tokens | same |
| Twilio SMS notification, if enabled | per-message, US | [Twilio SMS pricing](https://www.twilio.com/en-us/sms/pricing/us) |

Translating realtime audio tokens into a per-minute figure is unreliable — input grows with
conversation length, silence still bills, and how much the model talks varies per call. **Measured
across real calls, all-in vendor spend has run roughly $0.11–$0.17 per minute**, dominated by voice
AI rather than telephony. A 3-minute booking call is somewhere around $0.35–$0.50.

A call transfer (`TRANSFER_ENABLED`) adds a second billed Twilio leg: an outbound call to
`TRANSFER_TO_PHONE_NUMBER`, at the outbound rate above, for as long as you're on it — on top of
the original call's leg, which stays up while you talk. The voice AI stops billing once the call is
handed over.

Two honest notes. Pick `gpt-realtime-mini` and audio costs drop by about two thirds, at some
quality cost. And don't run Banjo to save money against a SaaS subscription — at these rates you'd
need a lot of calls, and the saving won't pay for an hour of your attention. Run it because it's
yours.

## Quickstart

Banjo needs four things before it can place a real call — get these first:

1. **A Twilio account and phone number.** Sign up at [twilio.com](https://www.twilio.com), buy a phone
   number capable of voice calls, and note your Account SID, Auth Token, and the number itself. For outcome
   **texts** to a US number, the sending number must also be registered for US A2P 10DLC. Without it, every
   text is silently blocked by the carrier (Twilio error 30034). See `docs/RUNBOOKS.md`, "SMS notifications
   aren't arriving". Or skip SMS entirely and get outcomes as [Pushover](https://pushover.net) push
   notifications (`NOTIFICATION_CHANNEL=pushover`), which need no carrier registration.
2. **A voice AI provider.** OpenAI Realtime is the most battle-tested option here and the recommended
   default — Gemini Live and ElevenLabs Conversational AI are supported but flagged
   `NEEDS VERIFICATION` in a few places (see `docs/ARCHITECTURE.md`'s Open Risks section) since they haven't
   carried live call traffic the way the OpenAI path has. Get an API key from whichever you pick.
3. **Calendar and contacts access**, if you want live calendar-aware booking and caller ID. Either
   CalDAV/CardDAV (Fastmail, iCloud, Nextcloud) with an app password — set `CALENDAR_PROVIDER=caldav`
   and/or `CONTACTS_PROVIDER=carddav`, see `docs/RUNBOOKS.md`'s "Connecting Fastmail calendar and
   contacts" — or Google, below. Google is the default. CalDAV has made real bookings on Fastmail
   ([#70](https://github.com/shatch/banjo/pull/70)).

   **A Google OAuth client + refresh token**, if you want Google Calendar and/or Google Contacts
   integration (caller-ID personalization, `find_contact` fallback) — the two share one client and one
   refresh token minted with both scopes at once. See `docs/RUNBOOKS.md`'s "Minting `GOOGLE_OAUTH_REFRESH_TOKEN`"
   runbook for the exact steps, and `docs/ARCHITECTURE.md`'s Calendar/Google Contacts sections for how each is
   wired. Skipping this step is fine — Calendar and Google Contacts fail closed (log and no-op) rather than
   crash, so the rest of Banjo works without them.
4. **A publicly reachable hostname for your local server.** Twilio calls back into Banjo over plain HTTPS
   (webhooks) and a WebSocket (the audio Media Stream), so it needs a real internet-facing hostname even in
   local dev — `localhost` won't work. The quickest way:

   ```bash
   ngrok http 3000   # or whatever PORT you set
   ```

   Take the hostname ngrok prints (e.g. `abcd1234.ngrok-free.app`, no `https://` prefix) and set it as
   `PUBLIC_HOSTNAME` in `.env`. Other options, roughly in order of effort:

   | Option | When to use it |
   | --- | --- |
   | [ngrok](https://ngrok.com) | Local dev, quickest to set up. Free tier URLs rotate on every restart — update `PUBLIC_HOSTNAME` each time, or use a paid static domain. |
   | [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`) | Local dev with a stable hostname you control, free, tied to a domain you own in Cloudflare. |
   | Reverse-proxy through a real deployment (e.g. an ALB, as the `.env.example` default hints) | Once Banjo is running as a persistent service rather than on your laptop — see `docs/RUNBOOKS.md`, "Running Banjo on an always-on Linux host". |

Then, to run the whole thing in Docker:

```bash
npm install
npm run setup          # asks for everything from steps 1-3 above and writes .env
docker compose up      # Postgres + Banjo; migrations are applied on boot
```

`npm run setup` checks each answer as you type it (E.164 phone numbers, a bare `PUBLIC_HOSTNAME`), can
check your Twilio and Pushover credentials with those services, generates `MCP_API_KEY`, and runs the same validation Banjo runs
at startup before writing anything. Run it again to change a setting: it offers the current values as
defaults and backs up the old `.env` first. Prefer editing by hand? `cp .env.example .env` and fill it in.

`docker compose up` pulls the published image, `ghcr.io/shatch/banjo`, built for amd64 and arm64 on each release. Set `BANJO_VERSION` in `.env` to pin a release, for example `0.1.0`. The default is `latest`. To run your own checkout instead, use `docker compose up --build`.

Or to develop against it locally, with hot reload:

```bash
npm install
npm run setup                   # or: cp .env.example .env, and fill it in
docker compose up -d postgres   # just the database
npm run dev                     # applies migrations, then starts on $PORT
```

Then connect your agent to Banjo's MCP server at `https://<PUBLIC_HOSTNAME>/mcp` (Streamable HTTP),
with `MCP_API_KEY` as a bearer token. For Claude Code:

```bash
claude mcp add --transport http banjo https://YOUR-HOSTNAME/mcp \
  --header "Authorization: Bearer $MCP_API_KEY"
```

Older clients that only speak the deprecated HTTP+SSE transport can use `/mcp/sse` instead.

### Test database

`npm test`'s DB-backed suites run against a separate `banjo_test` database on the same Postgres
instance, not the `banjo` dev database above. Compose creates it for you on first run
(`scripts/init-test-db.sql`); it just needs migrating once:

```bash
DATABASE_URL=postgresql://banjo:banjo@localhost:5432/banjo_test npm run db:migrate
```

Boot-time migrations only ever touch the database in `DATABASE_URL`, so the test database is always
migrated explicitly like this — never automatically.

### Schema changes

Migration files live in `drizzle/` and are committed, and Banjo applies any unapplied ones at
startup (`RUN_MIGRATIONS_ON_BOOT`, on by default) — so pulling a schema change and restarting is
enough. Only the `banjo_test` database needs the explicit `db:migrate` above.

If you *author* a schema change, run `npm run db:generate` and commit the generated SQL alongside
your `src/**/schema.ts` edit.

## Making it yours: the owner profile

The call prompts live in code (`src/voice/systemPrompt.ts`, `src/tasks/promptBuilder.ts`) on purpose: most
of what they say was learned from real calls — disclosing that it's an AI, booking only after a clear yes,
getting the timezone right — and they're pinned by tests. Upgrading Banjo upgrades them.

What's yours to change goes in an **owner profile**: a short Markdown file of standing notes that's added to
every outbound call, below those rules.

```bash
cp banjo-profile.example.md banjo-profile.md    # git-ignored — edit it
echo 'PROMPT_PROFILE_FILE=./banjo-profile.md' >> .env
```

Put in what you'd tell a human assistant before they pick up the phone: facts about you and whoever you book
for ("Pepper is a beagle who hates nail trims"), your preferences, and how calls should sound. Banjo uses the
facts to answer questions, and only shares one when it matters to the call.

- **The rules still win.** The prompt tells the model that nothing in the profile overrides disclosure,
  explicit agreement or the timezone. A profile can make Banjo friendlier, but it can't make Banjo claim
  to be human.
- **Per-call notes win over the profile.** `place_call`'s `constraints.notes` are more specific.
- **Checked at boot, re-read per call.** A bad path or a file over 4,000 characters stops startup. After
  that, edits apply on the next call, with no restart needed.
- **In Docker**, mount the file: uncomment the `volumes:` lines under `app` in `docker-compose.yml`, or put
  them in a git-ignored `docker-compose.override.yml`.
- **Outbound only, for now.** The inbound booking line answers strangers, so it doesn't get your personal
  notes.

## Companion skill

Banjo only handles the phone-calling half of "get this errand done." The other half, deciding
whether to book online or by phone and driving an online booking with browser automation, is an
[Agent Skill](https://agentskills.io) that ships with this repo at
[`skills/schedule-appointment/`](skills/schedule-appointment/SKILL.md). It works in any agent that
supports Agent Skills and remote MCP servers. Install it, then connect the agent to Banjo's MCP
server (see the Quickstart).

The skill file is licensed MIT-0 (MIT without the attribution requirement), as ClawHub requires; the
rest of the repo is MIT.

**Any agent, with the [skills CLI](https://skills.sh):**

```bash
npx skills add shatch/banjo --skill schedule-appointment
```

**Claude Code.** Symlink rather than copy, so later edits to the skill take effect without a
separate sync step:

```bash
ln -s "$(pwd)/skills/schedule-appointment" ~/.claude/skills/schedule-appointment
```

**OpenClaw** (not yet tested with Banjo), from [ClawHub](https://clawhub.ai) or a local checkout:

```bash
clawhub install @shatch/banjo-schedule-appointment
openclaw skills install ./skills/schedule-appointment --global
```

**Hermes Agent** (add `--yes` when there's no terminal to confirm, e.g. `docker compose exec -T`):

```bash
hermes skills install shatch/banjo/skills/schedule-appointment
```

The skill reads `$ASSISTANT_PRINCIPAL_NAME` for how to address you, matching the same env var
Banjo's backend uses. Set it once in your shell/`.env` and both halves stay consistent.

## Stack

Node 22, TypeScript (strict, ESM), Hono (HTTP) + raw `ws` (media-stream audio), Drizzle ORM + Postgres, Zod,
Vitest, Docker.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | Interactive setup: asks for the required settings, checks them, and writes `.env` |
| `npm run dev` | Run the server with hot reload (`tsx watch`) |
| `npm run build` | Type-check and compile to `dist/` |
| `npm test` | Run the Vitest suite |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:generate` / `db:migrate` / `db:studio` | Drizzle migrations |

`db:generate`/`db:migrate` auto-run `npm run build` first (see their `pre*` hooks in `package.json`) —
`drizzle-kit` 0.28.x [can't resolve](https://github.com/drizzle-team/drizzle-orm/issues/2705) the `.js`-suffixed
relative imports this source uses (required for correct Node ESM runtime resolution), so `drizzle.config.ts`
points at compiled `dist/db/schema.js` instead of the TS source. If you ever see `relation "..." does not
exist`, it almost always means migrations were never generated/applied.

## Layout

```
src/
  voice/         vendor-agnostic Voice AI provider abstraction (OpenAI/Gemini/ElevenLabs)
  telephony/     outbound call origination + media streams (Twilio)
  tasks/         task/call-attempt data model, phone-path orchestration
  contacts/      contact directory
  calendar/      Google Calendar or CalDAV integration (phone-path only — see docs/ARCHITECTURE.md)
  googleContacts/ contacts cache (sync/lookup/reconciliation) — feeds contacts/ and inbound/
  carddavContacts/ CardDAV address-book sync into that cache (Fastmail, iCloud, Nextcloud)
  lib/dav/       shared WebDAV plumbing for CalDAV and CardDAV
  transcripts/   opt-in call transcript storage and retention
  recordings/    call recording retention
  inbound/       inbound call handling: booking flow + caller-ID resolution for greeting personalization
  mcp/           remote MCP server for tool-calling clients (e.g. Claude Code)
  session/       per-call state machine wiring telephony <-> voice AI <-> tools
  notifications/ outcome notifications (SMS by default, or Pushover)
skills/
  schedule-appointment/  companion Agent Skill — decides online vs. phone, drives online
                          booking via browser automation, calls into src/mcp/ for the phone path
```

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) opens with what Banjo deliberately isn't — worth two minutes
before you write anything. Security issues go through [`SECURITY.md`](SECURITY.md), privately, not
the issue tracker.

## License

MIT — see [`LICENSE`](LICENSE).
