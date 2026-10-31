import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import twilioLib from 'twilio';
import { createCalendarProvider } from './calendar/factory.js';
import { config } from './config/index.js';
import { buildInboundCallSessionOptions } from './inbound/callSessionAdapter.js';
import { resolveCallerContext } from './inbound/callerContext.js';
import { isFullyAttested, recentOutboundCalls } from './inbound/recentCalls.js';
import { createInboundCall } from './inbound/service.js';
import { buildInboundFrontendPrompt, buildInboundSystemPrompt } from './inbound/systemPrompt.js';
import { logger } from './lib/logger.js';
import { registerMcpRoutes } from './mcp/server.js';
import { healthRoutes } from './routes/health.js';
import { approvalRoutes, redactQuery } from './approvals/routes.js';
import { ownerQuestionRoutes } from './ownerQuestions/routes.js';
import { saveTransferLeg } from './transcripts/transferLeg.js';
import { CallSession } from './session/callSession.js';
import { createTelephonyProvider } from './telephony/factory.js';
import type { TransferResult } from './tasks/schema.js';
import { recordTransferResult } from './tasks/service.js';

/**
 * Twilio-specific hooks not part of the common TelephonyProvider interface
 * (TwiML/media-stream-WS wiring is Twilio's own shape). Accessed via a
 * narrow local cast rather than widening the shared interface with
 * vendor-specific members.
 */
interface TwilioHttpHooks {
  buildTwiml(callId: string): string;
  handleMediaStreamConnection(ws: WebSocket): void;
  handleAmdCallback(callId: string, answeredBy: string): void;
  handleStatusCallback(callId: string, callStatus: string): void;
  buildInboundTwiml(callSid: string): string;
  buildDeclineTwiml(): string;
  isAnyCallActive(): boolean;
  registerInboundCall(callSid: string, from: string): void;
  unregisterInboundCall(callSid: string): void;
  handleInboundMediaStreamConnection(ws: WebSocket): void;
  buildTransferCallbackTwiml(result: TransferResult): string;
  buildTransferScreenTwiml(callId: string): string;
  acceptTransferScreen(callId: string, digits: string): string;
  takeTransferAccepted(callId: string): boolean;
  acceptLoopIn(callId: string, digits: string): Promise<string>;
  handleLoopInStatus(callId: string, callStatus: string): void;
  fetchRecordingWav(recordingId: string): Promise<Buffer>;
  deleteRecording(recordingId: string): Promise<void>;
}

/**
 * Confirms an incoming Twilio webhook actually came from Twilio, not an
 * arbitrary caller who guessed PUBLIC_HOSTNAME — Twilio signs every webhook
 * request with an HMAC of the exact URL + POST params, keyed by
 * TWILIO_AUTH_TOKEN (see Twilio's request-validation docs). Gated behind
 * TWILIO_WEBHOOK_VALIDATION_ENABLED (default on, see .env.example) rather
 * than unconditional, since a hand-crafted curl request during local dev
 * can't produce a signature that validates against a real auth token. The
 * URL is reconstructed from PUBLIC_HOSTNAME rather than trusted from the
 * request itself (c.req.url's host reflects whatever this process happens
 * to be bound to, e.g. localhost:3000 behind a proxy) — it must exactly
 * match the URL Twilio was configured to call, the same construction
 * TwilioProvider.originateCall() already uses for the outbound TwiML
 * callback URL.
 */
export function isValidTwilioSignature(c: Context, body: Record<string, string>): boolean {
  if (!config.TWILIO_WEBHOOK_VALIDATION_ENABLED) return true;
  const signature = c.req.header('X-Twilio-Signature');
  if (!signature) return false;
  const url = `https://${config.PUBLIC_HOSTNAME}${c.req.path}${new URL(c.req.url).search}`;
  return twilioLib.validateRequest(config.TWILIO_AUTH_TOKEN as string, signature, url, body);
}

/**
 * isValidTwilioSignature for the Media Streams WebSocket upgrade. Twilio
 * signs the handshake over the <Stream url> it was given — `wss://`, no
 * query (it strips one; see TwilioProvider.buildTwiml) and no params — so
 * that's the URL rebuilt here, from PUBLIC_HOSTNAME like the webhooks'.
 * Without it anyone reaching the hostname could open a stream. It signs the
 * same URL for every call, so a captured signature would replay: the
 * per-call, single-use streamToken checked in
 * handleMediaStreamConnectionCommon's 'start' case is the second gate.
 */
