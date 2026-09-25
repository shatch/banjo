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
  'VOICE_AI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_REALTIME_MODEL', 'OPENAI_LIVE_MODEL', 'OPENAI_LIVE_BACKEND_MODEL',
  'GEMINI_API_KEY', 'GEMINI_LIVE_MODEL', 'ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'TWILIO_WEBHOOK_VALIDATION_ENABLED',
  'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID',
  'NOTIFICATION_CHANNEL', 'NOTIFY_TO_PHONE_NUMBER', 'NOTIFY_FROM_PHONE_NUMBER', 'PUSHOVER_APP_TOKEN', 'PUSHOVER_USER_KEY', 'PUSHOVER_DEVICE',
  'MCP_API_KEY', 'TOOL_TIMEOUT_MS', 'LOG_TRANSCRIPTS',
  'INBOUND_BOOKING_ENABLED', 'BUSINESS_HOURS_DAYS', 'BUSINESS_HOURS_START', 'BUSINESS_HOURS_END',
  'INBOUND_DEFAULT_DURATION_MINUTES', 'INBOUND_MAX_LOOKAHEAD_DAYS', 'ASSISTANT_PRINCIPAL_NAME', 'DISCLOSURE_LINE', 'RECORD_CALLS', 'RECORDING_RETENTION_DAYS',
];

function setEnv(overrides: Record<string, string | undefined>) {
  for (const key of ALL_CONFIG_KEYS) delete process.env[key];
  Object.assign(process.env, BASE_ENV, overrides);
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
});
