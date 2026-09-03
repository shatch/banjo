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
  'VOICE_AI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_REALTIME_MODEL',
  'GEMINI_API_KEY', 'GEMINI_LIVE_MODEL', 'ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'TWILIO_WEBHOOK_VALIDATION_ENABLED',
  'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID',
  'NOTIFICATION_CHANNEL', 'NOTIFY_TO_PHONE_NUMBER', 'NOTIFY_FROM_PHONE_NUMBER',
  'MCP_API_KEY', 'TOOL_TIMEOUT_MS', 'LOG_TRANSCRIPTS',
  'INBOUND_BOOKING_ENABLED', 'BUSINESS_HOURS_DAYS', 'BUSINESS_HOURS_START', 'BUSINESS_HOURS_END',
  'INBOUND_DEFAULT_DURATION_MINUTES', 'INBOUND_MAX_LOOKAHEAD_DAYS', 'ASSISTANT_PRINCIPAL_NAME',
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

  it('fails fast when Twilio credentials are missing — Twilio is the only telephony provider', async () => {
    setEnv({ TWILIO_ACCOUNT_SID: '' });
    await expect(import('../src/config/index.js')).rejects.toThrow();
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
});
