import 'dotenv/config';
import { z } from 'zod';

/**
 * Twilio (and telephony generally) requires E.164 — a leading `+`, no
 * spaces/dashes/parens. Validated here rather than left to fail deep inside
 * a live call/notification (as `Invalid From Number (caller ID)` did once,
 * from a NOTIFY_FROM_PHONE_NUMBER missing its `+`) so a typo is caught at
 * startup with a clear message instead of during a real phone call.
 */
/**
 * An optional setting where an empty value (`NOTIFY_TO_PHONE_NUMBER=`, as
 * .env.example ships it) means unset, rather than failing `schema`. Without
 * this, anyone not using SMS had to comment the empty lines out before
 * Banjo would boot.
 */
function optionalSetting<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

const e164 = optionalSetting(
  z.string().regex(/^\+[1-9]\d{1,14}$/, 'must be in E.164 format, e.g. +15551234567 (leading +, no spaces/dashes)'),
);

/**
 * A CalDAV/CardDAV collection URL. Every request to it carries the app
 * password as Basic auth, so plain http is refused — except to this machine,
 * e.g. a Radicale server for development.
 */
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// A dotless hostname is a Docker Compose service or container name; public DNS
// never resolves one. Bracketed IPv6 literals are excluded (only [::1] is local).
const isLocalWebhookHost = (hostname: string) =>
  LOOPBACK_HOSTS.has(hostname) || (!hostname.includes('.') && !hostname.startsWith('['));
const davUrl = (name: string) =>
  z
    .string()
    .url()
    .refine((v) => {
      const { protocol, hostname } = new URL(v);
      return protocol === 'https:' || (protocol === 'http:' && LOOPBACK_HOSTS.has(hostname));
    }, `${name} must use https — it carries the DAV app password (plain http is allowed only to localhost)`);

/**
 * Single source of truth for process configuration. Parsed once, at import
 * time, so the process fails fast on a missing/invalid value rather than
 * discovering it mid-call. Import this module first in src/index.ts.
 */
