import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The DB-backed suites (tests/contacts/service.test.ts,
    // tests/googleContacts/{reconcile,lookup,sync}.test.ts,
    // tests/inbound/callerContext.test.ts) all point at the SAME dedicated
    // test database (DATABASE_URL below) and truncate the same shared tables
    // (`contacts` above all) in beforeEach. Run in parallel worker processes, one file's
    // truncation deletes rows another file's test just inserted, producing
    // failures ("Contact not found: <uuid>", a just-created contact suddenly
    // not matching) that move around between runs and have nothing to do with
    // the code under test. Serializing files is the fix — these suites are
    // integration tests against one shared database, so they cannot be
    // isolated by process. Costs a few seconds of wall clock; buys a suite
    // whose failures actually mean something.
    fileParallelism: false,
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
      // Dedicated test database, migrated separately from the real local dev
      // Postgres (`banjo` — see docker-compose.yml). The DB-backed suites
      // below used to hardcode DATABASE_URL to the real `banjo` db instead of
      // reading this value, which meant `npm test` was truncating shared dev
      // data on every run. See README's "Test database" setup step for how
      // to create and migrate `banjo_test`.
      DATABASE_URL: 'postgresql://banjo:banjo@localhost:5432/banjo_test',
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
      MCP_API_KEY: 'test-mcp-key-do-not-use-in-prod-1',
      ASSISTANT_PRINCIPAL_NAME: 'Alex',
    },
  },
});