export function isValidTwilioStreamSignature(request: IncomingMessage, pathname: string): boolean {
  if (!config.TWILIO_WEBHOOK_VALIDATION_ENABLED) return true;
  const signature = request.headers['x-twilio-signature'];
  if (typeof signature !== 'string' || !signature) return false;
  const url = `wss://${config.PUBLIC_HOSTNAME}${pathname}`;
  return twilioLib.validateRequest(config.TWILIO_AUTH_TOKEN as string, signature, url, {});
}

export const app = new Hono();

// Without this, an incoming webhook that never reaches our route handlers
// (bad PUBLIC_HOSTNAME, ngrok not running, wrong path, network issue)
// produces zero log output — indistinguishable from "reached us and we
// handled it silently." This is the first thing to check when a Twilio call
// fails with "An application error has occurred" and nothing shows up in
// our own error logs: did the request even land here at all?
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  logger.info(
    { method: c.req.method, path: c.req.path, query: redactQuery(c.req.query()), status: c.res.status, ms: Date.now() - start },
    'http request',
  );
});

app.route('/', healthRoutes);
app.route('/', approvalRoutes);
app.route('/', ownerQuestionRoutes);
registerMcpRoutes(app);

const telephony = createTelephonyProvider() as unknown as TwilioHttpHooks;
const calendar = createCalendarProvider();

app.post('/telephony/twilio/twiml', async (c) => {
  const body = await c.req.parseBody();
  if (!isValidTwilioSignature(c, body as Record<string, string>)) {
    logger.warn({ path: c.req.path }, 'rejected Twilio webhook with invalid or missing signature');
    return c.body(null, 403);
  }
  const callId = c.req.query('callId') ?? '';
  const twiml = telephony.buildTwiml(callId);
  logger.info({ callId, twimlLength: twiml.length }, 'serving TwiML for outbound call');
  return c.body(twiml, 200, { 'Content-Type': 'text/xml' });
});

app.post('/telephony/twilio/amd-callback', async (c) => {
  const body = await c.req.parseBody();
  if (!isValidTwilioSignature(c, body as Record<string, string>)) {
    logger.warn({ path: c.req.path }, 'rejected Twilio webhook with invalid or missing signature');
    return c.body(null, 403);
  }
  const callId = c.req.query('callId') ?? '';
  const answeredBy = typeof body.AnsweredBy === 'string' ? body.AnsweredBy : 'unknown';
  logger.info({ callId, answeredBy }, 'AMD callback received');
  telephony.handleAmdCallback(callId, answeredBy);
  return c.body(null, 204);
});

// An outbound call's final status (#79) — how Banjo learns a call that never
// connected (busy, no answer, failed) is over.
app.post('/telephony/twilio/status-callback', async (c) => {
  const body = await c.req.parseBody();
  if (!isValidTwilioSignature(c, body as Record<string, string>)) {
    logger.warn({ path: c.req.path }, 'rejected Twilio webhook with invalid or missing signature');
    return c.body(null, 403);
  }
  const callId = c.req.query('callId') ?? '';
  const callStatus = typeof body.CallStatus === 'string' ? body.CallStatus : '';
  logger.info({ callId, callStatus }, 'call status callback received');
  telephony.handleStatusCallback(callId, callStatus);
  return c.body(null, 204);
});

/**
 * Twilio's DialCallStatus, as recorded on call_attempts.transfer_result.
 * Anything unknown counts as failed. A dial the principal's line picked up
 * counts as answered only if they accepted it at the screen (#74): their
 * voicemail picks up too, and Twilio reports that as completed. Accepted is
 * this process's record of the key press. Twilio's DialBridged is logged,
 * not trusted: its docs don't say whether a voicemail picking up before the
 * screen hangs up counts as bridged, and if it does, trusting it brings the
 * bug back. Revisit once a live call shows its value in both cases.
 */
function transferResultFrom(dialCallStatus: unknown, accepted: boolean): TransferResult {
  switch (dialCallStatus) {
    case 'completed':
    case 'answered':
      return accepted ? 'answered' : 'no_answer';
    case 'no-answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    default:
      return 'failed';
  }
}

