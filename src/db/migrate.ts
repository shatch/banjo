import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

// Resolved from this module's own URL rather than process.cwd(), because the
// process is started from different directories depending on how you run it
// (`npm run dev` from the repo root, `node dist/index.js` from /app in the
// container, `npm run test:call` from wherever). Both layouts put the folder
// two levels up: src/db/migrate.ts -> repo root, dist/db/migrate.js -> /app.
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Applies any unapplied migrations from the committed `drizzle/` folder.
 *
 * Uses its own single connection rather than the pooled client in `./index.js`
 * — drizzle's postgres-js migrator runs its statements on one connection and
 * expects to own it, and we want the connection gone once migrations are done
 * instead of sitting idle in the app's pool for the life of the process.
 */
export async function runMigrations(): Promise<void> {
  // Without onnotice, postgres-js prints each notice ("already exists, skipping")
  // to the console on every boot.
  const migrationClient = postgres(config.DATABASE_URL, {
    max: 1,
    onnotice: (notice) => logger.debug({ notice: notice.message }, 'postgres notice during migrations'),
  });
  try {
    logger.info({ migrationsFolder }, 'applying database migrations');
    await migrate(drizzle(migrationClient), { migrationsFolder });
    logger.info('database migrations up to date');
  } finally {
    await migrationClient.end({ timeout: 5 });
  }
}
