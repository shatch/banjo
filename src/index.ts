// Config is imported first (and fails fast on parse) before anything else
// touches env vars — a bad deploy should be caught here, not discovered by
// Steve mid-call.
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { startServer } from './server.js';
import { startOrchestrationPoller } from './tasks/orchestrator.js';

logger.info({ nodeEnv: config.NODE_ENV, voiceAiProvider: config.VOICE_AI_PROVIDER }, 'Starting ea');

startServer();
startOrchestrationPoller();
