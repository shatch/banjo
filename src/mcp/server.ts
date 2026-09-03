import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context, Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

import { placeCallInputSchema, placeCallHandler } from './tools/placeCall.js';
import { getTaskStatusInputSchema, getTaskStatusHandler } from './tools/getTaskStatus.js';
import { findContactInputSchema, findContactHandler } from './tools/findContact.js';
import { listContactsInputSchema, listContactsHandler } from './tools/listContacts.js';
import { addContactInputSchema, addContactHandler } from './tools/addContact.js';
import { updateContactInputSchema, updateContactHandler } from './tools/updateContact.js';
import { recordTaskOutcomeInputSchema, recordTaskOutcomeHandler } from './tools/recordTaskOutcome.js';
import { listRecentTasksInputSchema, listRecentTasksHandler } from './tools/listRecentTasks.js';

const MCP_SSE_PATH = '/mcp/sse';
const MCP_MESSAGES_PATH = '/mcp/messages';

/**
 * Uniform MCP tool result shape.
 * NEEDS VERIFICATION: assumed CallToolResult shape (`{ content: [{ type:
 * 'text', text }], isError? }`) matches @modelcontextprotocol/sdk ^1.9.0 —
 * this has been stable across the 1.x line's documented examples, but worth
 * double-checking against dist/**\/types.d.ts once installed.
 */
function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

/**
 * Wraps a thin (input) => Promise<result> tool handler with uniform
 * result/error formatting for McpServer#tool() registration, and logs
 * failures instead of letting them crash the SSE connection.
 *
 * NEEDS VERIFICATION: McpServer's ToolCallback type is
 * `(args, extra) => CallToolResult | Promise<CallToolResult>` — we only
 * consume `args` here. TS structurally allows assigning a function that
 * ignores trailing parameters, so this should satisfy `.tool()`'s overload
 * that takes `(name, description, zodRawShape, callback)`.
 */
function adapt<TInput>(handler: (input: TInput) => Promise<unknown>) {
  return async (input: TInput) => {
    try {
      const result = await handler(input);
      return toolResult(result);
    } catch (err) {
      logger.error({ err }, 'mcp tool handler failed');
      return toolError(err);
    }
  };
}

/**
 * Builds the MCP server and registers all 8 tools. Deliberately separate
 * from the HTTP/SSE wiring below so it can be constructed and exercised
 * (e.g. via an in-memory transport) without spinning up Hono.
 *
 * NEEDS VERIFICATION: `McpServer` from
 * '@modelcontextprotocol/sdk/server/mcp.js' is the SDK's high-level
 * registration API as of ^1.9.0 — constructor takes `{ name, version }`,
 * and `.tool(name, description, zodRawShape, handler)` is one of its
 * documented overloads (others: name+cb, name+description+cb,
 * name+shape+cb). Confirm the exact overload set against
 * dist/**\/server/mcp.d.ts once `npm install` has run.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'ea-executive-assistant',
    version: '0.1.0',
  });

  server.tool(
    'place_call',
    'Place an outbound phone call to a contact to accomplish a task (e.g. book an appointment). ' +
      'Returns immediately with a taskId — the call itself runs asynchronously over the following ' +
      'minutes. Poll get_task_status with the returned taskId to learn the outcome.',
    placeCallInputSchema.shape,
    adapt(placeCallHandler),
  );

  server.tool(
    'get_task_status',
    'Check the current status and (if finished) outcome of a previously started task, whether it was ' +
      'a phone call or a recorded online booking.',
    getTaskStatusInputSchema.shape,
    adapt(getTaskStatusHandler),
  );

  server.tool(
    'find_contact',
    'Fuzzy-search saved contacts by name or notes text. Call this before place_call to resolve a ' +
      'contactId, or to check whether a contact already exists before add_contact.',
    findContactInputSchema.shape,
    adapt(findContactHandler),
  );

  server.tool(
    'list_contacts',
    'List saved contacts, optionally filtered by category.',
    listContactsInputSchema.shape,
    adapt(listContactsHandler),
  );

  server.tool(
    'add_contact',
    'Save a new contact (business or person) for future calls/bookings.',
    addContactInputSchema.shape,
    adapt(addContactHandler),
  );

  server.tool(
    'update_contact',
    "Update an existing contact — e.g. record the assistant's owner's stated preferred booking channel so future " +
      'tasks for this contact skip asking again, or update notes/booking URL.',
    updateContactInputSchema.shape,
    adapt(updateContactHandler),
  );

  server.tool(
    'record_task_outcome',
    'Log the outcome of a task that was completed OUTSIDE the phone-call path (typically an online ' +
      'booking the skill completed itself via browser automation), so it appears in the same task ' +
      'history as phone-call tasks.',
    recordTaskOutcomeInputSchema.shape,
    adapt(recordTaskOutcomeHandler),
  );

  server.tool(
    'list_recent_tasks',
    'List the most recently updated tasks (phone calls and online bookings), most recent first.',
    listRecentTasksInputSchema.shape,
    adapt(listRecentTasksHandler),
  );

  return server;
}

/**
 * @hono/node-server's actual mechanism for "I already wrote the raw Node
 * response myself, don't also serialize a Fetch Response over it" is the
 * `x-hono-already-sent` response header (checked in its listener — there is
 * no separate `RESPONSE_ALREADY_SENT` export in the installed version).
 */