/**
 * The <Dial action> of a transfer_to_owner redirect (#7): Twilio calls this
 * when the dial to the principal ends, and runs the TwiML it returns — the
 * fallback line when they weren't reached. Recording the result must never
 * keep that TwiML from going back, or the caller is left in silence.
 */
app.post('/telephony/twilio/transfer-callback', async (c) => {
  const body = await c.req.parseBody();
  if (!isValidTwilioSignature(c, body as Record<string, string>)) {
    logger.warn({ path: c.req.path }, 'rejected Twilio webhook with invalid or missing signature');
    return c.body(null, 403);
  }
  const callId = c.req.query('callId') ?? '';
  const acceptedHere = telephony.takeTransferAccepted(callId);
  const bridged = body.DialBridged === 'true';
  const result = transferResultFrom(body.DialCallStatus, acceptedHere);
  // Logged before recording, so it survives a failed write: DialBridged's
  // value after a screen is what the #74 live test is collecting.
  logger.info({ callId, result, acceptedHere, bridged, dialCallStatus: body.DialCallStatus }, 'transfer dial ended');
  try {
    const recorded = await recordTransferResult(callId, result);
    logger.info({ callId, recorded }, 'transfer result recorded');
  } catch (err) {
    logger.error({ err, callId, result }, 'could not record the transfer result');
  }
  return c.body(telephony.buildTransferCallbackTwiml(result), 200, { 'Content-Type': 'text/xml' });
});

/**
 * A transfer's recording is ready (TRANSCRIBE_TRANSFERS): transcribed into the
 * call's transcript and then deleted, in the background, so Twilio gets its
 * answer at once.
 */
app.post('/telephony/twilio/transfer-recording', async (c) => {
  const body = await c.req.parseBody();
  if (!isValidTwilioSignature(c, body as Record<string, string>)) {
    logger.warn({ path: c.req.path }, 'rejected Twilio webhook with invalid or missing signature');
    return c.body(null, 403);
  }
  const callId = c.req.query('callId') ?? '';
  const recordingId = typeof body.RecordingSid === 'string' ? body.RecordingSid : '';
  if (body.RecordingStatus !== 'completed' || !recordingId) {
    logger.warn({ callId, status: body.RecordingStatus }, 'a transfer recording did not complete');
    if (recordingId) void telephony.deleteRecording(recordingId).catch((err: unknown) => logger.error({ err, callId }, 'could not delete a transfer recording'));
    return c.body(null, 204);
  }
  const started = typeof body.RecordingStartTime === 'string' ? new Date(body.RecordingStartTime) : new Date();
  void saveTransferLeg(
    { callId, recordingId, startedAt: Number.isNaN(started.getTime()) ? new Date() : started },
    { fetchRecordingWav: (id) => telephony.fetchRecordingWav(id), deleteRecording: (id) => telephony.deleteRecording(id) },
  );
  return c.body(null, 204);
});

/** The <Number url> of a transfer (#74): the screening prompt, run on the principal's leg once it picks up. */
app.post('/telephony/twilio/transfer-screen', async (c) => {
  const body = await c.req.parseBody();
  if (!isValidTwilioSignature(c, body as Record<string, string>)) {
    logger.warn({ path: c.req.path }, 'rejected Twilio webhook with invalid or missing signature');
    return c.body(null, 403);
  }
  const callId = c.req.query('callId') ?? '';
  logger.info({ callId }, 'transfer reached the principal — screening');
  return c.body(telephony.buildTransferScreenTwiml(callId), 200, { 'Content-Type': 'text/xml' });
});

/** The screening prompt's <Gather action> (#74): the principal's key press, if any. */
app.post('/telephony/twilio/transfer-screen-result', async (c) => {
  const body = await c.req.parseBody();
  if (!isValidTwilioSignature(c, body as Record<string, string>)) {
    logger.warn({ path: c.req.path }, 'rejected Twilio webhook with invalid or missing signature');
    return c.body(null, 403);
  }
  const callId = c.req.query('callId') ?? '';
  const digits = typeof body.Digits === 'string' ? body.Digits : '';
  logger.info({ callId, accepted: digits === '1' }, 'transfer screen answered');
  return c.body(telephony.acceptTransferScreen(callId, digits), 200, { 'Content-Type': 'text/xml' });
});

/**
 * The owner's key press on a warm transfer (#149), from the <Gather action> on
 * their leg. The TwiML returned runs on their leg: the bridge on a 1, a
 * hang-up otherwise. transfer_to_owner records the result, timeouts included.
 */
