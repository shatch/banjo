import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundCall } from '../src/inbound/schema.js';

const { fakeLog } = vi.hoisted(() => ({
  fakeLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));
vi.mock('../src/lib/logger.js', () => ({ childLogger: () => fakeLog, logger: fakeLog }));

const registerInboundCall = vi.fn();
const unregisterInboundCall = vi.fn();
const buildInboundTwiml = vi.fn(() => '<Response><Connect><Stream url="wss://x/telephony/twilio/inbound-stream" /></Connect></Response>');
const buildDeclineTwiml = vi.fn(() => '<Response><Reject reason="busy"/></Response>');
const isAnyCallActive = vi.fn(() => false);
const buildTwiml = vi.fn(() => '<Response></Response>');
const handleAmdCallback = vi.fn();
const handleStatusCallback = vi.fn();
const handleMediaStreamConnection = vi.fn();
const handleInboundMediaStreamConnection = vi.fn();
const buildTransferCallbackTwiml = vi.fn((result: string) =>
  result === 'answered' ? '<Response><Hangup/></Response>' : '<Response><Say>fallback</Say><Hangup/></Response>',
);

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
    handleStatusCallback,
    handleMediaStreamConnection,
    handleInboundMediaStreamConnection,
    buildTransferCallbackTwiml,
    buildTransferScreenTwiml,
    acceptTransferScreen,
    takeTransferAccepted,
    fetchRecordingWav,
    deleteRecording,
  }),
}));

const fetchRecordingWav = vi.fn(async (_id: string) => Buffer.alloc(0));
const deleteRecording = vi.fn(async (_id: string) => {});
const saveTransferLeg = vi.fn(async (..._args: unknown[]) => 0);
vi.mock('../src/transcripts/transferLeg.js', () => ({ saveTransferLeg: (...args: unknown[]) => saveTransferLeg(...args) }));

const recordTransferResult = vi.fn(async (_callId: string, _result: string) => true);
const buildTransferScreenTwiml = vi.fn((_callId: string) => '<Response><Gather/><Hangup/></Response>');
const acceptTransferScreen = vi.fn((_callId: string, _digits: string) => '<Response/>');
const takeTransferAccepted = vi.fn((_callId: string) => true);
vi.mock('../src/tasks/service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tasks/service.js')>()),
  recordTransferResult: (callId: string, result: string) => recordTransferResult(callId, result),
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

// Same reason: the recent-calls lookup (#129) would hit the real DB.
const recentOutboundCalls = vi.fn(async (_contactId: string) => [] as unknown[]);
vi.mock('../src/inbound/recentCalls.js', () => ({
  recentOutboundCalls: (contactId: string) => recentOutboundCalls(contactId),
}));

