import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Most modules transitively import src/config, which validates its env
    // schema at import time. These give every test file a consistent, valid
    // baseline env (no real credentials — nothing here talks to a live
    // vendor) so unit tests can import provider/tool modules without each
    // one needing to stub the whole config surface. tests/config.test.ts
    // overrides individual vars per-case to exercise the validation itself.
    env: {
      // src/config/index.ts does `import 'dotenv/config'`, which re-reads a
      // real local .env on every module load — including every dynamic
      // re-import tests/config.test.ts does via vi.resetModules(). Pointing
      // it at a nonexistent path stops it from ever backfilling deleted/
      // unset vars from your real .env during tests (dotenv no-ops
      // silently when the file doesn't exist).
      DOTENV_CONFIG_PATH: '/dev/null',
      DATABASE_URL: 'postgresql://ea:ea@localhost:5432/ea_test',
      VOICE_AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
      TELEPHONY_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'authtest',
      TWILIO_PHONE_NUMBER: '+15551234567',
      NOTIFICATION_CHANNEL: 'none',
      // Present (not just omitted) so dotenv's `import 'dotenv/config'` in
      // src/config/index.ts can't backfill these from a real local .env —
      // dotenv only fills in keys not already set, so anything pinned here
      // always wins. Missing this once already let a real .env's
      // non-E.164-formatted value leak into and fail this suite.
      NOTIFY_TO_PHONE_NUMBER: '+15557654321',
      NOTIFY_FROM_PHONE_NUMBER: '+15551234567',
      MCP_API_KEY: 'test-mcp-key',
      ASSISTANT_PRINCIPAL_NAME: 'Alex',
    },
  },
});
