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
   Any sufficiently random string works — `MCP_API_KEY` has no format requirement beyond
   non-empty (`src/config/index.ts`'s `z.string().min(1, ...)`), just needs enough entropy that
   it can't be guessed/brute-forced.

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
   claude mcp add banjo "http://localhost:3000/mcp/sse" --transport sse \
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

To check which APIs are enabled for step 1, use the Cloud Console rather than the API hostnames themselves —
opening `https://calendar.googleapis.com/` or `https://www.googleapis.com/` in a browser returns Google's generic
"404. That's an error. The requested URL / was not found on this server," which is expected and means nothing.
The pages you want (make sure the project selector shows the project that owns your OAuth client — its project
number is the part of `GOOGLE_OAUTH_CLIENT_ID` before the first `-`):

- Enabled APIs: https://console.cloud.google.com/apis/dashboard
- Google Calendar API: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
- People API: https://console.cloud.google.com/apis/library/people.googleapis.com
