/**
 * The environment the simulator (scripts/sim.ts) runs under, applied before
 * anything imports src/config. Deliberately imports nothing from the app: it
 * has to run first, and config validates once, at import.
 *
 * Two kinds of value:
 * - Forced, whatever .env says: anything that could reach the outside world or
 *   the dev database. The sim writes only to its own `banjo_sim` database,
 *   sends no notification or webhook, records nothing, syncs no contacts.
 * - Placeholders, only where unset: credentials config insists on but the sim
 *   never uses (Twilio, MCP), so trying it needs no account but OpenAI's.
 */

export const SIM_DATABASE = 'banjo_sim';

/** The default from docker-compose.yml's postgres service. */
const DEFAULT_DATABASE_URL = 'postgresql://banjo:banjo@localhost:5432/banjo';

/** 202-555-01xx: reserved for fiction, never a real line. */
export const SIM_BUSINESS_NUMBER = '+12025550142';
const SIM_PLACEHOLDER_NUMBER = '+12025550100';
const SIM_OWNER_NUMBER = '+12025550199';

/** DATABASE_URL with its database swapped for banjo_sim — same server and credentials, never the same database. */
export function simDatabaseUrl(databaseUrl: string | undefined): string {
  const url = new URL(databaseUrl || DEFAULT_DATABASE_URL);
  url.pathname = `/${SIM_DATABASE}`;
  return url.toString();
}

export function simEnv(
  base: Record<string, string | undefined>,
  opts: { transfer: boolean; warm?: boolean; askOwner?: boolean; verbose: boolean },
): Record<string, string> {
  const placeholders: Record<string, string> = {
    TWILIO_ACCOUNT_SID: 'ACsimulator',
    TWILIO_AUTH_TOKEN: 'simulator',
    TWILIO_PHONE_NUMBER: SIM_PLACEHOLDER_NUMBER,
    MCP_API_KEY: 'simulator-placeholder-never-a-real-key',
    ASSISTANT_PRINCIPAL_NAME: 'Alex',
  };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(placeholders)) {
    if (!base[key]) env[key] = value;
  }
  return {
    ...env,
    DATABASE_URL: simDatabaseUrl(base.DATABASE_URL),
    VOICE_AI_PROVIDER: 'openai',
    CALENDAR_PROVIDER: 'google', // never constructed: the sim's calendar replaces it
    CONTACTS_PROVIDER: 'none',
    // ask_owner needs a channel to be on (config's check), so --ask-owner names
    // one with placeholder keys. Nothing reaches it: the sim overrides every
    // message to the owner (notifications/owner.ts's overrideOwnerMessages).
    ...(opts.askOwner
      ? {
          NOTIFICATION_CHANNEL: 'pushover',
          PUSHOVER_APP_TOKEN: 'simulator-never-sent',
          PUSHOVER_USER_KEY: 'simulator-never-sent',
          PUBLIC_HOSTNAME: 'sim.invalid',
          ASK_OWNER_ENABLED: 'true',
          ASK_OWNER_TIMEOUT_SECONDS: '30',
        }
      : { NOTIFICATION_CHANNEL: 'none', ASK_OWNER_ENABLED: 'false' }),
    TASK_WEBHOOK_URL: '',
    RECORD_CALLS: 'false',
    TRANSCRIBE_TRANSFERS: 'false',
    PERSIST_TRANSCRIPTS: 'true',
    INBOUND_BOOKING_ENABLED: 'false',
    TRANSFER_ENABLED: String(opts.transfer),
    TRANSFER_MODE: opts.warm ? 'warm' : 'cold',
    // Where a transfer would go. Fictional, and the sim's phone line only reports it.
    ...(opts.transfer ? { TRANSFER_TO_PHONE_NUMBER: SIM_OWNER_NUMBER } : {}),
    // Warnings are part of a normal call (a refused ending, a silence check) and the tool lines
    // already show them; as raw log lines they landed in the middle of what the person was typing.
    LOG_LEVEL: opts.verbose ? 'info' : 'error',
  };
}
