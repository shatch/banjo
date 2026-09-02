import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    handleMediaStreamConnection: vi.fn(),
    handleInboundMediaStreamConnection: vi.fn(),
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

const { app } = await import('../src/server.js');
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
