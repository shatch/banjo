import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://ea:ea@localhost:5432/ea',
  VOICE_AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'sk-test',
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'authtest',
  TWILIO_PHONE_NUMBER: '+15551234567',
  NOTIFICATION_CHANNEL: 'none',
  MCP_API_KEY: 'test-mcp-key-do-not-use-in-prod-1',
  ASSISTANT_PRINCIPAL_NAME: 'Alex',
};

const originalEnv = { ...process.env };

// Every var config/index.ts's Zod schema knows about — cleared unconditionally
// before each test so a real value the developer happens to have exported in
// their shell (e.g. a personal GEMINI_API_KEY) can never leak in and mask a
// validation failure this test is specifically trying to trigger.
const ALL_CONFIG_KEYS = [
  'NODE_ENV', 'PORT', 'LOG_LEVEL', 'PUBLIC_HOSTNAME', 'DATABASE_URL',
  'VOICE_AI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_REALTIME_MODEL', 'OPENAI_NOISE_REDUCTION', 'OPENAI_LIVE_MODEL', 'OPENAI_LIVE_BACKEND_MODEL',
  'GEMINI_API_KEY', 'GEMINI_LIVE_MODEL', 'ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'TWILIO_WEBHOOK_VALIDATION_ENABLED',
  'CALENDAR_PROVIDER', 'CONTACTS_PROVIDER', 'DAV_USERNAME', 'DAV_PASSWORD', 'DAV_OWNER_EMAIL', 'CALDAV_CALENDAR_URL', 'CARDDAV_ADDRESSBOOK_URL',
  'GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS', 'CONTACTS_SYNC_INTERVAL_HOURS',
  'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID',
  'NOTIFICATION_CHANNEL', 'NOTIFY_TO_PHONE_NUMBER', 'NOTIFY_FROM_PHONE_NUMBER', 'PUSHOVER_APP_TOKEN', 'PUSHOVER_USER_KEY', 'PUSHOVER_DEVICE',
  'TASK_WEBHOOK_URL', 'TASK_WEBHOOK_SECRET', 'TASK_WEBHOOK_TOKEN', 'OUTCOME_SUMMARY_VIA',
  'MCP_API_KEY', 'MCP_AGENT_API_KEY', 'TOOL_TIMEOUT_MS', 'LOG_TRANSCRIPTS',
  'INBOUND_BOOKING_ENABLED', 'BUSINESS_HOURS_DAYS', 'BUSINESS_HOURS_START', 'BUSINESS_HOURS_END',
  'INBOUND_DEFAULT_DURATION_MINUTES', 'INBOUND_MAX_LOOKAHEAD_DAYS', 'ASSISTANT_PRINCIPAL_NAME', 'DISCLOSURE_LINE', 'RECORD_CALLS', 'RECORDING_RETENTION_DAYS',
  'TRANSFER_ENABLED', 'TRANSFER_TO_PHONE_NUMBER', 'TRANSFER_FALLBACK_MESSAGE', 'TRANSFER_MODE', 'HOLD_MAX_MINUTES',
  'MAX_CALLS_PER_NUMBER_PER_DAY', 'CALL_CAP_BUSINESS_NUMBERS', 'CALL_CAP_BUSINESS_MAX',
  'ASK_OWNER_ENABLED', 'ASK_OWNER_TIMEOUT_SECONDS', 'TRANSCRIBE_TRANSFERS', 'PERSIST_TRANSCRIPTS',
  'SCREEN_CALLS', 'SCREEN_CALLS_MODEL',
];

function setEnv(overrides: Record<string, string | undefined>) {
  for (const key of ALL_CONFIG_KEYS) delete process.env[key];
  Object.assign(process.env, BASE_ENV, overrides);
  // Object.assign would set an undefined override to the string "undefined".
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete process.env[key];
}

