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

    DATABASE_URL: z.string().url(),

    VOICE_AI_PROVIDER: z.enum(['openai', 'openai-live', 'gemini', 'elevenlabs']),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime'),
    // VOICE_AI_PROVIDER=openai-live (src/voice/providers/openaiLive.ts): the
    // GPT-Live full-duplex voice front-end, with reasoning and tool calls
    // delegated to a separate Responses backend model. Ships dark — never
    // verified on a live call. Reuses OPENAI_API_KEY.
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
export type AppConfig = typeof config;
