import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  // Points at compiled output, not src/db/schema.ts, because drizzle-kit's
  // own TS loader (as of drizzle-kit 0.28.x) fails to resolve the .js-suffixed
  // relative imports our source uses for correct Node ESM runtime resolution
  // (see https://github.com/drizzle-team/drizzle-orm/issues/2705 /
  // https://github.com/drizzle-team/drizzle-orm/issues/1561 — a known,
  // still-open drizzle-kit limitation, not specific to this project). `npm
  // run build` must be run first — the db:generate/db:migrate scripts do
  // this automatically via their `pre*` hooks below.
  schema: './dist/db/schema.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://banjo:banjo@localhost:5432/banjo',
  },
  strict: true,
  verbose: true,
});