function alreadySentResponse(): Response {
  return new Response(null, { headers: { 'x-hono-already-sent': 'true' } });
}

function requireAuth(c: Context): boolean {
  const authHeader = c.req.header('Authorization') ?? '';
  const expected = `Bearer ${config.MCP_API_KEY}`;
  const provided = Buffer.from(authHeader);
  const wanted = Buffer.from(expected);
  // Length must match before timingSafeEqual (it throws on a length mismatch),
  // but comparing full buffer contents in constant time — rather than the
  // plain `===` this replaces — prevents a remote attacker from inferring
  // the key character-by-character via response-time differences.
  if (provided.length !== wanted.length) return false;
  return timingSafeEqual(provided, wanted);
}

/**
 * Pulls the raw Node req/res out of a Hono context. Only populated when the
 * app is served via @hono/node-server's `serve()` (as opposed to, say, a
 * Cloudflare Workers or Deno runtime) — this MCP endpoint requires that,
 * since SSEServerTransport is built directly on Node's http.ServerResponse.
 *
 * NEEDS VERIFICATION: `c.env.incoming` / `c.env.outgoing` as the documented
 * escape hatch to raw Node APIs under @hono/node-server. True as of the
 * 1.13.x docs' "Access raw Node.js APIs" section; reconfirm against the
 * installed version.
 */
function getRawNodeReqRes(c: Context): { req: IncomingMessage; res: ServerResponse } | undefined {
  const env = c.env as { incoming?: IncomingMessage; outgoing?: ServerResponse } | undefined;
  if (!env?.incoming || !env?.outgoing) return undefined;
  return { req: env.incoming, res: env.outgoing };
}

/**
 * Registers the MCP HTTP/SSE routes on the given Hono app. This runs as a
 * persistent, internet-reachable AWS-deployed service (not spawned locally
 * via stdio), so we expose MCP over remote HTTP/SSE per the SDK's
 * SSEServerTransport: a long-lived GET stream per client session, with
 * individual JSON-RPC messages POSTed to a companion endpoint carrying
 * `?sessionId=<id>`.
 *
 * Every route under /mcp requires `Authorization: Bearer <MCP_API_KEY>` —
 * this is a hard security requirement since the endpoint is internet-facing.
 *
 * NEEDS VERIFICATION (SDK surface, @modelcontextprotocol/sdk ^1.9.0):
 *  - `new SSEServerTransport(postEndpointPath, res)` constructor signature.
 *  - `transport.sessionId` as the correlation id the client echoes back via `?sessionId=`.
 *  - `transport.handlePostMessage(req, res, parsedBody?)` as the POST entrypoint.
 *  - `McpServer#connect(transport)` internally calling `transport.start()`, which writes
 *    the SSE response headers and the initial `endpoint` event.
 *  These match the SDK's documented Express example for the 1.x line; confirm against
 *  node_modules/@modelcontextprotocol/sdk/dist/**\/server/sse.d.ts once installed.
 */
export function registerMcpRoutes(app: Hono): void {
  const server = createMcpServer();
  const transports = new Map<string, SSEServerTransport>();

  app.get(MCP_SSE_PATH, async (c) => {
    if (!requireAuth(c)) {
      return c.text('Unauthorized', 401);
    }

    const raw = getRawNodeReqRes(c);
    if (!raw) {
      logger.error(
        'MCP SSE route requires raw Node req/res (c.env.incoming/outgoing) — is this app served via @hono/node-server?',
      );
      return c.text('Internal Server Error', 500);
    }

    const transport = new SSEServerTransport(MCP_MESSAGES_PATH, raw.res);
    transports.set(transport.sessionId, transport);

    raw.res.on('close', () => {
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);

    // We already wrote the SSE response directly to the raw ServerResponse
    // above (via transport/server.connect). Tell @hono/node-server not to
    // also attempt to serialize a Fetch Response over the same connection.
    return alreadySentResponse();
  });

  app.post(MCP_MESSAGES_PATH, async (c) => {
    if (!requireAuth(c)) {
      return c.text('Unauthorized', 401);
    }

    const sessionId = c.req.query('sessionId');
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      return c.text('No transport found for sessionId', 400);
    }

    const raw = getRawNodeReqRes(c);
    if (!raw) {
      logger.error(
        'MCP messages route requires raw Node req/res (c.env.incoming/outgoing) — is this app served via @hono/node-server?',
      );
      return c.text('Internal Server Error', 500);
    }

    await transport.handlePostMessage(raw.req, raw.res);

    return alreadySentResponse();
  });
}
