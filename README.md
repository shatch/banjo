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
check or reschedule with you, recognizing callers already in your Google Contacts.

## Hear it

https://github.com/user-attachments/assets/c599a672-8d4e-46f9-8868-64e0840c589b

**Listen to a real call (2:11)**: Banjo books a dog grooming appointment. The
call and the calendar are real; the groomer is role-played. Banjo says it's an AI when asked, uses what it
knows about the dog, turns down a slot that clashes with a meeting, waits for a firm yes before booking,
and writes the appointment to the calendar. This is a first pass. It hangs up without reading the booking
back, which is tracked in [#47](https://github.com/shatch/banjo/issues/47).

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

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, [`docs/ROADMAP.md`](docs/ROADMAP.md)
for what's coming next, [`docs/RUNBOOKS.md`](docs/RUNBOOKS.md) for operational procedures, and
[`docs/COMPETITIVE_LANDSCAPE.md`](docs/COMPETITIVE_LANDSCAPE.md) for how it compares to other
open-source projects in this space.

[![Banjo runtime architecture](docs/architecture-diagram.png)](docs/ARCHITECTURE.md)

## Known limitations

Banjo places real calls and books real appointments, and has done so reliably. It is also a young
project with one maintainer. Things worth knowing before you build on it:

- **One voice provider is actually proven.** OpenAI Realtime is the only adapter carrying live
  traffic. `openai-live` (GPT-Live) has been tested on real calls but isn't the default. **Gemini
  Live and ElevenLabs are scaffolded and unverified** — Gemini additionally emits no caller-side
  transcripts at all.
- **Transcripts and recordings are saved only if you turn them on.** With `PERSIST_TRANSCRIPTS=true`,
  every line of every call goes to Postgres and can be read back with the `get_call_transcript` MCP tool.
  With `RECORD_CALLS=true`, outbound calls are recorded (two-track) in your Twilio account. Banjo's opening
  line gains *"This call is recorded."*, and recording starts only after Banjo has said it, so the other
  party's greeting and Banjo's opener aren't on the recording. Both are off by default and deleted after
  30 days (`TRANSCRIPT_RETENTION_DAYS`, `RECORDING_RETENTION_DAYS`). Inbound calls are never recorded.
  ([#6](https://github.com/shatch/banjo/issues/6), [#8](https://github.com/shatch/banjo/issues/8))
- **No call transfer.** When a call needs a human, Banjo hangs up and notifies you rather than
  handing the call over. ([#7](https://github.com/shatch/banjo/issues/7))
- **AI disclosure is a prompt rule, checked after the call, not enforced.** Banjo is told to open every
  call with `DISCLOSURE_LINE` (default: *"Hi, I'm an AI assistant calling on behalf of {name}."*, and it
  must say "AI"). Afterwards, its first line is checked. A miss is recorded on the call attempt and
  noted in your notification, but it isn't prevented.
  **If you're in a jurisdiction with AI-disclosure or two-party-consent rules (TCPA/FCC, California
  AB 2905), check your own calls.** ([#8](https://github.com/shatch/banjo/issues/8))
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
3. **A Google OAuth client + refresh token**, if you want live calendar-aware booking and/or Google Contacts
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
   | Reverse-proxy through a real deployment (e.g. an ALB, as the `.env.example` default hints) | Once Banjo is running as a persistent service rather than on your laptop — see `docs/RUNBOOKS.md`. |

Then, to run the whole thing in Docker:

```bash
cp .env.example .env   # fill in ASSISTANT_PRINCIPAL_NAME + everything from steps 1-3 above
docker compose up      # Postgres + Banjo; migrations are applied on boot
```

Or to develop against it locally, with hot reload:

```bash
cp .env.example .env
npm install
docker compose up -d postgres   # just the database
npm run dev                     # applies migrations, then starts on $PORT
```

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

## Companion Claude Code skill

Banjo only handles the phone-calling half of "get this errand done." The other half — deciding
whether to book online or by phone, and driving the online booking flow via browser automation —
is a Claude Code skill that ships alongside this repo at [`skills/schedule-appointment/`](skills/schedule-appointment/SKILL.md).
Install it by symlinking (not copying) into your Claude Code skills directory, so future edits to
the skill stay live without a separate sync step:

```bash
ln -s "$(pwd)/skills/schedule-appointment" ~/.claude/skills/schedule-appointment
```

The skill reads `$ASSISTANT_PRINCIPAL_NAME` for how to address you, matching the same env var
Banjo's backend uses — set it once in your shell/`.env` and both halves stay consistent.

## Stack

Node 22, TypeScript (strict, ESM), Hono (HTTP) + raw `ws` (media-stream audio), Drizzle ORM + Postgres, Zod,
Vitest, Docker.

## Scripts

| Command | What it does |
| --- | --- |
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
  calendar/      Google Calendar integration (phone-path only — see docs/ARCHITECTURE.md)
  googleContacts/ Google People API sync/lookup/reconciliation cache — feeds contacts/ and inbound/
  inbound/       inbound call handling: booking flow + caller-ID resolution for greeting personalization
  mcp/           remote MCP server for tool-calling clients (e.g. Claude Code)
  session/       per-call state machine wiring telephony <-> voice AI <-> tools
  notifications/ outcome notifications (SMS by default, or Pushover)
skills/
  schedule-appointment/  companion Claude Code skill — decides online vs. phone, drives online
                          booking via browser automation, calls into src/mcp/ for the phone path
```

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) opens with what Banjo deliberately isn't — worth two minutes
before you write anything. Security issues go through [`SECURITY.md`](SECURITY.md), privately, not
the issue tracker.

## License

MIT — see [`LICENSE`](LICENSE).