app.post('/telephony/twilio/loop-in-result', async (c) => {
  const body = await c.req.parseBody();
  if (!isValidTwilioSignature(c, body as Record<string, string>)) {
    logger.warn({ path: c.req.path }, 'rejected Twilio webhook with invalid or missing signature');
    return c.body(null, 403);
  }
  const callId = c.req.query('callId') ?? '';
  const digits = typeof body.Digits === 'string' ? body.Digits : '';
  logger.info({ callId, accepted: digits === '1' }, 'warm transfer: the owner answered the prompt');
  const twiml = await telephony.acceptLoopIn(callId, digits);
  return c.body(twiml, 200, { 'Content-Type': 'text/xml' });
});

/** The owner's leg of a warm transfer ended (#149): busy, unanswered, or hung up without a key press. */
app.post('/telephony/twilio/loop-in-status', async (c) => {
  const body = await c.req.parseBody();
  if (!isValidTwilioSignature(c, body as Record<string, string>)) {
    logger.warn({ path: c.req.path }, 'rejected Twilio webhook with invalid or missing signature');
    return c.body(null, 403);
  }
  const callId = c.req.query('callId') ?? '';
  const callStatus = typeof body.CallStatus === 'string' ? body.CallStatus : '';
  telephony.handleLoopInStatus(callId, callStatus);
  return c.body(null, 204);
});

/**
 * Twilio's Voice Configuration webhook for the number's "A call comes in"
 * setting — see docs/superpowers/specs/2026-08-07-inbound-voice-booking-design.md's
 * "Telephony/routing" section. Declines (never answers) unless
 * INBOUND_BOOKING_ENABLED is on and ea isn't already on another call,
 * inbound or outbound — this repo does not support real concurrent-call
 * handling, so declining is the whole concurrency policy, not a fallback.
 * Pointing the Twilio number's actual Voice Configuration URL at this route
 * is Steve's own manual action, not something this code does.
 */
app.post('/telephony/twilio/inbound', async (c) => {
  const body = await c.req.parseBody();
  if (!isValidTwilioSignature(c, body as Record<string, string>)) {
    logger.warn({ path: c.req.path }, 'rejected Twilio webhook with invalid or missing signature');
    return c.body(null, 403);
  }
  const callSid = typeof body.CallSid === 'string' ? body.CallSid : '';
  const from = typeof body.From === 'string' ? body.From : '';
  logger.info({ callSid, from }, 'inbound call webhook received');

  if (!callSid) {
    // A CallSid-less POST can't be a real Twilio webhook — registering it
    // anyway would key TwilioProvider's `calls` map on '' and permanently
    // occupy the "any call active" slot, since no real Media Stream will
    // ever arrive to end it. Checked before the enabled/busy branch below
    // so this rejects consistently regardless of flag state.
    logger.warn({ from }, 'inbound call webhook missing CallSid — declining without registering');
    return c.body(telephony.buildDeclineTwiml(), 200, { 'Content-Type': 'text/xml' });
  }

  if (!config.INBOUND_BOOKING_ENABLED || telephony.isAnyCallActive()) {
    logger.info({ callSid, from, enabled: config.INBOUND_BOOKING_ENABLED }, 'inbound call declined');
    return c.body(telephony.buildDeclineTwiml(), 200, { 'Content-Type': 'text/xml' });
  }

  telephony.registerInboundCall(callSid, from);
  try {
    // Inside the try (not before it) as defense in depth: resolveCallerContext
    // is itself written to fail closed and never throw, but if any lookup path
    // in it ever does, the catch below still rolls the registration back rather
    // than latching isAnyCallActive() to true for the life of the process.
    const { contactId, greetingContext } = await resolveCallerContext(from);
    const inboundCall = await createInboundCall({ twilioCallSid: callSid, callerPhoneNumber: from, contactId });
    // Only a caller recognized from contacts can be put through to the
    // principal (#66); resolveCallerContext fails closed to no match.
    const transferAllowed = contactId !== undefined;
    // A caller returning one of Banjo's calls gets that call (#129): only a
    // recognized caller's own, only with a caller ID the carrier fully
    // attests (it can be spoofed), and the lookup fails closed to none.
    const recentCalls = contactId !== undefined && isFullyAttested(body.StirVerstat) ? await recentOutboundCalls(contactId) : [];

    // Fire-and-forget, matching src/tasks/orchestrator.ts's triggerOrchestration
    // pattern — a phone call runs for real wall-clock minutes, and this HTTP
    // handler must return TwiML immediately so Twilio actually connects the
    // Media Stream, not wait for the whole call to finish. Session
    // construction stays inside this try too, not just the DB write — a
    // synchronous throw here (e.g. createVoiceAIProvider() failing) is just
    // as capable of leaving the registration behind as a DB failure is.
    const session = new CallSession(
      buildInboundCallSessionOptions({
        inboundCall,
        callerPhoneNumber: from,
        telephony: createTelephonyProvider(),
        calendar,
        systemPrompt: buildInboundSystemPrompt(greetingContext, { transferAllowed, recentCalls }),
        frontendSystemPrompt: buildInboundFrontendPrompt(greetingContext, { transferAllowed, recentCalls }),
        transferAllowed,
      }),
    );
    session.start().catch((err) => logger.error({ err, callSid }, 'Inbound call session failed'));
  } catch (err) {
    // Without this rollback, a failure here would leave the call
    // permanently registered in the provider's `calls` map — since no
    // Media Stream connection (and therefore no 'stop' event) will ever
    // arrive for a call we're about to decline — and isAnyCallActive()
    // would latch to true forever, silently declining every future inbound
    // call until the process restarts.
    telephony.unregisterInboundCall(callSid);
    logger.error({ err, callSid, from }, 'failed to set up inbound call, declining');
    return c.body(telephony.buildDeclineTwiml(), 200, { 'Content-Type': 'text/xml' });
  }

  const twiml = telephony.buildInboundTwiml(callSid);
  logger.info({ callSid, from }, 'serving TwiML for inbound call');
  return c.body(twiml, 200, { 'Content-Type': 'text/xml' });
});

