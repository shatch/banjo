// Config is imported first (and fails fast on parse) before anything else
// touches env vars — a bad deploy should be caught here, not discovered by
// Steve mid-call.
import { config } from './config/index.js';
import { runMigrations } from './db/migrate.js';
import { startCardDavContactsSyncPoller } from './carddavContacts/sync.js';
import { startGoogleContactsSyncPoller } from './googleContacts/sync.js';
import { logger } from './lib/logger.js';
import { startServer } from './server.js';
import { startOrchestrationPoller } from './tasks/orchestrator.js';
import { loadOwnerProfile } from './tasks/ownerProfile.js';
import { startRecordingRetentionSweeper } from './recordings/retention.js';
import { startTranscriptRetentionSweeper } from './transcripts/service.js';

logger.info({ nodeEnv: config.NODE_ENV, voiceAiProvider: config.VOICE_AI_PROVIDER }, 'Starting ea');

// PUBLIC_HOSTNAME is optional in the schema (tests and schema-only tooling
// don't need it), but nothing involving a real call works without it: every
// Twilio webhook URL and both Media Stream wss:// URLs interpolate it, and
// src/server.ts reconstructs it to validate Twilio's request signature. Unset,
// the process boots happily and then hands Twilio `https://undefined/...`.
if (!config.PUBLIC_HOSTNAME) {
  logger.warn(
    'PUBLIC_HOSTNAME is not set — Twilio webhooks and media streams will point at "undefined" and every call will fail. See README Quickstart.',
  );
}

// A wrong path or an oversized profile stops the deploy here, rather than
// quietly dropping out of every call's prompt. Re-read per call after this, so
// edits apply without a restart.
if (config.PROMPT_PROFILE_FILE) {
  const profile = loadOwnerProfile(config.PROMPT_PROFILE_FILE);
  logger.info({ path: config.PROMPT_PROFILE_FILE, chars: profile.length }, 'owner profile loaded');
}

// Before the server accepts a webhook or the poller touches `tasks`: a missed
// migration otherwise surfaces as `column "..." does not exist` from inside the
// orchestration poller, long after startup looked successful.
if (config.RUN_MIGRATIONS_ON_BOOT) {
  await runMigrations();
}

startServer();
startOrchestrationPoller();
if (config.CONTACTS_PROVIDER === 'google') startGoogleContactsSyncPoller();
else if (config.CONTACTS_PROVIDER === 'carddav') startCardDavContactsSyncPoller();
startTranscriptRetentionSweeper();
startRecordingRetentionSweeper();
