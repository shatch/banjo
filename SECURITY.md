# Security Policy

Banjo places real phone calls, holds credentials for Twilio, a voice AI vendor and Google, and
exposes an authenticated MCP endpoint to the internet. Bugs here cost money or leak personal data,
so they're worth reporting.

## Reporting a vulnerability

Please report privately, not as a public issue: use
[GitHub's private vulnerability reporting](https://github.com/shatch/banjo/security/advisories/new)
on this repository.

Include what you'd want to receive: affected version or commit, the configuration it needs, the
steps, and what an attacker gets out of it.

**What to expect.** Banjo is maintained by one person as a side project. Realistically: an
acknowledgement within about a week, and a fix timeline that depends on severity and on the rest of
life. If a week passes with no reply, please ping the issue tracker with "sent a security report"
and no details. There is no bug bounty.

## Supported versions

Only `main` — and the most recent release. Older tags do not get backported fixes.

## What's in scope

The things most likely to be wrong, roughly in order of how much damage they do:

- **`MCP_API_KEY` handling.** One static bearer token gates every route under `/mcp`
  (`src/mcp/server.ts`'s `requireAuth`), and that endpoint is internet-reachable. Whoever holds it
  can call `place_call` — which spends money and rings real phones — and read contact PII. There is
  no expiry or automatic rotation; see [`docs/RUNBOOKS.md`](docs/RUNBOOKS.md)'s "Rotating
  `MCP_API_KEY`" and `docs/ARCHITECTURE.md`'s Open Risks.
- **Twilio webhook signature validation.** `src/server.ts` reconstructs the signed URL from
  `PUBLIC_HOSTNAME` rather than trusting the request's own `Host` header, for the webhooks and for the
  Media Streams WebSocket upgrade (`isValidTwilioStreamSignature`); a stream then attaches only to a
  call Banjo placed or answered. Bypasses of either check, or ways to make one validate a request it
  shouldn't, are in scope. `TWILIO_WEBHOOK_VALIDATION_ENABLED`
  exists for local testing; running with it off in production is misconfiguration, not a finding.
- **Credential exposure.** `GOOGLE_OAUTH_REFRESH_TOKEN`, `TWILIO_AUTH_TOKEN` and voice-AI API keys
  leaking into logs, error responses, MCP tool output, or TwiML.
- **PII in logs.** Phone numbers, caller identity and conversation content. Some of this is *known*
  and tracked rather than secret: `LOG_TRANSCRIPTS` is off by default and logs call text when on;
  pino's `redact` config (`src/lib/logger.ts`) masks phone-number fields to their last 4 digits and
  logs voicemail text and raw tool arguments as a length, but a vendor error message can still quote a
  number. Reports that sharpen the picture are welcome.
- **Anything that places, redirects or answers a call it shouldn't**, or books/cancels a calendar
  event outside the requesting task.

## What's out of scope

- Missing hardening on a deployment you configured yourself (no TLS, `MCP_API_KEY` in a public
  repo, Postgres exposed to the internet, webhook validation disabled).
- Vulnerabilities in Twilio, OpenAI, Google or other upstream vendors — report those to them.
- `npm audit` output on transitive development dependencies, absent a demonstrated path to impact.
- The fact that Banjo is single-tenant and has no authorization model beyond `MCP_API_KEY`. That's
  a documented design choice (see `CONTRIBUTING.md`), not a bug.
- Calling Banjo's AI disclosure inadequate. It is — it's a known gap with a roadmap item, not a
  vulnerability report.
