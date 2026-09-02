// Barrel file: single entrypoint for drizzle-kit and the db client.
// Each domain module owns its own table definitions; this file just re-exports
// them so migrations/introspection see the whole schema from one place.
export * from '../contacts/schema.js';
export * from '../tasks/schema.js';
export * from '../inbound/schema.js';