describe('config: env schema', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('parses successfully with a complete, consistent env', async () => {
    setEnv({});
    const { config } = await import('../src/config/index.js');
    expect(config.VOICE_AI_PROVIDER).toBe('openai');
    expect(config.PORT).toBe(3000); // default applied
    expect(config.TOOL_TIMEOUT_MS).toBe(8000); // default applied
    expect(config.LOG_TRANSCRIPTS).toBe(false); // default applied — must default off, transcripts can carry PII
  });

  it('LOG_TRANSCRIPTS: "false" (a non-empty string) does not coerce to true', async () => {
    // Regression guard for the exact z.coerce.boolean() gotcha the config
    // module's LOG_TRANSCRIPTS comment calls out: JS `Boolean("false")` is
    // `true`, which would silently defeat an operator's attempt to turn
    // logging off. The schema uses an explicit 'true'/'false' enum instead.
    setEnv({ LOG_TRANSCRIPTS: 'false' });
    const { config } = await import('../src/config/index.js');
    expect(config.LOG_TRANSCRIPTS).toBe(false);
  });

  it('LOG_TRANSCRIPTS: "true" opts in', async () => {
    setEnv({ LOG_TRANSCRIPTS: 'true' });
    const { config } = await import('../src/config/index.js');
    expect(config.LOG_TRANSCRIPTS).toBe(true);
  });

  it('fails fast when the selected voice AI provider is missing its API key', async () => {
    setEnv({ VOICE_AI_PROVIDER: 'gemini' /* no GEMINI_API_KEY */ });
    await expect(import('../src/config/index.js')).rejects.toThrow();
  });

  it('fails fast when VOICE_AI_PROVIDER=openai-live is missing OPENAI_API_KEY', async () => {
    setEnv({ VOICE_AI_PROVIDER: 'openai-live', OPENAI_API_KEY: '' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/OPENAI_API_KEY is required when VOICE_AI_PROVIDER=openai-live/);
  });

  it('accepts VOICE_AI_PROVIDER=openai-live with an API key, applying the GPT-Live model defaults', async () => {
    setEnv({ VOICE_AI_PROVIDER: 'openai-live' });
    const { config } = await import('../src/config/index.js');
    expect(config.VOICE_AI_PROVIDER).toBe('openai-live');
    expect(config.OPENAI_LIVE_MODEL).toBe('gpt-live-1');
    expect(config.OPENAI_LIVE_BACKEND_MODEL).toBe('gpt-5.6-terra');
  });

  // #143: noise and speakerphone echo were cutting off the opener as barge-ins.
  it('OPENAI_NOISE_REDUCTION defaults to far_field, and accepts near_field and off', async () => {
    setEnv({});
    expect((await import('../src/config/index.js')).config.OPENAI_NOISE_REDUCTION).toBe('far_field');
    for (const [value, expected] of [['near_field', 'near_field'], ['off', 'off']]) {
      vi.resetModules();
      setEnv({ OPENAI_NOISE_REDUCTION: value });
      expect((await import('../src/config/index.js')).config.OPENAI_NOISE_REDUCTION).toBe(expected);
    }
  });

  it('rejects an unknown OPENAI_NOISE_REDUCTION', async () => {
    setEnv({ OPENAI_NOISE_REDUCTION: 'loud' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/OPENAI_NOISE_REDUCTION/);
  });

  it('fails fast when Twilio credentials are missing — Twilio is the only telephony provider', async () => {
    setEnv({ TWILIO_ACCOUNT_SID: '' });
    await expect(import('../src/config/index.js')).rejects.toThrow();
  });

  it('treats empty optional settings as unset, as .env.example ships them', async () => {
    setEnv({
      NOTIFICATION_CHANNEL: 'pushover',
      PUSHOVER_APP_TOKEN: 'app-token',
      PUSHOVER_USER_KEY: 'user-key',
      PUSHOVER_DEVICE: '',
      NOTIFY_TO_PHONE_NUMBER: '',
      NOTIFY_FROM_PHONE_NUMBER: '',
    });
    const { config } = await import('../src/config/index.js');
    expect(config.NOTIFY_TO_PHONE_NUMBER).toBeUndefined();
    expect(config.NOTIFY_FROM_PHONE_NUMBER).toBeUndefined();
    expect(config.PUSHOVER_DEVICE).toBeUndefined();
  });

  it('still rejects a non-empty phone number that is not E.164', async () => {
    setEnv({ NOTIFY_TO_PHONE_NUMBER: '5551234567' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/E\.164/);
  });

  describe('CALL_CAP_BUSINESS_NUMBERS / CALL_CAP_BUSINESS_MAX (support lines with a higher daily cap)', () => {
    it('defaults to no business numbers and a business cap of 10', async () => {
      setEnv({});
      const { config } = await import('../src/config/index.js');
      expect(config.CALL_CAP_BUSINESS_NUMBERS).toEqual([]);
      expect(config.CALL_CAP_BUSINESS_MAX).toBe(10);
    });

    it('parses a comma-separated list of E.164 numbers, ignoring spaces and blanks', async () => {
      setEnv({ CALL_CAP_BUSINESS_NUMBERS: ' +18005550100, +18885550101 ,', CALL_CAP_BUSINESS_MAX: '8' });
      const { config } = await import('../src/config/index.js');
      expect(config.CALL_CAP_BUSINESS_NUMBERS).toEqual(['+18005550100', '+18885550101']);
      expect(config.CALL_CAP_BUSINESS_MAX).toBe(8);
    });

    it('rejects a number that is not E.164', async () => {
      setEnv({ CALL_CAP_BUSINESS_NUMBERS: '+18005550100,800-555-0101' });
      await expect(import('../src/config/index.js')).rejects.toThrow(/CALL_CAP_BUSINESS_NUMBERS/);
    });

    it('rejects a business cap below the normal cap, or above 20', async () => {
      setEnv({ MAX_CALLS_PER_NUMBER_PER_DAY: '5', CALL_CAP_BUSINESS_MAX: '4' });
      await expect(import('../src/config/index.js')).rejects.toThrow(/CALL_CAP_BUSINESS_MAX/);
      vi.resetModules();
      setEnv({ CALL_CAP_BUSINESS_MAX: '21' });
      await expect(import('../src/config/index.js')).rejects.toThrow();
    });
  });

  describe('ASK_OWNER_ENABLED (questions to the owner mid-call)', () => {
    it('is off by default, with a 120s wait', async () => {
      setEnv({});
      const { config } = await import('../src/config/index.js');
      expect(config.ASK_OWNER_ENABLED).toBe(false);
      expect(config.ASK_OWNER_TIMEOUT_SECONDS).toBe(120);
    });

    it('needs a notification channel and a public hostname, since the question is a link sent through it', async () => {
      setEnv({ ASK_OWNER_ENABLED: 'true' });
      await expect(import('../src/config/index.js')).rejects.toThrow(/ASK_OWNER_ENABLED/);
      vi.resetModules();
      setEnv({ ASK_OWNER_ENABLED: 'true', PUBLIC_HOSTNAME: 'banjo.example.com', NOTIFICATION_CHANNEL: 'pushover', PUSHOVER_APP_TOKEN: 'app-token', PUSHOVER_USER_KEY: 'user-key' });
      const { config } = await import('../src/config/index.js');
      expect(config.ASK_OWNER_ENABLED).toBe(true);
    });
  });

  describe('TRANSCRIBE_TRANSFERS (the part of a call after a transfer)', () => {
    it('is off by default', async () => {
      setEnv({});
      const { config } = await import('../src/config/index.js');
      expect(config.TRANSCRIBE_TRANSFERS).toBe(false);
    });

    it('needs PERSIST_TRANSCRIPTS, since the transcript is saved with the call', async () => {
      setEnv({ TRANSCRIBE_TRANSFERS: 'true' });
      await expect(import('../src/config/index.js')).rejects.toThrow(/TRANSCRIBE_TRANSFERS/);
      vi.resetModules();
      setEnv({ TRANSCRIBE_TRANSFERS: 'true', PERSIST_TRANSCRIPTS: 'true' });
      const { config } = await import('../src/config/index.js');
      expect(config.TRANSCRIBE_TRANSFERS).toBe(true);
    });
  });

  describe('SCREEN_CALLS (#150)', () => {
    it('is off by default', async () => {
      setEnv({});
      const { config } = await import('../src/config/index.js');
      expect(config.SCREEN_CALLS).toBe(false);
    });

    it('needs a way to reach the owner, since a held call waits for their approval', async () => {
      setEnv({ SCREEN_CALLS: 'true' });
      await expect(import('../src/config/index.js')).rejects.toThrow(/SCREEN_CALLS/);
      vi.resetModules();
      setEnv({ SCREEN_CALLS: 'true', NOTIFICATION_CHANNEL: 'pushover', PUSHOVER_APP_TOKEN: 't', PUSHOVER_USER_KEY: 'u', PUBLIC_HOSTNAME: 'banjo.example.com', OPENAI_API_KEY: undefined, VOICE_AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'g' });
      await expect(import('../src/config/index.js')).rejects.toThrow(/SCREEN_CALLS needs OPENAI_API_KEY/);
      vi.resetModules();
      setEnv({ SCREEN_CALLS: 'true', NOTIFICATION_CHANNEL: 'pushover', PUSHOVER_APP_TOKEN: 't', PUSHOVER_USER_KEY: 'u', PUBLIC_HOSTNAME: 'banjo.example.com' });
      const { config } = await import('../src/config/index.js');
      expect(config.SCREEN_CALLS).toBe(true);
      expect(config.SCREEN_CALLS_MODEL).toBe('gpt-5.6-terra');
    });
  });

  it('an empty value does not satisfy a setting the chosen channel requires', async () => {
    setEnv({ NOTIFICATION_CHANNEL: 'pushover', PUSHOVER_APP_TOKEN: 'app-token', PUSHOVER_USER_KEY: '' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/PUSHOVER_USER_KEY/);
  });

  it('fails fast when NOTIFICATION_CHANNEL=pushover is missing its user key', async () => {
    setEnv({ NOTIFICATION_CHANNEL: 'pushover', PUSHOVER_APP_TOKEN: 'app-token' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/PUSHOVER_USER_KEY/);
  });

  it('accepts NOTIFICATION_CHANNEL=pushover with a token and user key, and no SMS numbers', async () => {
    setEnv({ NOTIFICATION_CHANNEL: 'pushover', PUSHOVER_APP_TOKEN: 'app-token', PUSHOVER_USER_KEY: 'user-key' });
    const { config } = await import('../src/config/index.js');
    expect(config.NOTIFICATION_CHANNEL).toBe('pushover');
  });

  it('TASK_WEBHOOK_URL is optional, and an empty value means off', async () => {
    setEnv({ TASK_WEBHOOK_URL: '' });
    const { config } = await import('../src/config/index.js');
    expect(config.TASK_WEBHOOK_URL).toBeUndefined();
  });

  it('TASK_WEBHOOK_URL needs TASK_WEBHOOK_SECRET', async () => {
    setEnv({ TASK_WEBHOOK_URL: 'https://agent.example.test/hook' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/TASK_WEBHOOK_SECRET is required/);
  });

  it('TASK_WEBHOOK_SECRET must be at least 32 characters', async () => {
    setEnv({ TASK_WEBHOOK_URL: 'https://agent.example.test/hook', TASK_WEBHOOK_SECRET: 'short' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/at least 32/);
  });

  it('TASK_WEBHOOK_URL must be https, except to localhost or a Docker service name', async () => {
    const secret = 'x'.repeat(32);
    for (const refused of ['http://agent.example.test/hook', 'http://10.0.0.5:8644/hook', 'http://[fd00::1]:8644/hook']) {
      vi.resetModules();
      setEnv({ TASK_WEBHOOK_URL: refused, TASK_WEBHOOK_SECRET: secret });
      await expect(import('../src/config/index.js')).rejects.toThrow(/must use https/);
    }

    for (const allowed of ['http://127.0.0.1:9000/hook', 'http://hermes:8644/webhooks/banjo']) {
      vi.resetModules();
      setEnv({ TASK_WEBHOOK_URL: allowed, TASK_WEBHOOK_SECRET: secret });
      const { config } = await import('../src/config/index.js');
      expect(config.TASK_WEBHOOK_URL).toBe(allowed);
    }
  });

  it('OUTCOME_SUMMARY_VIA defaults to notification', async () => {
    setEnv({});
    const { config } = await import('../src/config/index.js');
    expect(config.OUTCOME_SUMMARY_VIA).toBe('notification');
  });

  it('OUTCOME_SUMMARY_VIA=webhook needs TASK_WEBHOOK_URL', async () => {
    setEnv({ OUTCOME_SUMMARY_VIA: 'webhook' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/TASK_WEBHOOK_URL is required when OUTCOME_SUMMARY_VIA=webhook/);

    vi.resetModules();
    setEnv({ OUTCOME_SUMMARY_VIA: 'webhook', TASK_WEBHOOK_URL: 'http://hermes:8644/webhooks/banjo', TASK_WEBHOOK_SECRET: 'x'.repeat(32) });
    const { config } = await import('../src/config/index.js');
    expect(config.OUTCOME_SUMMARY_VIA).toBe('webhook');
  });

  it('defaults CALENDAR_PROVIDER to google, with no CalDAV vars required', async () => {
    setEnv({});
    const { config } = await import('../src/config/index.js');
    expect(config.CALENDAR_PROVIDER).toBe('google');
  });

  it('fails fast when CALENDAR_PROVIDER=caldav is missing its credentials', async () => {
    setEnv({
      CALENDAR_PROVIDER: 'caldav',
      CALDAV_CALENDAR_URL: 'https://caldav.example.com/dav/calendars/user/me/work/',
      DAV_USERNAME: 'me@example.com',
    });
    await expect(import('../src/config/index.js')).rejects.toThrow(/DAV_PASSWORD/);
  });

  it('accepts CALENDAR_PROVIDER=caldav with a calendar URL, username, and password', async () => {
    setEnv({
      CALENDAR_PROVIDER: 'caldav',
      CALDAV_CALENDAR_URL: 'https://caldav.example.com/dav/calendars/user/me/work/',
      DAV_USERNAME: 'me@example.com',
      DAV_PASSWORD: 'app-password',
    });
    const { config } = await import('../src/config/index.js');
    expect(config.CALENDAR_PROVIDER).toBe('caldav');
  });

  it('refuses a plain-http DAV URL, which would send the app password in the clear', async () => {
    setEnv({ CALDAV_CALENDAR_URL: 'http://caldav.example.com/dav/calendars/user/me/work/' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/CALDAV_CALENDAR_URL.*https/s);
  });

  it('allows plain http to localhost, e.g. a Radicale server for development', async () => {
    setEnv({
      CARDDAV_ADDRESSBOOK_URL: 'http://localhost:5232/me/contacts/',
      CALDAV_CALENDAR_URL: 'http://127.0.0.1:5232/me/calendar/',
    });
    const { config } = await import('../src/config/index.js');
    expect(config.CARDDAV_ADDRESSBOOK_URL).toBe('http://localhost:5232/me/contacts/');
  });

  it('accepts DAV_OWNER_EMAIL as a comma-separated list of addresses, and rejects anything else', async () => {
    setEnv({ DAV_OWNER_EMAIL: 'me@example.com, Me@Other.example , mailto:alias@example.org' });
    const { config } = await import('../src/config/index.js');
    expect(config.DAV_OWNER_EMAIL).toBe('me@example.com, Me@Other.example , mailto:alias@example.org');

    vi.resetModules();
    setEnv({ DAV_OWNER_EMAIL: 'me@example.com, not-an-address' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/DAV_OWNER_EMAIL/);
  });

  it('fails fast when CONTACTS_PROVIDER=carddav has no address book URL', async () => {
    setEnv({ CONTACTS_PROVIDER: 'carddav', DAV_USERNAME: 'me@example.com', DAV_PASSWORD: 'app-password' });
    await expect(import('../src/config/index.js')).rejects.toThrow(/CARDDAV_ADDRESSBOOK_URL/);
  });

  it('accepts CONTACTS_PROVIDER=carddav with an address book URL and the shared DAV sign-in', async () => {
    setEnv({
      CONTACTS_PROVIDER: 'carddav',
      CARDDAV_ADDRESSBOOK_URL: 'https://carddav.example.com/dav/addressbooks/user/me/Default/',
      DAV_USERNAME: 'me@example.com',
      DAV_PASSWORD: 'app-password',
    });
    const { config } = await import('../src/config/index.js');
    expect(config.CONTACTS_PROVIDER).toBe('carddav');
  });

  it('CONTACTS_SYNC_INTERVAL_HOURS wins over the older GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS, which still works alone', async () => {
    setEnv({ GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS: '12' });
    let mod = await import('../src/config/index.js');
    expect(mod.contactsSyncIntervalHours()).toBe(12);

    vi.resetModules();
    setEnv({ GOOGLE_CONTACTS_SYNC_INTERVAL_HOURS: '12', CONTACTS_SYNC_INTERVAL_HOURS: '1' });
    mod = await import('../src/config/index.js');
    expect(mod.contactsSyncIntervalHours()).toBe(1);
  });

  it('fails fast when NOTIFICATION_CHANNEL=twilio_sms without notify phone numbers', async () => {
    setEnv({ NOTIFICATION_CHANNEL: 'twilio_sms' });
    await expect(import('../src/config/index.js')).rejects.toThrow();
  });

  it('requires MCP_API_KEY to be non-empty', async () => {
    setEnv({ MCP_API_KEY: '' });
    await expect(import('../src/config/index.js')).rejects.toThrow();
  });

  it('rejects an MCP_API_KEY shorter than 32 characters — the endpoint is internet-reachable, so a short key is brute-forceable', async () => {
    setEnv({ MCP_API_KEY: 'short-key' });
    await expect(import('../src/config/index.js')).rejects.toThrow();
  });

  it('requires ASSISTANT_PRINCIPAL_NAME to be non-empty', async () => {
    setEnv({ ASSISTANT_PRINCIPAL_NAME: '' });
    await expect(import('../src/config/index.js')).rejects.toThrow();
  });

  it('applies inbound-booking defaults when unset', async () => {
    setEnv({});
    const { config } = await import('../src/config/index.js');
    expect(config.INBOUND_BOOKING_ENABLED).toBe(false);
    expect(config.BUSINESS_HOURS_DAYS).toBe('1,2,3,4,5');
    expect(config.BUSINESS_HOURS_START).toBe(9);
    expect(config.BUSINESS_HOURS_END).toBe(17);
    expect(config.INBOUND_DEFAULT_DURATION_MINUTES).toBe(30);
    expect(config.INBOUND_MAX_LOOKAHEAD_DAYS).toBe(14);
  });

  it('applies TWILIO_WEBHOOK_VALIDATION_ENABLED default (on) when unset', async () => {
    setEnv({});
    const { config } = await import('../src/config/index.js');
    expect(config.TWILIO_WEBHOOK_VALIDATION_ENABLED).toBe(true);
  });

  it('TWILIO_WEBHOOK_VALIDATION_ENABLED: "false" (a non-empty string) does not coerce to true', async () => {
    setEnv({ TWILIO_WEBHOOK_VALIDATION_ENABLED: 'false' });
    const { config } = await import('../src/config/index.js');
    expect(config.TWILIO_WEBHOOK_VALIDATION_ENABLED).toBe(false);
  });

  it('rejects BUSINESS_HOURS_START at or after BUSINESS_HOURS_END', async () => {
    setEnv({ BUSINESS_HOURS_START: '17', BUSINESS_HOURS_END: '9' });
    await expect(import('../src/config/index.js')).rejects.toThrow();
  });

  it('rejects a malformed BUSINESS_HOURS_DAYS value', async () => {
    setEnv({ BUSINESS_HOURS_DAYS: '7' }); // 7 is out of the valid 0-6 range
    await expect(import('../src/config/index.js')).rejects.toThrow();
  });

  describe('DISCLOSURE_LINE (#8)', () => {
    it('defaults to a line that says it is an AI and names the principal', async () => {
      setEnv({});
      const { config, disclosureLine } = await import('../src/config/index.js');
      expect(config.DISCLOSURE_LINE).toMatch(/\bAI\b/);
      expect(disclosureLine()).toContain(config.ASSISTANT_PRINCIPAL_NAME);
      expect(disclosureLine()).not.toContain('{name}');
    });

    it('accepts custom wording that says AI', async () => {
      setEnv({ DISCLOSURE_LINE: "Hello! Quick heads-up: I'm {name}'s AI assistant." });
      const { disclosureLine } = await import('../src/config/index.js');
      expect(disclosureLine()).toBe(`Hello! Quick heads-up: I'm ${BASE_ENV.ASSISTANT_PRINCIPAL_NAME}'s AI assistant.`);
    });

    it('refuses to start with wording that does not say AI', async () => {
      setEnv({ DISCLOSURE_LINE: "Hi, I'm calling on behalf of {name}." });
      await expect(import('../src/config/index.js')).rejects.toThrow(/DISCLOSURE_LINE/);
    });
  });

  describe('RECORD_CALLS (#8)', () => {
    it('is off by default, with a 30-day retention window', async () => {
      setEnv({});
      const { config } = await import('../src/config/index.js');
      expect(config.RECORD_CALLS).toBe(false);
      expect(config.RECORDING_RETENTION_DAYS).toBe(30);
    });

    it('with recording on, the opening line carries the recording notice — added if the wording lacks one', async () => {
      setEnv({ RECORD_CALLS: 'true' });
      const { disclosureLine } = await import('../src/config/index.js');
      expect(disclosureLine()).toMatch(/AI assistant.*This call is recorded\.$/);
    });

    it('does not add a second notice when the wording already mentions recording', async () => {
      setEnv({ RECORD_CALLS: 'true', DISCLOSURE_LINE: "Hi, I'm {name}'s AI assistant; this call is being recorded." });
      const { disclosureLine } = await import('../src/config/index.js');
      expect(disclosureLine().match(/record/gi)).toHaveLength(1);
    });

    it('with recording off, no notice is added', async () => {
      setEnv({});
      const { disclosureLine } = await import('../src/config/index.js');
      expect(disclosureLine()).not.toMatch(/record/i);
    });
  });

  describe('call transfer (#7)', () => {
    it('is off by default and needs no number', async () => {
      setEnv({});
      const { config } = await import('../src/config/index.js');
      expect(config.TRANSFER_ENABLED).toBe(false);
      expect(config.TRANSFER_FALLBACK_MESSAGE).toMatch(/couldn't be reached/);
      expect(config.TRANSFER_MODE).toBe('cold');
    });

    it('waits up to 20 minutes on hold by default, and refuses more than 45 (#151)', async () => {
      setEnv({});
      expect((await import('../src/config/index.js')).config.HOLD_MAX_MINUTES).toBe(20);
      vi.resetModules();
      setEnv({ HOLD_MAX_MINUTES: '46' });
      await expect(import('../src/config/index.js')).rejects.toThrow(/HOLD_MAX_MINUTES/);
    });

    it('takes TRANSFER_MODE warm, and refuses anything but cold or warm (#149)', async () => {
      setEnv({ TRANSFER_MODE: 'warm' });
      expect((await import('../src/config/index.js')).config.TRANSFER_MODE).toBe('warm');
      vi.resetModules();
      setEnv({ TRANSFER_MODE: 'lukewarm' });
      await expect(import('../src/config/index.js')).rejects.toThrow(/TRANSFER_MODE/);
    });

    it('requires TRANSFER_TO_PHONE_NUMBER when enabled', async () => {
      setEnv({ TRANSFER_ENABLED: 'true' });
      await expect(import('../src/config/index.js')).rejects.toThrow(/TRANSFER_TO_PHONE_NUMBER/);
    });

    it('accepts an E.164 number when enabled, and rejects one without its +', async () => {
      setEnv({ TRANSFER_ENABLED: 'true', TRANSFER_TO_PHONE_NUMBER: '+15557654321' });
      const { config } = await import('../src/config/index.js');
      expect(config.TRANSFER_ENABLED).toBe(true);
      expect(config.TRANSFER_TO_PHONE_NUMBER).toBe('+15557654321');

      vi.resetModules();
      setEnv({ TRANSFER_ENABLED: 'true', TRANSFER_TO_PHONE_NUMBER: '15557654321' });
      await expect(import('../src/config/index.js')).rejects.toThrow();
    });
  });
});

describe('config: MCP_AGENT_API_KEY', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const AGENT_KEY = 'agent-key-for-tests-only-0123456789';
  const PUSHOVER = {
    NOTIFICATION_CHANNEL: 'pushover',
    PUSHOVER_APP_TOKEN: 'a'.repeat(30),
    PUSHOVER_USER_KEY: 'u'.repeat(30),
    PUBLIC_HOSTNAME: 'banjo.example.com',
  };

  it('is optional', async () => {
    setEnv({});
    const { config } = await import('../src/config/index.js');
    expect(config.MCP_AGENT_API_KEY).toBeUndefined();
  });

  it('accepts a separate key with a hostname and a notification channel', async () => {
    setEnv({ ...PUSHOVER, MCP_AGENT_API_KEY: AGENT_KEY });
    const { config } = await import('../src/config/index.js');
    expect(config.MCP_AGENT_API_KEY).toBe(AGENT_KEY);
  });

  it.each([
    ['shorter than 32 characters', { ...PUSHOVER, MCP_AGENT_API_KEY: 'short' }, /at least 32/],
    ['the same as MCP_API_KEY', { ...PUSHOVER, MCP_AGENT_API_KEY: BASE_ENV.MCP_API_KEY }, /differ/],
    ['set without PUBLIC_HOSTNAME', { ...PUSHOVER, PUBLIC_HOSTNAME: undefined, MCP_AGENT_API_KEY: AGENT_KEY }, /PUBLIC_HOSTNAME/],
    ['set with NOTIFICATION_CHANNEL=none', { PUBLIC_HOSTNAME: 'banjo.example.com', MCP_AGENT_API_KEY: AGENT_KEY }, /NOTIFICATION_CHANNEL/],
  ])('refuses a key %s', async (_label, env, message) => {
    setEnv(env as Record<string, string | undefined>);
    await expect(import('../src/config/index.js')).rejects.toThrow(message);
  });
});
