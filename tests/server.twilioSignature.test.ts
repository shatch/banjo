import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

// Deliberately does NOT mock 'twilio' — every other server.test.ts test file
// mocks it out so it can control validateRequest's return value directly,
// but that means nothing in this repo's suite ever exercises the real HMAC
// signature math. The URL reconstruction in isValidTwilioSignature() is the
// single highest-consequence line in the whole webhook-validation feature —
// a mismatch there means every real Twilio request gets silently 403'd —
// and no mocked test can catch that class of bug. This file computes a real
// signature with the real SDK and asserts the real (unmocked) validateRequest
// accepts it, and rejects a tampered one.

const buildTwiml = vi.fn(() => '<Response></Response>');
const handleMediaStreamConnection = vi.fn();
const handleInboundMediaStreamConnection = vi.fn();

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
    registerInboundCall: vi.fn(),
    unregisterInboundCall: vi.fn(),
    buildInboundTwiml: vi.fn(),
    buildDeclineTwiml: vi.fn(),
    isAnyCallActive: vi.fn(() => false),
    buildTwiml,
    handleAmdCallback: vi.fn(),
    handleMediaStreamConnection,
    handleInboundMediaStreamConnection,
  }),
}));

vi.mock('../src/inbound/service.js', () => ({
  createInboundCall: vi.fn(),
}));

vi.mock('../src/session/callSession.js', () => ({
  CallSession: class {
    start = vi.fn(async () => {});
  },
}));

const { app, startServer } = await import('../src/server.js');
const { config } = await import('../src/config/index.js');
const twilioLib = (await import('twilio')).default;

const TEST_HOSTNAME = 'ea-test.example.com';
const TWIML_URL = `https://${TEST_HOSTNAME}/telephony/twilio/twiml?callId=call-1`;

beforeEach(() => {
  vi.clearAllMocks();
  config.TWILIO_WEBHOOK_VALIDATION_ENABLED = true;
  config.PUBLIC_HOSTNAME = TEST_HOSTNAME;
});

describe('Twilio webhook signature validation with the real SDK (no mocking)', () => {
  it('accepts a request signed with the real Twilio HMAC algorithm over the actual PUBLIC_HOSTNAME URL', async () => {
    // Real Twilio webhooks for /twiml carry no body this route reads, so an
    // empty param set signs cleanly — matches the existing mocked /twiml
    // tests' body: ''.
    const signature = twilioLib.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN as string, TWIML_URL, {});

    const res = await app.request('/telephony/twilio/twiml?callId=call-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
      body: '',
    });

    expect(res.status).toBe(200);
    expect(buildTwiml).toHaveBeenCalledWith('call-1');
  });

  it('rejects a request whose signature was computed for different params than what was actually sent', async () => {
    // Signs against a body the request does NOT actually send — simulates a
    // tampered/replayed request, or (just as importantly for this test) a
    // PUBLIC_HOSTNAME/URL mismatch between what signed the request and what
    // the server reconstructs.
    const signature = twilioLib.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN as string, TWIML_URL, { CallSid: 'CA-tampered' });

    const res = await app.request('/telephony/twilio/twiml?callId=call-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
      body: '',
    });

    expect(res.status).toBe(403);
    expect(buildTwiml).not.toHaveBeenCalled();
  });

  it('rejects a correctly-computed signature if PUBLIC_HOSTNAME no longer matches what signed it', async () => {
    // Regression guard for exactly the failure mode the final review flagged:
    // if config.PUBLIC_HOSTNAME drifts from the URL Twilio was actually
    // configured with, every real webhook silently 403s. A signature signed
    // against the OLD hostname must not validate against the NEW one.
    const signature = twilioLib.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN as string, TWIML_URL, {});
    config.PUBLIC_HOSTNAME = 'a-different-hostname.example.com';

    const res = await app.request('/telephony/twilio/twiml?callId=call-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
      body: '',
    });

    expect(res.status).toBe(403);
    expect(buildTwiml).not.toHaveBeenCalled();
  });
});

describe('Media Streams WebSocket upgrade signature (GHSA-5x8v-r99f-ph3m)', () => {
  // A real listening server and a real ws client: the check runs on the raw
  // upgrade request, outside Hono, so app.request() can't reach it.
  let server: ReturnType<typeof startServer>;
  let port: number;

  beforeAll(async () => {
    config.PORT = 0;
    server = startServer();
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Resolves 'open' or the HTTP status the upgrade was refused with. */
  function connect(path: string, signature?: string): Promise<'open' | number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: signature ? { 'X-Twilio-Signature': signature } : {},
      });
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', reject);
    });
  }

  const sign = (url: string) => twilioLib.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN as string, url, {});

  it.each([
    ['/telephony/twilio/stream', handleMediaStreamConnection],
    ['/telephony/twilio/inbound-stream', handleInboundMediaStreamConnection],
  ])('accepts %s signed over its wss:// <Stream url>', async (path, handler) => {
    expect(await connect(path, sign(`wss://${TEST_HOSTNAME}${path}`))).toBe('open');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(['/telephony/twilio/stream', '/telephony/twilio/inbound-stream'])('refuses %s with no signature', async (path) => {
    expect(await connect(path)).toBe(403);
    expect(handleMediaStreamConnection).not.toHaveBeenCalled();
    expect(handleInboundMediaStreamConnection).not.toHaveBeenCalled();
  });

  it('refuses a signature made for the other stream path', async () => {
    expect(await connect('/telephony/twilio/stream', sign(`wss://${TEST_HOSTNAME}/telephony/twilio/inbound-stream`))).toBe(403);
    expect(handleMediaStreamConnection).not.toHaveBeenCalled();
  });

  it('refuses a signature made for another hostname', async () => {
    expect(await connect('/telephony/twilio/stream', sign('wss://attacker.example.com/telephony/twilio/stream'))).toBe(403);
  });

  it('refuses a signature made with another auth token', async () => {
    const forged = twilioLib.getExpectedTwilioSignature('not-the-auth-token', `wss://${TEST_HOSTNAME}/telephony/twilio/stream`, {});
    expect(await connect('/telephony/twilio/stream', forged)).toBe(403);
  });

  it('lets an unsigned upgrade through only with TWILIO_WEBHOOK_VALIDATION_ENABLED off', async () => {
    config.TWILIO_WEBHOOK_VALIDATION_ENABLED = false;
    expect(await connect('/telephony/twilio/stream')).toBe('open');
  });
});
