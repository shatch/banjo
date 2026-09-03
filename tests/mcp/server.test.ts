import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
import { registerMcpRoutes } from '../../src/mcp/server.js';

function buildApp(): Hono {
  const app = new Hono();
  registerMcpRoutes(app);
  return app;
}

describe('mcp server: requireAuth', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await buildApp().request('/mcp/messages', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong bearer token', async () => {
    const res = await buildApp().request('/mcp/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token that only differs by a trailing suffix — guards against a naive prefix/length-mismatch comparison', async () => {
    const res = await buildApp().request('/mcp/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.MCP_API_KEY}extra` },
    });
    expect(res.status).toBe(401);
  });

  it('accepts the correct bearer token and proceeds past auth (400 for missing sessionId, not 401)', async () => {
    const res = await buildApp().request('/mcp/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.MCP_API_KEY}` },
    });
    expect(res.status).toBe(400); // "No transport found for sessionId" — proves auth passed
  });
});
