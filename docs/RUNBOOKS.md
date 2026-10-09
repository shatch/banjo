# Runbooks

Operational procedures for Banjo. Unlike `docs/ARCHITECTURE.md` (design/rationale), this file is
"do these steps in this order."

---

## Rotating `MCP_API_KEY`

`MCP_API_KEY` is the single static bearer token gating every route under `/mcp` (see
`src/mcp/server.ts`'s `requireAuth`). That endpoint is internet-reachable (via the ngrok tunnel in
local dev, or a real public hostname once deployed), so a leaked key gives whoever has it full
access to Banjo's tools — `place_call` (spends real money and rings real phones), `find_contact`/
`add_contact`/`update_contact` (contact PII), `get_task_status`/`list_recent_tasks`. There's no
automatic expiry or rotation today (see `docs/ARCHITECTURE.md`'s Open Risks) — this is the manual
procedure until that changes.

Rotate on any of:
- Suspected leak (committed to git, pasted somewhere public, shared over an insecure channel).
- Routine hygiene (no fixed interval enforced yet — use judgment; err toward "more often than
  feels necessary" since the cost of rotating is a few minutes).
- Whenever `.env` is copied to a new machine and the old copy isn't guaranteed deleted.

### Steps

1. **Generate a new key.**
   ```bash
   openssl rand -hex 32
   ```
   Any sufficiently random string works — `MCP_API_KEY` has no format requirement beyond a
   32-character minimum (`src/config/index.ts`'s `z.string().min(32, ...)`), it just needs enough
   entropy that it can't be guessed/brute-forced. `openssl rand -hex 32` gives 64 characters.

2. **Update `.env`.**
   Replace the `MCP_API_KEY=` line's value with the new key. Do this on whichever host actually
   runs the process (local dev machine, or the deployed host once Banjo is running somewhere
   persistent) — `.env` is gitignored and per-host by design, there is no central copy to sync.

3. **Restart the Banjo process.**
   `MCP_API_KEY` is read once at process start via `src/config/index.ts`'s top-level
   `envSchema.parse(process.env)` — a running process keeps using the OLD key in memory until
   restarted, even after `.env` is edited. Stop and re-run `npm run dev` (or however the deployed
   process is managed). From this point, the old key stops working — anyone/anything still using
   it gets `401`s.

4. **Re-register every MCP client that connects to Banjo with the new key.**
   For Claude Code sessions using `claude mcp add` (as this session did):
   ```bash
   claude mcp remove banjo
   claude mcp add banjo "http://localhost:3000/mcp" --transport http \
     -H "Authorization: Bearer <NEW_KEY>"
   ```
   (Adjust the URL if connecting over the ngrok `PUBLIC_HOSTNAME` instead of `localhost`, or once
   deployed, the real public hostname.) Any other MCP client configuration pointed at this
   endpoint's `Authorization` header needs the same update — check `~/.claude.json`'s
   `mcpServers` block (or the equivalent client config) for stale `banjo` entries carrying the old
   key if a client stops connecting after rotation.

5. **Confirm the new key works and the old one doesn't.**
   ```bash
   claude mcp list   # should show "banjo: ... - ✔ Connected"
   ```
   If something still needs to prove the *old* key is rejected, a raw request against the SSE
   endpoint with the old `Authorization` header should now 401 — but simply confirming step 4's
   reconnect succeeded is normally sufficient.

6. **If the leak was public (committed to git, posted somewhere indexed), treat the repo/paste as
   permanently compromised** — rotating closes the door going forward, but don't assume deleting
   the commit/post retroactively un-leaks it. `git filter-repo`/force-push history rewriting is a
   separate, more invasive step; only pursue it if the exposure is severe enough to warrant
   rewriting shared history (ask before doing this — it rewrites commit hashes for anyone else
   with a clone).

### What this doesn't cover yet

No secrets-manager integration exists (confirmed — grepping `src/` for `SecretsManager`/`vault`
turns up nothing), so there's no automated rotation, no versioned rollback, and no audit trail of
who has the current key beyond "whoever has read access to `.env` or the deployed environment's
config." If Banjo moves to a real cloud deployment, moving `MCP_API_KEY` into a proper secrets
manager (AWS Secrets Manager, etc.) with automatic rotation is the real fix — this runbook is the
manual stopgap until then.

---

## Connecting Fastmail calendar and contacts

Banjo can read availability from, and write bookings to, one CalDAV calendar, and keep its contacts
cache in step with one CardDAV address book. Both sign in with one app password, never your account
password. These steps are for Fastmail; iCloud and Nextcloud work the same way with their own app
passwords and servers.

### Steps

1. **Make an app password.** In Fastmail, open Settings → Privacy & Security and create a new app
   password there. Give it calendar (CalDAV) and contacts (CardDAV) access — nothing else — if
   Fastmail offers the choice, and name it "Banjo" so it's easy to find and revoke.
2. **Add it to `.env`** (git-ignored; Docker reads it through `env_file`):

   ```bash
   DAV_USERNAME=you@fastmail.com
   DAV_PASSWORD=<the app password>
   ```

3. **Pick a calendar and an address book.** `npm run dav:check` signs in and lists both with their
   URLs. Copy one of each into `CALDAV_CALENDAR_URL` and `CARDDAV_ADDRESSBOOK_URL`. Fastmail's look like
   `https://caldav.fastmail.com/dav/calendars/user/you@fastmail.com/<id>/` and
   `https://carddav.fastmail.com/dav/addressbooks/user/you@fastmail.com/Default/`.
4. **Check what Banjo sees.** Run `npm run dav:check` again. For the address book it counts contacts,
   those with phone numbers (only they can identify a caller), groups, and relations — Banjo treats
   groups named "Family" or "Friends" and relations like spouse or child as close contacts. For the
   calendar it lists the next 7 days of busy times in `CALENDAR_TIMEZONE`; events marked free, declined
   invitations, and all-day events not marked busy are deliberately left out. Nothing is written
   anywhere.

   It also prints the addresses Banjo treats as yours when skipping declined invitations. By default
   they come from the server (Fastmail and iCloud publish every address on the account). If an
   address you're invited at is missing — say, a custom domain — list yours in `DAV_OWNER_EMAIL`,
   comma-separated; that replaces what the server says.
5. **Switch over.** Set `CALENDAR_PROVIDER=caldav` and/or `CONTACTS_PROVIDER=carddav` and restart.
   Boot fails fast if a URL or the `DAV_*` sign-in is missing. On its first CardDAV sync, Banjo makes
   the contacts cache match the address book exactly, which removes any rows from Google Contacts.
   Your curated `contacts` table isn't touched. The URLs must be `https` (plain `http` only to
   `localhost`), since every request carries the app password.

Bookings Banjo made before the switch stay in Google Calendar, and Banjo can no longer move or cancel
them: a reschedule or mid-call undo of one fails with "not a CalDAV event Banjo created" rather
than pretending it worked. Change those by hand. Likewise `CONTACTS_PROVIDER=none` ignores the
contacts cache entirely instead of trusting whatever an earlier provider last synced.

To revoke Banjo's access, delete the app password in Fastmail. Availability checks then fail with
HTTP 401, and contact syncs log the failure and keep the last cache, until you add a new one.

---

## Minting `GOOGLE_OAUTH_REFRESH_TOKEN` (Calendar + Contacts)

Banjo's Calendar and Google Contacts integrations share one OAuth2 client and refresh token — the same
`GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`/`GOOGLE_OAUTH_REFRESH_TOKEN` triple. The token must be
minted with both scopes at once; there's no way to add a scope to an existing refresh token after the fact.

### Steps

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), confirm your OAuth 2.0 Client
   ID has both the Calendar API and People API enabled for the project.
2. Go to [Google's OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
3. Click the gear icon, check "Use your own OAuth credentials," and enter your `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET`.
4. In Step 1, select both scopes:
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/contacts.readonly`
5. Authorize APIs, sign in as the principal (the Google account whose calendar/contacts Banjo acts on), and
   grant consent for both.
6. In Step 2, exchange the authorization code for tokens — copy the resulting **refresh token**.
7. Set `GOOGLE_OAUTH_REFRESH_TOKEN` in `.env` to that value and restart Banjo.

If `GOOGLE_OAUTH_REFRESH_TOKEN` is unset or lacks the `contacts.readonly` scope, Google Contacts sync/lookups
fail closed — they log and no-op rather than crash (see `src/googleContacts/sync.ts` and `lookup.ts`) — so
Calendar keeps working even before this step is done; Contacts integration just does nothing until the token
is upgraded. A Calendar-only token shows up in the logs as a single line:
`Google Contacts sync failed: GOOGLE_OAUTH_REFRESH_TOKEN lacks the contacts.readonly scope — re-mint it ...`
(Google's `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`, detected in `src/googleContacts/googleApiErrors.ts`).

### Checking which scopes a token has

The Cloud Console can't show this. Scopes belong to the refresh token, not the OAuth client, so the
Credentials page looks the same whether the token has one scope or both. Ask Google instead. This exchanges
the running container's refresh token for a short-lived access token and prints what it was granted. It
changes nothing:

```bash
docker compose exec -T app node -e '
const p = new URLSearchParams({client_id: process.env.GOOGLE_OAUTH_CLIENT_ID, client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN, grant_type: "refresh_token"});
fetch("https://oauth2.googleapis.com/token", {method: "POST", body: p}).then(r => r.json()).then(t => console.log(t.access_token ? "scopes: " + t.scope : "token exchange failed: " + t.error + " " + (t.error_description || "")));'
```

- `scopes: https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/contacts.readonly` means
  the token is good.
- `calendar` alone means it's Calendar-only. Mint a new one with the steps above.
- `token exchange failed: invalid_grant` means the token was revoked, expired, or pasted wrong.
- `token exchange failed: invalid_client` means the client ID or secret doesn't match the one the token was
  minted with.

This reads the container's environment, so after editing `.env` run `docker compose up -d app` first. A plain
`restart` keeps the old values. When running Banjo with `npm run dev`, run the same script with
`node --env-file=.env -e '...'` instead.

To check whether the APIs are enabled without the Console, use the Google Cloud CLI (`gcloud auth login`
first). The project number is the part of `GOOGLE_OAUTH_CLIENT_ID` before the first `-`:

```bash
gcloud services list --enabled --project <project-number> | grep -E 'calendar-json|people'
gcloud services enable people.googleapis.com --project <project-number>   # if People API is missing
```

To check which APIs are enabled for step 1, use the Cloud Console rather than the API hostnames themselves —
opening `https://calendar.googleapis.com/` or `https://www.googleapis.com/` in a browser returns Google's generic
"404. That's an error. The requested URL / was not found on this server," which is expected and means nothing.
The pages you want (make sure the project selector shows the project that owns your OAuth client — its project
number is the part of `GOOGLE_OAUTH_CLIENT_ID` before the first `-`):

- Enabled APIs: https://console.cloud.google.com/apis/dashboard
- Google Calendar API: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
- People API: https://console.cloud.google.com/apis/library/people.googleapis.com

## SMS notifications aren't arriving

**Symptom:** no outcome texts arrive, and the log shows `notification SMS blocked by the carrier` with `errorCode: 30034`. Before this check existed, nothing was logged at all: Twilio *accepts* the message, so the send succeeds, and the carrier blocks it afterwards. In Twilio's console (Monitor → Messaging) these show as **Undelivered, 30034**.

**Cause:** US carriers block texts to US numbers from a standard local number (10DLC) that isn't registered for **A2P 10DLC**. Voice calls on the same number are unaffected. See [Twilio error 30034](https://www.twilio.com/docs/api/errors/30034).

### Fix: register as a Sole Proprietor (one person, one number)

1. Twilio console → **Messaging → Regulatory Compliance → A2P 10DLC** (or search the console for "A2P 10DLC").
2. Register a **Sole Proprietor brand** for yourself. It asks for your name, address and a mobile number for a one-time verification text. Brand approval is usually quick; Twilio emails when it's done.
3. Create a **Sole Proprietor campaign**. Describe it plainly: *notifications to the account owner about the outcome of phone calls their assistant placed; recipient is the owner only.* Sample message: a real Banjo summary, e.g. "Booked with Luigi's: Friday, September 25 at 7:00 PM (90 min)."
4. Add `NOTIFY_FROM_PHONE_NUMBER` to the campaign's Messaging Service sender pool. A Sole Proprietor campaign allows exactly one number.
5. Wait for campaign approval (Twilio quotes up to about 5 business days), then send a test: place any short call and check the text arrives. The log stays quiet on success.

Costs, per Twilio's help center (check current pricing): a small one-time brand fee, a one-time campaign vetting fee, and a monthly campaign fee. See [A2P 10DLC pricing](https://help.twilio.com/articles/1260803965530-What-pricing-and-fees-are-associated-with-the-A2P-10DLC-service-).

**Alternatives:** a **toll-free** number with toll-free verification also works for US texts, and notifications can be turned off with `NOTIFICATION_CHANNEL=none`. The task outcome is always available from `get_task_status` either way.

## Running Banjo on an always-on Linux host

Banjo on a laptop stops answering when the laptop sleeps: scheduled calls don't start and inbound calls get no answer. These steps move it to any always-on Linux machine (a home server, a VM, an LXC container) with Docker and Docker Compose. The host needs nothing else. The app comes from the published `ghcr.io/shatch/banjo` image (amd64 and arm64), Postgres and the tunnel run as containers, and Banjo keeps no state outside Postgres (recordings stay at Twilio). 2 GB of RAM is plenty: the three containers use about 170 MB at idle.

This keeps the same public hostname by moving the ngrok agent to the host, so Twilio needs no changes. If you use another tunnel, swap the `ngrok` service below for it.

### 1. Prepare the host

```bash
git clone https://github.com/shatch/banjo.git ~/banjo
```

Copy your `.env` (and `banjo-profile.md`, if you use one) into `~/banjo/`, then `chmod 600 .env`. `PUBLIC_HOSTNAME` stays as it is, and compose sets `DATABASE_URL` for the container. Add your ngrok token to `.env` as `NGROK_AUTHTOKEN=...` (`ngrok config check` prints where your current config file is).

Create `~/banjo/docker-compose.override.yml` (it's git-ignored):

```yaml
services:
  postgres:
    ports: !reset []              # reachable only on the compose network
  app:
    ports: !override
      - '127.0.0.1:3000:3000'     # Twilio and MCP both come in through ngrok
    volumes:
      - ./banjo-profile.md:/app/banjo-profile.md:ro
  ngrok:
    image: ngrok/ngrok:latest
    restart: unless-stopped
    command: http --url=YOUR-DOMAIN.ngrok-free.dev app:3000 --log=stdout
    environment:
      NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN}
    depends_on: [app]
```

`docker compose config` should print the merged file without errors (`!reset` and `!override` need Compose 2.24 or later). Then pull the images and start only the database: `docker compose pull && docker compose up -d postgres`.

You can bind the app to a Tailscale address (for example `'100.x.y.z:3000:3000'`) so MCP stays off the public tunnel. Check that your tailnet's ACL allows that port from your machine: an ACL that only allows SSH to the host makes port 3000 time out, even though `curl` on the host itself works. Docker also needs that address to exist when it starts the container, so `127.0.0.1` is the safer default.

### 2. Move the data and cut over

The free ngrok plan allows one agent per domain, and two Banjo processes can't share a Twilio number's calls. So stop the old copy before starting the new one. Banjo is offline for a minute or two.

1. On the old machine, check that no call is in progress: `list_recent_tasks`, or no task in `pending`, `checking_availability`, `calling` or `negotiating`. A `pending` scheduled call is fine; the new host's poller picks it up.
2. Stop the old app, then dump its database:
   ```bash
   docker compose stop app
   docker compose exec -T postgres pg_dump -U banjo -Fc banjo > banjo-cutover.dump
   ```
3. Copy the dump to the host and restore it into the new, empty database:
   ```bash
   docker compose exec -T postgres pg_restore -U banjo -d banjo --no-owner < banjo-cutover.dump
   ```
   Compare `select count(*)` on `tasks`, `call_attempts` and `google_contacts` against the old database.
4. Stop the old machine's ngrok agent, then start everything on the host: `docker compose up -d`. Leave the old machine's app stopped, and keep its Postgres volume for a week or so as a rollback.

### 3. Point Claude Code at the host

```bash
claude mcp remove banjo -s local
claude mcp add --transport http -s local banjo https://YOUR-DOMAIN.ngrok-free.dev/mcp \
  --header "Authorization: Bearer $MCP_API_KEY"
```

Then run `/mcp` in any open Claude Code session. `/mcp` is stateless, so app restarts don't disconnect it. A client still on the older `/mcp/sse` endpoint loses its session on every restart (`No transport found for sessionId`) and needs `/mcp` to reconnect.

### 4. Check it

- `docker compose ps`: `app` and `postgres` are `healthy`, and `ngrok` is up. `docker compose logs app` shows `database migrations up to date` and no config errors.
- `curl https://YOUR-DOMAIN.ngrok-free.dev/health` returns 200.
- Place one short call (`mode: conversation`) to your own number. Its `call_attempts` row should have `disclosed = true`, a `recording_sid` if `RECORD_CALLS` is on, and transcript rows if `PERSIST_TRANSCRIPTS` is on.
- Reboot the host, and confirm all three containers and the tunnel come back by themselves. All services use `restart: unless-stopped`, so this only needs Docker enabled at boot (`systemctl is-enabled docker`).

### Nightly backups

Save as `~/backups/banjo-backup.sh` and `chmod +x` it:

```bash
#!/bin/bash
# Nightly pg_dump of Banjo's database; keeps the newest 14.
set -uo pipefail
cd "$HOME/banjo" || exit 1
out="$HOME/backups/banjo-$(date +%F).dump"
if docker compose exec -T postgres pg_dump -U banjo -Fc banjo > "$out.tmp"; then
  mv "$out.tmp" "$out"
else
  rm -f "$out.tmp"
  echo "banjo backup failed" >&2
  exit 1
fi
ls -1t "$HOME"/backups/banjo-*.dump | tail -n +15 | xargs -r rm -f
```

Run it once by hand, then schedule it with `crontab -e`:

```
30 3 * * * $HOME/backups/banjo-backup.sh >> $HOME/backups/backup.log 2>&1
```

These dumps sit on the same disk as the database. Copy them to another machine if the host itself might fail.

### Updating

Check for live calls first, then:

```bash
cd ~/banjo && git pull && docker compose pull && docker compose up -d
```

Pin a release with `BANJO_VERSION` in `.env` if you don't want `latest`.

## Cutting a release

A release is a `vX.Y.Z` tag on `main`. The tag builds and publishes the multi-arch image
(`.github/workflows/publish-image.yml`). The MCP Registry listing and the Claude Code plugin
then point at that version.

1. **Bump the version in three files**, in one commit: `package.json` (with
   `npm version X.Y.Z --no-git-tag-version`, so `package-lock.json` follows), `server.json`
   (`version` and the image tag in `packages[0].identifier`), and `.claude-plugin/plugin.json`.
   `tests/releaseManifests.test.ts` fails if they disagree, so CI catches a missed one.
2. **Tag and push**: `git tag vX.Y.Z && git push origin vX.Y.Z`. Wait for the publish workflow,
   then check that `ghcr.io/shatch/banjo:X.Y.Z` exists and that its
   `io.modelcontextprotocol.server.name` label reads `io.github.shatch/banjo`:
   ```bash
   docker buildx imagetools inspect ghcr.io/shatch/banjo:X.Y.Z --format '{{json .Image}}' | grep modelcontextprotocol
   ```
3. **Publish the GitHub Release** for the tag, with notes.
4. **Update the MCP Registry listing** from the repo root. The image must already exist: the
   registry checks its label against `server.json`'s `name`.
   ```bash
   brew install mcp-publisher     # once
   mcp-publisher login github     # every release: authenticates as shatch, which owns io.github.shatch/*
   mcp-publisher publish
   ```
   Log in each release: the registry token it saves expires, and `publish` with an old one fails
   with `401 ... token is expired`. Then check that the new version is the one marked latest:
   ```bash
   curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.shatch/banjo"
   ```
5. **The plugin needs no extra step.** Users who added the marketplace
   (`/plugin marketplace add shatch/banjo`) get the new `version` from `main` the next time they
   update.
