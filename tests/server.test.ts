import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundCall } from '../src/inbound/schema.js';

const registerInboundCall = vi.fn();
const unregisterInboundCall = vi.fn();
const buildInboundTwiml = vi.fn(() => '<Response><Connect><Stream url="wss://x/telephony/twilio/inbound-stream" /></Connect></Response>');
const buildDeclineTwiml = vi.fn(() => '<Response><Reject reason="busy"/></Response>');
const isAnyCallActive = vi.fn(() => false);
const buildTwiml = vi.fn(() => '<Response></Response>');
const handleAmdCallback = vi.fn();
const handleMediaStreamConnection = vi.fn();
const handleInboundMediaStreamConnection = vi.fn();

const validateRequest = vi.fn(() => true);
vi.mock('twilio', () => ({
  default: { validateRequest },
}));

vi.mock('../src/telephony/factory.js', () => ({
  createTelephonyProvider: () => ({
    name: 'fake-telephony',
    nativeAudioFormat: 'g711_ulaw_8k',
    originateCall: vi.fn(),
    sendAudio: vi.fn(),
    sendDigits: vi.fn(),
    interrupt: vi.fn(),
    hangUp: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    registerInboundCall,
    unregisterInboundCall,
    buildInboundTwiml,
    buildDeclineTwiml,
    isAnyCallActive,
    buildTwiml,
    handleAmdCallback,
    handleMediaStreamConnection,
    handleInboundMediaStreamConnection,
  }),
}));

const createInboundCall = vi.fn(
  async (_input: { twilioCallSid: string; callerPhoneNumber: string; contactId?: string }) =>
    ({ id: 'inbound-call-1', twilioCallSid: 'CA-inbound-1' }) as InboundCall,
);
vi.mock('../src/inbound/service.js', () => ({
  createInboundCall: (input: { twilioCallSid: string; callerPhoneNumber: string; contactId?: string }) => createInboundCall(input),
}));

// Caller-context resolution hits the real DB (via src/contacts/service.js)
// otherwise — this suite's fake test-env DATABASE_URL (see vitest.config.ts)
// isn't a real reachable database, so resolveCallerContext would throw and
// turn every inbound-webhook request in this file into an unhandled 500.
// Defaults to "unrecognized caller" (no contactId, no personalization),
// matching resolveCallerContext's real behavior for a phone number with no
// local or Google Contacts match.
const resolveCallerContext = vi.fn(async (_callerPhoneNumber: string) => ({ contactId: undefined, greetingContext: undefined }));
vi.mock('../src/inbound/callerContext.js', () => ({
  resolveCallerContext: (callerPhoneNumber: string) => resolveCallerContext(callerPhoneNumber),
}));

const sessionStart = vi.fn(async () => {});
vi.mock('../src/session/callSession.js', () => ({
  CallSession: class {
    start = sessionStart;
  },
}));

const { app } = await import('../src/server.js');
const { config } = await import('../src/config/index.js');

function inboundWebhookBody(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({ CallSid: 'CA-inbound-1', From: '+15555550100', ...overrides });
  return params.toString();
}

beforeEach(() => {
  vi.clearAllMocks();
  // vi.clearAllMocks() calls mockClear() on every mock, which does NOT drain
  // a queued mockReturnValueOnce() — only mockReset() does. Without this,
  // a test that queues .mockReturnValueOnce(false) but then short-circuits
  // before validateRequest is ever called (e.g. because
  // TWILIO_WEBHOOK_VALIDATION_ENABLED was false) leaks that queued value
  // into the NEXT test's first validateRequest call, silently making it
  // exercise the reject path while its own test name/intent describes the
  // accept path.
  validateRequest.mockReset();
  validateRequest.mockReturnValue(true);
  isAnyCallActive.mockReturnValue(false);
  config.TWILIO_WEBHOOK_VALIDATION_ENABLED = true;
});