/** "AI" or "A.I." as a word — not the letters inside "said" or "wait". Shared with session/disclosure.ts. */
export const AI_WORD = /\bA\.?I\b/i;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    PUBLIC_HOSTNAME: z.string().min(1).optional(),

    // The human this assistant acts on behalf of — every outbound/inbound
    // call's system prompt identifies itself using this name (e.g. "calling
    // on behalf of Alex"). Required with no default so a fork can't
    // accidentally run with a placeholder identity on a real call.
    ASSISTANT_PRINCIPAL_NAME: z.string().min(1, 'ASSISTANT_PRINCIPAL_NAME is required'),

    // What Banjo says first on every outbound call (#8): that it's an AI, and
    // for whom. {name} becomes ASSISTANT_PRINCIPAL_NAME. The wording is yours;
    // saying "AI" is not optional — the TCPA/FCC and California AB 2905
    // exposure is on this path, and it's the decent thing to tell whoever
    // picks up. Checked after each call against what was actually said
    // (session/disclosure.ts).
    DISCLOSURE_LINE: z
      .string()
      .default("Hi, I'm an AI assistant calling on behalf of {name}.")
      .refine((line) => AI_WORD.test(line), {
        message: 'DISCLOSURE_LINE must say "AI" — it is how every outbound call tells the other party they are talking to an AI',
      }),

    DATABASE_URL: z.string().url(),

    // Apply the committed drizzle/ migrations at startup (see src/db/migrate.ts).
    // On by default so `docker compose up` on a fresh volume, and a plain
    // `npm run dev` after pulling a schema change, both just work — the
    // previous alternative was a README step people skipped, and a skipped
    // migration surfaces as `column "..." does not exist` deep inside the
    // orchestration poller rather than at boot. Set false when something
    // upstream owns schema (a managed migration job, a read-only replica).
    // Same z.enum(['true','false']) reasoning as LOG_TRANSCRIPTS below.
    RUN_MIGRATIONS_ON_BOOT: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    VOICE_AI_PROVIDER: z.enum(['openai', 'openai-live', 'gemini', 'elevenlabs']),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime'),
    // Input noise reduction for VOICE_AI_PROVIDER=openai, applied before
    // turn detection (#143): a pickup click, or Banjo's own voice echoing
    // back from a speakerphone, was read as the callee talking and kept
    // cutting off the opener. 'far_field' suits speakerphones, 'near_field'
    // handsets; 'off' sends none (OpenAI's default).
    OPENAI_NOISE_REDUCTION: z.enum(['far_field', 'near_field', 'off']).default('far_field'),
    // VOICE_AI_PROVIDER=openai-live (src/voice/providers/openaiLive.ts): the
    // GPT-Live full-duplex voice front-end, with reasoning and tool calls
    // delegated to a separate Responses backend model. Ships dark — tested on
    // live calls, but not the default. Reuses OPENAI_API_KEY.
    OPENAI_LIVE_MODEL: z.string().default('gpt-live-1'),
    // Unconfirmed default: OpenAI's Live delegation docs use both
    // gpt-5.6-terra and gpt-5.6-luna in different examples (both are valid
    // Responses model ids in openai-node's model enum). See
    // docs/ARCHITECTURE.md's Open Risks.
    OPENAI_LIVE_BACKEND_MODEL: z.string().default('gpt-5.6-terra'),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_LIVE_MODEL: z.string().optional(),
    ELEVENLABS_API_KEY: z.string().optional(),
    ELEVENLABS_AGENT_ID: z.string().optional(),

    // Twilio is the only telephony provider (a LiveKit adapter was
    // scaffolded early on, never got past non-functional audio I/O
    // placeholders, and was removed — see docs/ARCHITECTURE.md's Open
    // Risks history). Kept optional here + enforced via .refine() below
    // rather than required outright, consistent with how the other
    // credential groups in this schema are validated.
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_PHONE_NUMBER: e164,
    // Whether the 3 inbound Twilio webhook routes (src/server.ts's
    // /telephony/twiml, /amd-callback, /inbound) require a valid
    // X-Twilio-Signature header before processing — see
    // isValidTwilioSignature() in src/server.ts. Defaults ON (secure by
    // default). Turn off locally to curl-test these routes directly: a
    // hand-crafted request can't produce a signature that validates
    // against a real TWILIO_AUTH_TOKEN, since Twilio computes it as an
    // HMAC of the exact URL + POST params using that token as the key.
    // Should stay 'true' anywhere real Twilio traffic reaches the process,
    // including any real deployment — this is not a NODE_ENV-based
    // implicit rule, deliberately, so it's an explicit, auditable switch
    // like LOG_TRANSCRIPTS/INBOUND_BOOKING_ENABLED above.
    TWILIO_WEBHOOK_VALIDATION_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    // Which backend holds the principal's calendar. 'google' uses the OAuth
    // vars below; 'caldav' (Fastmail, iCloud, Nextcloud, ...) uses
    // CALDAV_CALENDAR_URL and the DAV_* app password. See
    // src/calendar/factory.ts.
    CALENDAR_PROVIDER: z.enum(['google', 'caldav']).default('google'),
    // Where the principal's contacts come from, for caller ID and
    // find_contact's fallback: 'google' (People API, the OAuth vars below),
    // 'carddav' (CARDDAV_ADDRESSBOOK_URL and the DAV_* app password), or
    // 'none'. See src/carddavContacts/.
    CONTACTS_PROVIDER: z.enum(['google', 'carddav', 'none']).default('google'),
    // One account's sign-in for both CalDAV and CardDAV — for Fastmail, the
    // account's email address and an app password with calendar and
    // contacts access.
    DAV_USERNAME: z.string().min(1).optional(),
    DAV_PASSWORD: z.string().min(1).optional(),
    // Your own addresses, comma-separated, so CalDAV invitations you declined
    // don't block time. Optional: by default they're read from the server
    // (calendar-user-address-set), which Fastmail and iCloud publish. Set this
    // when that list is missing or wrong, e.g. invitations go to a custom
    // domain your login isn't on.
    DAV_OWNER_EMAIL: optionalSetting(
      z
        .string()
        .refine(
          (v) => v.split(',').every((a) => /^(mailto:)?[^\s@,]+@[^\s@,]+\.[^\s@,]+$/i.test(a.trim())),
          'DAV_OWNER_EMAIL must be one or more email addresses, comma-separated',
        ),
    ),
    // The one calendar collection to read and write, e.g.
    // https://caldav.fastmail.com/dav/calendars/user/you@fastmail.com/<calendar-id>/
    // `npm run dav:check` lists an account's calendars and address books with their URLs.
    CALDAV_CALENDAR_URL: davUrl('CALDAV_CALENDAR_URL').optional(),
    // The one address book to sync, e.g.
    // https://carddav.fastmail.com/dav/addressbooks/user/you@fastmail.com/Default/
    CARDDAV_ADDRESSBOOK_URL: davUrl('CARDDAV_ADDRESSBOOK_URL').optional(),

    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
    GOOGLE_OAUTH_REFRESH_TOKEN: z.string().optional(),
    GOOGLE_CALENDAR_ID: z.string().default('primary'),
    // IANA zone identifier. "2pm" on a phone call is meaningless without
    // knowing whose 2pm — this is the single source of truth for what
    // timezone every date/time discussed on a call and written to the
    // calendar is interpreted in. A real booking once landed 4 hours off
    // (2pm requested, 10am on the calendar) because nothing told the model
    // or the calendar-write path which zone was intended, and a bare
    // "2026-08-04T14:00:00" with no offset got parsed as UTC.
    CALENDAR_TIMEZONE: z.string().min(1).default('America/New_York'),

    // Optional path to the owner's profile: standing facts and preferences
    // added to every outbound call prompt, below the fixed rules. See
    // src/tasks/ownerProfile.ts and banjo-profile.example.md.
    PROMPT_PROFILE_FILE: z.string().min(1).optional(),

    NOTIFICATION_CHANNEL: z.enum(['twilio_sms', 'pushover', 'none']).default('twilio_sms'),
    // NOTIFICATION_CHANNEL=pushover: the application's API token and the
    // owner's user (or group) key, from pushover.net. PUSHOVER_DEVICE limits
    // delivery to one of the owner's devices; unset, every device gets it.
    PUSHOVER_APP_TOKEN: optionalSetting(z.string()),
    PUSHOVER_USER_KEY: optionalSetting(z.string()),
    PUSHOVER_DEVICE: optionalSetting(z.string()),
    NOTIFY_TO_PHONE_NUMBER: e164,
    NOTIFY_FROM_PHONE_NUMBER: e164,

    // Optional: POSTed a signed JSON event when a call finishes, so an agent
    // that placed it (OpenClaw, Hermes Agent, n8n, ...) hears back instead of
    // polling get_task_status (docs/ROADMAP.md, 4.4). Signed with
    // TASK_WEBHOOK_SECRET the way Hermes Agent checks generic webhooks;
    // TASK_WEBHOOK_TOKEN, if set, is also sent as a bearer token, for
    // receivers such as OpenClaw's hooks that authenticate that way. https
    // only, since the body carries the call's outcome, except to localhost or
    // a single-label host such as a Docker Compose service name (`hermes`),
    // which never leaves the machine's own network. That exception sends the
    // outcome unencrypted across the Docker network; see issue #115 and the TLS
    // sidecar in docs/AGENT_SETUP.md.
    TASK_WEBHOOK_URL: optionalSetting(
      z
        .string()
        .url()
        .refine((v) => {
          const { protocol, hostname } = new URL(v);
          return protocol === 'https:' || (protocol === 'http:' && isLocalWebhookHost(hostname));
        }, 'TASK_WEBHOOK_URL must use https (plain http is allowed only to localhost or a Docker service name)'),
    ),
    // Same 32-char floor as MCP_API_KEY: it's what lets the receiver trust the event.
    TASK_WEBHOOK_SECRET: optionalSetting(z.string().min(32, 'TASK_WEBHOOK_SECRET must be at least 32 characters')),
    TASK_WEBHOOK_TOKEN: optionalSetting(z.string()),
    // Who tells the owner a call's outcome. `webhook`: the agent behind
    // TASK_WEBHOOK_URL does (e.g. Hermes over iMessage), so the end-of-call
    // summary skips NOTIFICATION_CHANNEL unless the webhook isn't delivered.
    // One-off owner messages (hold, inbound bookings, flagged calls) still go
    // through NOTIFICATION_CHANNEL either way: the webhook doesn't carry them.
    OUTCOME_SUMMARY_VIA: z.enum(['notification', 'webhook']).default('notification'),

    // 32-char floor (not just non-empty): the MCP endpoint is internet-reachable,
    // so a short key is brute-forceable. RUNBOOKS.md recommends `openssl rand -hex 32`.
    MCP_API_KEY: z
      .string()
      .min(32, 'MCP_API_KEY must be at least 32 characters — the MCP endpoint is internet-reachable'),
    // A second key for always-on agents (Hermes, OpenClaw). A call placed
    // with it waits for the owner to approve it from a signed link
    // (src/approvals/). Unset: there's no agent role.
    MCP_AGENT_API_KEY: optionalSetting(z.string().min(32, 'MCP_AGENT_API_KEY must be at least 32 characters')),

    TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

    // Off by default: call transcripts can contain PII, medical/appointment
    // details, identity-verification info a business asks for (a DOB, etc).
    // Logging them is genuinely useful for local-dev debugging (see
    // callSession.ts's handleVoiceAIEvent), but writing that unconditionally
    // to application logs is a real production exposure — see
    // docs/ARCHITECTURE.md's Open Risks. Deliberately NOT z.coerce.boolean():
    // that coerces via JS `Boolean(str)`, so `LOG_TRANSCRIPTS=false` (a
    // non-empty string) would coerce to `true` — the opposite of what
    // someone setting it would expect.
    LOG_TRANSCRIPTS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    // Save every call's finalised transcript lines to Postgres (#6,
    // src/transcripts/). Off by default: this turns what was said on a call
    // into stored personal data, which each install should choose to do.
    // Same z.enum(['true','false']) reasoning as LOG_TRANSCRIPTS above.
    PERSIST_TRANSCRIPTS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Saved transcripts older than this are deleted (at boot, then daily).
    // Applies even with PERSIST_TRANSCRIPTS off, so turning saving off doesn't
    // leave old transcripts behind forever. 0 = keep forever — must be set
    // explicitly; the default is a retention window, not an absence of one.
    TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),

    // Record outbound calls, two-track, in your Twilio account (#8). Off by
    // default. With it on, the opening line gains a recording notice (see
    // disclosureLine) and recording starts only once Banjo has said it — so
    // nothing is recorded before the other party is told.
    RECORD_CALLS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Recordings older than this are deleted from Twilio (at boot, then daily),
    // even with RECORD_CALLS off. 0 keeps them forever — set explicitly.
    RECORDING_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),

    // Kill switch for the inbound voice booking line (see
    // docs/superpowers/specs/2026-08-07-inbound-voice-booking-design.md) —
    // off by default so the public phone line only goes live once every
    // downstream piece (routing, tools, abuse-mitigation posture) is
    // actually ready, not the moment this env var exists.
    INBOUND_BOOKING_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Comma-separated day-of-week numbers a caller can book into, 0 (Sunday)
    // through 6 (Saturday) — matches the numbering Date#getUTCDay() and
    // src/lib/timezone.ts's getZonedParts().weekday both already use, so
    // src/inbound/businessHours.ts can compare them directly with no
    // remapping.
    BUSINESS_HOURS_DAYS: z
      .string()
      .regex(/^[0-6](,[0-6])*$/, 'must be a comma-separated list of day numbers 0 (Sun) - 6 (Sat), e.g. "1,2,3,4,5"')
      .default('1,2,3,4,5'),
    BUSINESS_HOURS_START: z.coerce.number().int().min(0).max(23).default(9),
    // Exclusive upper bound (24 = midnight) — a booking must END at or
    // before this hour, not start before it. See src/inbound/businessHours.ts.
    BUSINESS_HOURS_END: z.coerce.number().int().min(1).max(24).default(17),
    INBOUND_DEFAULT_DURATION_MINUTES: z.coerce.number().int().positive().default(30),
    INBOUND_MAX_LOOKAHEAD_DAYS: z.coerce.number().int().positive().default(14),
    // ISO 3166-1 alpha-2 region used to interpret a phone number with no
    // explicit country code, when normalizing Google Contacts phone numbers
    // to E.164 for matching against Twilio's caller ID. See
    // src/googleContacts/phoneNormalization.ts.
    DEFAULT_PHONE_REGION: z.string().length(2).default('US'),
    // How often the local Google Contacts cache refreshes. Personal contact
    // lists are small — a full list, not an incremental sync, runs on this
    // interval; see src/googleContacts/sync.ts and this plan's Global
    // Constraints for why incremental sync was dropped from the design.
    GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS: z.coerce.number().int().positive().default(6),
    // Provider-neutral name for the same interval; wins when set. Kept
    // alongside the old name so existing .env files keep working.
    CONTACTS_SYNC_INTERVAL_HOURS: z.coerce.number().int().positive().optional(),
    // Interaction count (tasks + inbound calls tied to a contact) at or
    // above which an inbound caller with no Google relationship tier still
    // gets a warmer "welcome back" greeting. See src/inbound/callerContext.ts.
    FREQUENT_CONTACT_THRESHOLD: z.coerce.number().int().positive().default(3),

    // Hard cap on outbound calls to one phone number in any rolling 24 hours.
    // place_call refuses past it, and a scheduled call that would exceed it is
    // failed instead of dialed (src/tasks/callCap.ts). An operator setting on
    // purpose: nothing the model or an MCP client sends can raise it. Five
    // test calls to one friend in one evening is how this came about.
    MAX_CALLS_PER_NUMBER_PER_DAY: z.coerce.number().int().min(1).default(3),
    // Big companies' support lines (an IVR and a call centre, not a person's
    // phone), allowed CALL_CAP_BUSINESS_MAX calls a day instead: getting
    // through a long phone menu can take more tries than three. Operator
    // settings only, like the cap itself: nothing an MCP client or a call
    // sends can add a number here. Comma-separated E.164.
    CALL_CAP_BUSINESS_NUMBERS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((n) => n.trim()).filter(Boolean))
      .pipe(z.array(z.string().regex(/^\+[1-9]\d{1,14}$/, 'each number must be in E.164 format, e.g. +18005551234'))),
    CALL_CAP_BUSINESS_MAX: z.coerce.number().int().min(1).max(20).default(10),

    // Cold call transfer to the principal's phone (#7). Off by default: when
    // on, both the outbound and inbound tool lists gain transfer_to_owner and
    // the prompts gain the rule for when to use it (voice/systemPrompt.ts).
    TRANSFER_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // The longest an outbound call waits on hold for a person (#151). Also cut
    // short to leave the voice session (OpenAI: 60 minutes) ten minutes to talk
    // in. place_call's constraints.maxHoldMinutes can lower it for one call.
    HOLD_MAX_MINUTES: z.coerce.number().int().min(1).max(45).default(20),
    // How transfer_to_owner reaches the principal (#149). 'cold' redirects the
    // call to ring them, and Banjo is off the call either way. 'warm' calls
    // them on a second line and reads them Banjo's brief: they press 1 to be
    // bridged in, and anything else leaves Banjo on the call to carry on.
    TRANSFER_MODE: z.enum(['cold', 'warm']).default('cold'),
    // Where a transfer rings. Fixed here, never chosen by the model, so a
    // callee can't talk Banjo into bridging them to an arbitrary number.
    TRANSFER_TO_PHONE_NUMBER: e164,
    // Said to the other party when a cold transfer isn't answered (declined,
    // busy, no answer), before hanging up. A warm one never hangs up on them.
    TRANSFER_FALLBACK_MESSAGE: z
      .string()
      .min(1)
      .default("Sorry, they couldn't be reached right now. They'll get back to you soon. Goodbye."),
    // When the other party asks something the task doesn't cover, Banjo asks
    // the owner mid-call (ask_owner, src/ownerQuestions/): a message through
    // NOTIFICATION_CHANNEL with a signed link to a page where the owner types
    // the answer, which is relayed into the call. Off by default.
    ASK_OWNER_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // How long Banjo waits for the owner's answer before it's told none came.
    ASK_OWNER_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
    // Transcribe what's said after a cold transfer, between the principal and
    // the other party. Off by default. Both hear a recording notice before
    // they're bridged; the recording is transcribed into the call's
    // transcript once the call ends, then deleted from Twilio.
    TRANSCRIBE_TRANSFERS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Call screening (#150, src/screening/): each place_call request is
    // checked before a task is created, and a scheduled call again when it
    // comes due. A request to someone who asked not to be called again, one
    // the model flags, or one the check couldn't run on waits for the
    // owner's approval through the same signed link as an agent's request.
    // Off by default.
    SCREEN_CALLS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // The OpenAI Responses model that screens requests.
    SCREEN_CALLS_MODEL: z.string().min(1).default('gpt-5.6-terra'),
  })
  .refine((v) => v.VOICE_AI_PROVIDER !== 'openai' || !!v.OPENAI_API_KEY, {
    message: 'OPENAI_API_KEY is required when VOICE_AI_PROVIDER=openai',
    path: ['OPENAI_API_KEY'],
  })
  .refine((v) => v.VOICE_AI_PROVIDER !== 'openai-live' || !!v.OPENAI_API_KEY, {
    message: 'OPENAI_API_KEY is required when VOICE_AI_PROVIDER=openai-live',
    path: ['OPENAI_API_KEY'],
  })
  .refine((v) => v.VOICE_AI_PROVIDER !== 'gemini' || !!v.GEMINI_API_KEY, {
    message: 'GEMINI_API_KEY is required when VOICE_AI_PROVIDER=gemini',
    path: ['GEMINI_API_KEY'],
  })
  .refine((v) => v.VOICE_AI_PROVIDER !== 'elevenlabs' || !!(v.ELEVENLABS_API_KEY && v.ELEVENLABS_AGENT_ID), {
    message: 'ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are required when VOICE_AI_PROVIDER=elevenlabs',
    path: ['ELEVENLABS_API_KEY'],
  })
  .refine((v) => v.CALENDAR_PROVIDER !== 'caldav' || !!(v.CALDAV_CALENDAR_URL && v.DAV_USERNAME && v.DAV_PASSWORD), {
    message: 'CALDAV_CALENDAR_URL, DAV_USERNAME, and DAV_PASSWORD are required when CALENDAR_PROVIDER=caldav',
    path: ['CALDAV_CALENDAR_URL'],
  })
  .refine((v) => v.CONTACTS_PROVIDER !== 'carddav' || !!(v.CARDDAV_ADDRESSBOOK_URL && v.DAV_USERNAME && v.DAV_PASSWORD), {
    message: 'CARDDAV_ADDRESSBOOK_URL, DAV_USERNAME, and DAV_PASSWORD are required when CONTACTS_PROVIDER=carddav',
    path: ['CARDDAV_ADDRESSBOOK_URL'],
  })
  .refine((v) => !!(v.TWILIO_ACCOUNT_SID && v.TWILIO_AUTH_TOKEN && v.TWILIO_PHONE_NUMBER), {
    message: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER are required — Twilio is the only telephony provider',
    path: ['TWILIO_ACCOUNT_SID'],
  })
  .refine(
    (v) =>
      v.NOTIFICATION_CHANNEL !== 'twilio_sms' ||
      !!(v.NOTIFY_TO_PHONE_NUMBER && v.NOTIFY_FROM_PHONE_NUMBER && v.TWILIO_ACCOUNT_SID && v.TWILIO_AUTH_TOKEN),
    {
      message: 'NOTIFY_TO_PHONE_NUMBER, NOTIFY_FROM_PHONE_NUMBER, and Twilio credentials are required when NOTIFICATION_CHANNEL=twilio_sms',
      path: ['NOTIFY_TO_PHONE_NUMBER'],
    },
  )
  .refine((v) => v.NOTIFICATION_CHANNEL !== 'pushover' || !!(v.PUSHOVER_APP_TOKEN && v.PUSHOVER_USER_KEY), {
    message: 'PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY are required when NOTIFICATION_CHANNEL=pushover',
    path: ['PUSHOVER_APP_TOKEN'],
  })
  .refine((v) => v.OUTCOME_SUMMARY_VIA !== 'webhook' || !!v.TASK_WEBHOOK_URL, {
    message: 'TASK_WEBHOOK_URL is required when OUTCOME_SUMMARY_VIA=webhook',
    path: ['TASK_WEBHOOK_URL'],
  })
  .refine((v) => !v.TASK_WEBHOOK_URL || !!v.TASK_WEBHOOK_SECRET, {
    message: 'TASK_WEBHOOK_SECRET is required when TASK_WEBHOOK_URL is set',
    path: ['TASK_WEBHOOK_SECRET'],
  })
  .refine((v) => !v.MCP_AGENT_API_KEY || v.MCP_AGENT_API_KEY !== v.MCP_API_KEY, {
    message: 'MCP_AGENT_API_KEY must differ from MCP_API_KEY: the agent key is what makes a call wait for approval',
    path: ['MCP_AGENT_API_KEY'],
  })
  .refine((v) => !v.MCP_AGENT_API_KEY || !!v.PUBLIC_HOSTNAME, {
    message: 'PUBLIC_HOSTNAME is required when MCP_AGENT_API_KEY is set: approval links point at it',
    path: ['PUBLIC_HOSTNAME'],
  })
  .refine((v) => !v.MCP_AGENT_API_KEY || v.NOTIFICATION_CHANNEL !== 'none', {
    message: "NOTIFICATION_CHANNEL can't be none when MCP_AGENT_API_KEY is set: approval requests go to the owner through it",
    path: ['NOTIFICATION_CHANNEL'],
  })
  .refine((v) => v.CALL_CAP_BUSINESS_MAX >= v.MAX_CALLS_PER_NUMBER_PER_DAY, {
    message: 'CALL_CAP_BUSINESS_MAX must be at least MAX_CALLS_PER_NUMBER_PER_DAY: it raises the cap for support lines, never lowers it',
    path: ['CALL_CAP_BUSINESS_MAX'],
  })
  .refine((v) => !v.TRANSFER_ENABLED || !!v.TRANSFER_TO_PHONE_NUMBER, {
    message: 'TRANSFER_TO_PHONE_NUMBER is required when TRANSFER_ENABLED=true',
    path: ['TRANSFER_TO_PHONE_NUMBER'],
  })
  .refine((v) => !v.ASK_OWNER_ENABLED || (v.NOTIFICATION_CHANNEL !== 'none' && !!v.PUBLIC_HOSTNAME), {
    message: "ASK_OWNER_ENABLED needs a NOTIFICATION_CHANNEL other than none and PUBLIC_HOSTNAME: questions reach the owner as a link through it",
    path: ['ASK_OWNER_ENABLED'],
  })
  .refine((v) => !v.SCREEN_CALLS || (!!v.OPENAI_API_KEY && v.NOTIFICATION_CHANNEL !== 'none' && !!v.PUBLIC_HOSTNAME), {
    message:
      'SCREEN_CALLS needs OPENAI_API_KEY, a NOTIFICATION_CHANNEL other than none, and PUBLIC_HOSTNAME: requests are checked by OpenAI, and a held one reaches the owner as a link',
    path: ['SCREEN_CALLS'],
  })
  .refine((v) => !v.TRANSCRIBE_TRANSFERS || (v.PERSIST_TRANSCRIPTS && !!v.OPENAI_API_KEY), {
    message: 'TRANSCRIBE_TRANSFERS needs PERSIST_TRANSCRIPTS=true and OPENAI_API_KEY: the transcript is saved with the call, transcribed by OpenAI',
    path: ['TRANSCRIBE_TRANSFERS'],
  })
  .refine((v) => v.BUSINESS_HOURS_START < v.BUSINESS_HOURS_END, {
    message: 'BUSINESS_HOURS_START must be earlier than BUSINESS_HOURS_END',
    path: ['BUSINESS_HOURS_START'],
  });

export const config = envSchema.parse(process.env);

/** A recording notice, as a word: "recorded", "recording". Shared with session/callSession.ts, which starts recording once Banjo has said it. */
export const RECORDING_NOTICE = /\brecord(ed|ing)?\b/i;

/**
 * DISCLOSURE_LINE with {name} filled in — the sentence every outbound call
 * opens with. With RECORD_CALLS on it also carries a recording notice, added
 * here unless the owner's wording already has one (#8).
 */
export function disclosureLine(): string {
  const line = disclosureLineWithoutNotice();
  return config.RECORD_CALLS && !RECORDING_NOTICE.test(line) ? `${line} This call is recorded.` : line;
}

/** DISCLOSURE_LINE with {name} filled in, without the recording notice disclosureLine() may add. */
export function disclosureLineWithoutNotice(): string {
  return config.DISCLOSURE_LINE.replaceAll('{name}', config.ASSISTANT_PRINCIPAL_NAME);
}
export type AppConfig = typeof config;

/** How often the contacts cache refreshes, under whichever name is set. */
export function contactsSyncIntervalHours(): number {
  return config.CONTACTS_SYNC_INTERVAL_HOURS ?? config.GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS;
}