const sessionStart = vi.fn(async () => {});
const sessionOptions = vi.fn((_opts: { tools: { name: string }[]; systemPrompt: string }) => {});
vi.mock('../src/session/callSession.js', () => ({
  CallSession: class {
    start = sessionStart;
    constructor(opts: { tools: { name: string }[]; systemPrompt: string }) {
      sessionOptions(opts);
    }
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

describe('inbound transfer is limited to recognized callers (#66)', () => {
  async function answer(contactId: string | undefined) {
    resolveCallerContext.mockResolvedValueOnce({ contactId, greetingContext: undefined } as never);
    await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: inboundWebhookBody(),
    });
    const opts = sessionOptions.mock.calls.at(-1)![0];
    return { tools: opts.tools.map((t) => t.name), prompt: opts.systemPrompt };
  }

  it('offers transfer_to_owner to a caller found in contacts, and not to an unknown one', async () => {
    config.INBOUND_BOOKING_ENABLED = true;
    config.TRANSFER_ENABLED = true;
    config.TRANSFER_TO_PHONE_NUMBER = '+15557654321';
    try {
      const known = await answer('contact-1');
      expect(known.tools).toContain('transfer_to_owner');
      expect(known.prompt).toContain('transfer_to_owner');

      const unknown = await answer(undefined);
      expect(unknown.tools).not.toContain('transfer_to_owner');
      expect(unknown.prompt).not.toContain('transfer_to_owner');
    } finally {
      config.TRANSFER_ENABLED = false;
      config.INBOUND_BOOKING_ENABLED = false;
    }
  });
});

describe('a returning caller gets their recent calls from Banjo (#129)', () => {
  async function answer(contactId: string | undefined) {
    resolveCallerContext.mockResolvedValueOnce({ contactId, greetingContext: undefined } as never);
    await app.request('/telephony/twilio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: inboundWebhookBody(),
    });
    return sessionOptions.mock.calls.at(-1)![0].systemPrompt;
  }

  it("puts a recognized caller's recent calls in the prompt, and never looks any up for an unknown caller", async () => {
    config.INBOUND_BOOKING_ENABLED = true;
    try {
      recentOutboundCalls.mockResolvedValueOnce([
        { taskId: 't1', calledAt: new Date('2026-10-24T14:30:00Z'), mode: 'conversation', goal: 'Tell them about the show.', status: 'voicemail_left', outcome: null },
      ]);
      expect(await answer('contact-1')).toContain('Tell them about the show.');
      expect(recentOutboundCalls).toHaveBeenLastCalledWith('contact-1');

      recentOutboundCalls.mockClear();
      expect(await answer(undefined)).not.toContain('You called this caller recently');
      expect(recentOutboundCalls).not.toHaveBeenCalled();
    } finally {
      config.INBOUND_BOOKING_ENABLED = false;
    }
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

describe('POST /telephony/twilio/status-callback', () => {
  it('hands a validly signed final status to the provider', async () => {
    const res = await app.request('/telephony/twilio/status-callback?callId=call-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
      body: new URLSearchParams({ CallStatus: 'failed', CallSid: 'CA1' }).toString(),
    });

    expect(res.status).toBe(204);
    expect(handleStatusCallback).toHaveBeenCalledWith('call-1', 'failed');
  });

  it('rejects an invalidly signed status callback with 403, without acting on it', async () => {
    validateRequest.mockReturnValueOnce(false);

    const res = await app.request('/telephony/twilio/status-callback?callId=call-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bad-signature' },
      body: new URLSearchParams({ CallStatus: 'failed' }).toString(),
    });

    expect(res.status).toBe(403);
    expect(handleStatusCallback).not.toHaveBeenCalled();
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

describe('POST /telephony/twilio/transfer-recording (TRANSCRIBE_TRANSFERS)', () => {
  const post = (body: Record<string, string>, signature = 'valid-signature') =>
    app.request('/telephony/twilio/transfer-recording?callId=attempt-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
      body: new URLSearchParams(body).toString(),
    });
  const RE = 'RE' + 'b'.repeat(32);

  it('hands a completed recording to be transcribed, with when it started', async () => {
    const res = await post({ RecordingSid: RE, RecordingStatus: 'completed', RecordingStartTime: 'Mon, 19 Oct 2026 01:17:30 +0000' });
    expect(res.status).toBe(204);
    expect(saveTransferLeg).toHaveBeenCalledWith(
      { callId: 'attempt-1', recordingId: RE, startedAt: new Date('2026-10-19T01:17:30Z') },
      expect.objectContaining({ fetchRecordingWav: expect.any(Function), deleteRecording: expect.any(Function) }),
    );
  });

  it('deletes a recording that did not complete, transcribing nothing', async () => {
    await post({ RecordingSid: RE, RecordingStatus: 'failed' });
    expect(saveTransferLeg).not.toHaveBeenCalled();
    expect(deleteRecording).toHaveBeenCalledWith(RE);
  });

  it('rejects a request without a valid Twilio signature', async () => {
    validateRequest.mockReturnValueOnce(false);
    expect((await post({ RecordingSid: RE, RecordingStatus: 'completed' })).status).toBe(403);
    expect(saveTransferLeg).not.toHaveBeenCalled();
  });
});

describe('POST /telephony/twilio/transfer-callback (#7)', () => {
  const post = (query: string, body: Record<string, string>, signature = 'valid-signature') =>
    app.request(`/telephony/twilio/transfer-callback${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
      body: new URLSearchParams(body).toString(),
    });

  it.each([
    ['completed', 'answered'],
    ['answered', 'answered'],
    ['no-answer', 'no_answer'],
    ['busy', 'busy'],
    ['failed', 'failed'],
    ['canceled', 'failed'],
    ['something-new', 'failed'],
  ])('DialCallStatus=%s is recorded as %s and answered with the matching TwiML', async (dialStatus, result) => {
    const res = await post('?callId=attempt-1', { DialCallStatus: dialStatus });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/xml');
    expect(recordTransferResult).toHaveBeenCalledWith('attempt-1', result);
    expect(buildTransferCallbackTwiml).toHaveBeenCalledWith(result);
  });

  it('counts a completed dial as answered when the principal accepted it at the screen (#74)', async () => {
    takeTransferAccepted.mockReturnValueOnce(true);
    await post('?callId=attempt-1', { DialCallStatus: 'completed' });
    expect(recordTransferResult).toHaveBeenCalledWith('attempt-1', 'answered');
  });

  it("does not trust DialBridged yet: unaccepted stays no_answer even if Twilio says bridged — it may mean the voicemail picked up (#74)", async () => {
    takeTransferAccepted.mockReturnValueOnce(false);
    await post('?callId=attempt-1', { DialCallStatus: 'completed', DialBridged: 'true' });
    expect(recordTransferResult).toHaveBeenCalledWith('attempt-1', 'no_answer');
  });

  it('logs both acceptance signals even when recording the result fails (#74)', async () => {
    recordTransferResult.mockRejectedValueOnce(new Error('db down'));
    fakeLog.info.mockClear();
    await post('?callId=attempt-1', { DialCallStatus: 'completed', DialBridged: 'false' });
    expect(fakeLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'attempt-1', acceptedHere: true, bridged: false, dialCallStatus: 'completed' }),
      expect.any(String),
    );
  });

  it.each([['no-answer'], ['busy'], ['failed']])('reads the screen result even for DialCallStatus=%s, so a late 1 is not left behind (#74)', async (dialStatus) => {
    await post('?callId=attempt-1', { DialCallStatus: dialStatus });
    expect(takeTransferAccepted).toHaveBeenCalledWith('attempt-1');
  });

  it("counts a completed dial the principal never accepted as no_answer — their voicemail picked up (#74)", async () => {
    takeTransferAccepted.mockReturnValueOnce(false);
    await post('?callId=attempt-1', { DialCallStatus: 'completed' });
    expect(takeTransferAccepted).toHaveBeenCalledWith('attempt-1');
    expect(recordTransferResult).toHaveBeenCalledWith('attempt-1', 'no_answer');
    expect(buildTransferCallbackTwiml).toHaveBeenCalledWith('no_answer');
  });

  it('still answers with TwiML when recording the result throws, so the caller is not left in silence', async () => {
    recordTransferResult.mockRejectedValueOnce(new Error('db down'));
    const res = await post('?callId=attempt-1', { DialCallStatus: 'no-answer' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Say>');
  });

  it('rejects an unsigned request', async () => {
    validateRequest.mockReturnValueOnce(false);
    const res = await post('?callId=attempt-1', { DialCallStatus: 'completed' }, 'bad-signature');
    expect(res.status).toBe(403);
    expect(recordTransferResult).not.toHaveBeenCalled();
    expect(takeTransferAccepted).not.toHaveBeenCalled(); // a forged callback can't consume a real acceptance
  });
});

it('does not log the outbound TwiML body (#7)', async () => {
  fakeLog.info.mockClear();
  await app.request('/telephony/twilio/twiml?callId=c1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'valid-signature' },
    body: '',
  });
  const logged = fakeLog.info.mock.calls.map(([obj]) => obj);
  expect(logged.some((obj) => obj && typeof obj === 'object' && 'callId' in obj && 'twimlLength' in obj)).toBe(true);
  expect(logged.every((obj) => !(obj && typeof obj === 'object' && 'twiml' in obj))).toBe(true);
});

describe('transfer screening routes (#74)', () => {
  const post = (path: string, body: Record<string, string>, signature = 'valid-signature') =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
      body: new URLSearchParams(body).toString(),
    });

  it('serves the screening prompt for the call', async () => {
    const res = await post('/telephony/twilio/transfer-screen?callId=attempt-1', {});
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/xml');
    expect(buildTransferScreenTwiml).toHaveBeenCalledWith('attempt-1');
  });

  it("passes the principal's key press on", async () => {
    const res = await post('/telephony/twilio/transfer-screen-result?callId=attempt-1', { Digits: '1' });
    expect(res.status).toBe(200);
    expect(acceptTransferScreen).toHaveBeenCalledWith('attempt-1', '1');
  });

  it('treats a missing key press as none', async () => {
    await post('/telephony/twilio/transfer-screen-result?callId=attempt-1', {});
    expect(acceptTransferScreen).toHaveBeenCalledWith('attempt-1', '');
  });

  it.each([['/telephony/twilio/transfer-screen?callId=attempt-1'], ['/telephony/twilio/transfer-screen-result?callId=attempt-1']])(
    'rejects an unsigned request to %s',
    async (path) => {
      validateRequest.mockReturnValueOnce(false);
      const res = await post(path, { Digits: '1' }, 'bad-signature');
      expect(res.status).toBe(403);
      expect(acceptTransferScreen).not.toHaveBeenCalled();
      expect(buildTransferScreenTwiml).not.toHaveBeenCalled();
    },
  );
});

describe('the request log', () => {
  it("never writes an approval link's signature", async () => {
    await app.request('/health?sig=' + 'a'.repeat(64) + '&x=1');
    const logged = fakeLog.info.mock.calls.find((call) => (call as unknown[])[1] === 'http request') as unknown[] | undefined;
    expect(logged?.[0]).toMatchObject({ path: '/health', query: { sig: '[redacted]', x: '1' } });
    expect(JSON.stringify(fakeLog.info.mock.calls)).not.toContain('a'.repeat(64));
  });
});
