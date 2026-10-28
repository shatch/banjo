import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientOptions: Record<string, unknown>[] = [];
vi.mock('postgres', () => ({
  default: (_url: string, options: Record<string, unknown>) => {
    clientOptions.push(options);
    return { end: async () => {} };
  },
}));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: () => ({}) }));
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: async () => {} }));

const { runMigrations } = await import('../../src/db/migrate.js');
const { logger } = await import('../../src/lib/logger.js');

describe('runMigrations', () => {
  beforeEach(() => {
    clientOptions.length = 0;
  });

  // Postgres's "already exists, skipping" notices otherwise go straight to the
  // console on every boot and every sim run, ahead of anything else.
  it("logs Postgres notices at debug instead of printing them", async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined as never);
    await runMigrations();
    const onnotice = clientOptions[0]?.onnotice as ((notice: { message: string }) => void) | undefined;
    expect(onnotice).toBeTypeOf('function');
    onnotice!({ message: 'schema "drizzle" already exists, skipping' });
    expect(debug).toHaveBeenCalledWith({ notice: 'schema "drizzle" already exists, skipping' }, 'postgres notice during migrations');
  });
});