describe('POST /telephony/twilio/inbound', () => {
  it('declines without registering anything when INBOUND_BOOKING_ENABLED is false', async () => {
    config.INBOUND_BOOKING_ENABLED = false;

    const res = await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: inboundWebhookBody(),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Reject');
    expect(registerInboundCall).not.toHaveBeenCalled();
    expect(createInboundCall).not.toHaveBeenCalled();
    expect(sessionStart).not.toHaveBeenCalled();
  });

  it('declines without registering anything when a call is already active, even with the flag enabled', async () => {
    config.INBOUND_BOOKING_ENABLED = true;
    isAnyCallActive.mockReturnValue(true);

    const res = await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: inboundWebhookBody(),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Reject');
    expect(registerInboundCall).not.toHaveBeenCalled();
    expect(createInboundCall).not.toHaveBeenCalled();
  });

  it('registers, persists, and starts a session when enabled and not busy, returning the inbound Connect/Stream TwiML', async () => {
    config.INBOUND_BOOKING_ENABLED = true;
    isAnyCallActive.mockReturnValue(false);

    const res = await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: inboundWebhookBody({ CallSid: 'CA-inbound-2', From: '+15555550199' }),
    });

    expect(registerInboundCall).toHaveBeenCalledWith('CA-inbound-2', '+15555550199');
    expect(createInboundCall).toHaveBeenCalledWith({ twilioCallSid: 'CA-inbound-2', callerPhoneNumber: '+15555550199' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<Stream url="wss://');
    expect(text).not.toContain('<Reject');
  });

  it('unregisters the call and declines when persisting the inbound call fails', async () => {
    config.INBOUND_BOOKING_ENABLED = true;
    isAnyCallActive.mockReturnValue(false);
    createInboundCall.mockRejectedValueOnce(new Error('db unavailable'));

    const res = await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: inboundWebhookBody({ CallSid: 'CA-inbound-3', From: '+15555550199' }),
    });

    expect(registerInboundCall).toHaveBeenCalledWith('CA-inbound-3', '+15555550199');
    expect(unregisterInboundCall).toHaveBeenCalledWith('CA-inbound-3');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Reject');
    expect(sessionStart).not.toHaveBeenCalled();
  });

  it('unregisters the call and declines when caller-context resolution throws', async () => {
    // resolveCallerContext is written to fail closed and never throw, but if
    // it ever does, it must not escape the handler's try — otherwise the
    // rollback never runs and isAnyCallActive() latches true for the life of
    // the process, silently declining every future inbound call.
    config.INBOUND_BOOKING_ENABLED = true;
    isAnyCallActive.mockReturnValue(false);
    resolveCallerContext.mockRejectedValueOnce(new Error('db unavailable'));

    const res = await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: inboundWebhookBody({ CallSid: 'CA-inbound-4', From: '+15555550199' }),
    });

    expect(registerInboundCall).toHaveBeenCalledWith('CA-inbound-4', '+15555550199');
    expect(unregisterInboundCall).toHaveBeenCalledWith('CA-inbound-4');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Reject');
    expect(createInboundCall).not.toHaveBeenCalled();
    expect(sessionStart).not.toHaveBeenCalled();
  });

  it('does not await session.start() before responding — the HTTP response must not block on the whole call', async () => {
    config.INBOUND_BOOKING_ENABLED = true;
    isAnyCallActive.mockReturnValue(false);
    let sessionStartResolved = false;
    sessionStart.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            sessionStartResolved = true;
            resolve(undefined);
          }, 50);
        }),
    );

    const res = await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: inboundWebhookBody(),
    });

    expect(res.status).toBe(200);
    expect(sessionStartResolved).toBe(false); // the response returned before the 50ms session.start() resolved
  });

  it('declines without registering anything when the webhook body has no CallSid', async () => {
    config.INBOUND_BOOKING_ENABLED = true;
    isAnyCallActive.mockReturnValue(false);

    const res = await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: new URLSearchParams({ From: '+15555550100' }).toString(), // no CallSid field at all
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Reject');
    expect(registerInboundCall).not.toHaveBeenCalled();
    expect(createInboundCall).not.toHaveBeenCalled();
  });
});