export function startServer() {
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info({ port: info.port }, 'ea listening');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        { port: config.PORT },
        `Port ${config.PORT} is already in use — is another "ea" process (e.g. \`npm run dev\`) already running? ` +
          'Only one process can hold this port at a time, since Twilio\'s media-stream WebSocket must land on ' +
          'whichever process actually originated the call. Stop the other process first.',
      );
    } else {
      logger.error({ err }, 'HTTP server error');
    }
    process.exit(1);
  });

  // Media-stream audio is hot-path (~20ms frames) — handled via a raw ws
  // WebSocketServer attached directly to the underlying http.Server, not
  // routed through Hono's request/middleware machinery, which adds nothing
  // once a socket is upgraded. Hono owns HTTP (webhooks, health, MCP); ws
  // owns the audio socket. See docs/ARCHITECTURE.md for the rationale.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    logger.info({ path: url.pathname, host: request.headers.host }, 'WS upgrade attempt');

    const isStreamPath = url.pathname === '/telephony/twilio/stream' || url.pathname === '/telephony/twilio/inbound-stream';
    if (isStreamPath && !isValidTwilioStreamSignature(request, url.pathname)) {
      logger.warn({ path: url.pathname }, 'WS upgrade rejected — invalid Twilio signature');
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    if (url.pathname === '/telephony/twilio/stream') {
      // No callId here — Twilio strips query params from the Stream URL
      // (see TwilioProvider.buildTwiml()'s comment); the provider learns
      // callId itself once the 'start' event's customParameters arrive.
      wss.handleUpgrade(request, socket, head, (ws) => {
        logger.info({}, 'media-stream WS upgraded, awaiting start event for callId');
        const telephony = createTelephonyProvider() as unknown as TwilioHttpHooks;
        telephony.handleMediaStreamConnection(ws);
      });
      return;
    }

    if (url.pathname === '/telephony/twilio/inbound-stream') {
      // No callId here either — for an inbound call, callId IS Twilio's
      // own CallSid, which the provider learns from the 'start' event's
      // own callSid field (see TwilioProvider.handleInboundMediaStreamConnection).
      wss.handleUpgrade(request, socket, head, (ws) => {
        logger.info({}, 'inbound media-stream WS upgraded, awaiting start event for callId');
        const telephony = createTelephonyProvider() as unknown as TwilioHttpHooks;
        telephony.handleInboundMediaStreamConnection(ws);
      });
      return;
    }

    logger.warn({ path: url.pathname }, 'WS upgrade rejected — no matching route');
    socket.destroy();
  });

  return server;
}
