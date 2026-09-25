import 'dotenv/config';
import { z } from 'zod';

/**
 * Twilio (and telephony generally) requires E.164 — a leading `+`, no
 * spaces/dashes/parens. Validated here rather than left to fail deep inside
 * a live call/notification (as `Invalid From Number (caller ID)` did once,
 * from a NOTIFY_FROM_PHONE_NUMBER missing its `+`) so a typo is caught at
 * startup with a clear message instead of during a real phone call.
 */
const e164 = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, 'must be in E.164 format, e.g. +15551234567 (leading +, no spaces/dashes)')
  .optional();

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
    // The one calendar collection to read and write, e.g.
    // https://caldav.fastmail.com/dav/calendars/user/you@fastmail.com/<calendar-id>/
    // `npm run dav:check` lists an account's calendars and address books with their URLs.
    CALDAV_CALENDAR_URL: z.string().url().optional(),
    // The one address book to sync, e.g.
    // https://carddav.fastmail.com/dav/addressbooks/user/you@fastmail.com/Default/
    CARDDAV_ADDRESSBOOK_URL: z.string().url().optional(),

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

    NOTIFICATION_CHANNEL: z.enum(['twilio_sms', 'none']).default('twilio_sms'),
    NOTIFY_TO_PHONE_NUMBER: e164,
    NOTIFY_FROM_PHONE_NUMBER: e164,

    // 32-char floor (not just non-empty): the MCP endpoint is internet-reachable,
    // so a short key is brute-forceable. RUNBOOKS.md recommends `openssl rand -hex 32`.
    MCP_API_KEY: z
      .string()
      .min(32, 'MCP_API_KEY must be at least 32 characters — the MCP endpoint is internet-reachable'),

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
  const line = config.DISCLOSURE_LINE.replaceAll('{name}', config.ASSISTANT_PRINCIPAL_NAME);
  return config.RECORD_CALLS && !RECORDING_NOTICE.test(line) ? `${line} This call is recorded.` : line;
}
export type AppConfig = typeof config;

/** How often the contacts cache refreshes, under whichever name is set. */
export function contactsSyncIntervalHours(): number {
  return config.CONTACTS_SYNC_INTERVAL_HOURS ?? config.GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS;
}