describe('POST /telephony/twilio/twiml', () => {
  it('returns outbound TwiML for a validly signed request', async () => {
    const res = await app.request('/telephony/twilio/twiml?callId=call-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: '',
    });

    expect(res.status).toBe(200);
    expect(buildTwiml).toHaveBeenCalledWith('call-1');
  });

  it('rejects an invalidly signed request with 403, without calling buildTwiml', async () => {
    validateRequest.mockReturnValueOnce(false);

    const res = await app.request('/telephony/twilio/twiml?callId=call-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bad-signature' },
      body: '',
    });

    expect(res.status).toBe(403);
    expect(buildTwiml).not.toHaveBeenCalled();
  });

  it('rejects a request with no X-Twilio-Signature header at all, without calling validateRequest', async () => {
    const res = await app.request('/telephony/twilio/twiml?callId=call-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });

    expect(res.status).toBe(403);
    expect(validateRequest).not.toHaveBeenCalled();
  });
});

describe('POST /telephony/twilio/amd-callback', () => {
  it('processes a validly signed AMD callback', async () => {
    const res = await app.request('/telephony/twilio/amd-callback?callId=call-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: new URLSearchParams({ AnsweredBy: 'human' }).toString(),
    });

    expect(res.status).toBe(204);
    expect(handleAmdCallback).toHaveBeenCalledWith('call-1', 'human');
  });

  it('rejects an invalidly signed AMD callback with 403, without calling handleAmdCallback', async () => {
    validateRequest.mockReturnValueOnce(false);

    const res = await app.request('/telephony/twilio/amd-callback?callId=call-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bad-signature' },
      body: new URLSearchParams({ AnsweredBy: 'human' }).toString(),
    });

    expect(res.status).toBe(403);
    expect(handleAmdCallback).not.toHaveBeenCalled();
  });
});

describe('Twilio webhook signature validation on /telephony/twilio/inbound', () => {
  it('rejects an invalidly signed request with 403, without registering anything', async () => {
    config.INBOUND_BOOKING_ENABLED = true;
    validateRequest.mockReturnValueOnce(false);

    const res = await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bad-signature' },
      body: inboundWebhookBody(),
    });

    expect(res.status).toBe(403);
    expect(registerInboundCall).not.toHaveBeenCalled();
  });

  it('rejects a request with no X-Twilio-Signature header at all, without calling validateRequest', async () => {
    config.INBOUND_BOOKING_ENABLED = true;

    const res = await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: inboundWebhookBody(),
    });

    expect(res.status).toBe(403);
    expect(validateRequest).not.toHaveBeenCalled();
  });

  it('skips validation entirely when TWILIO_WEBHOOK_VALIDATION_ENABLED is false, even with an invalid signature', async () => {
    config.INBOUND_BOOKING_ENABLED = true;
    config.TWILIO_WEBHOOK_VALIDATION_ENABLED = false;
    validateRequest.mockReturnValueOnce(false); // would reject if validation actually ran

    const res = await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: inboundWebhookBody(),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('<Reject');
  });

  it('passes the PUBLIC_HOSTNAME-reconstructed https URL, the signature header, and the parsed body to validateRequest', async () => {
    config.INBOUND_BOOKING_ENABLED = true;

    await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'sig-value' },
      body: inboundWebhookBody(),
    });

    expect(validateRequest).toHaveBeenCalledWith(
      config.TWILIO_AUTH_TOKEN,
      'sig-value',
      `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/inbound`,
      expect.objectContaining({ CallSid: 'CA-inbound-1', From: '+15555550100' }),
    );
  });
});
