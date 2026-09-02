import { describe, expect, it, vi } from 'vitest';
import type { CalendarProvider } from '../../src/calendar/types.js';
import { buildInboundCallSessionOptions } from '../../src/inbound/callSessionAdapter.js';
import type { InboundCall } from '../../src/inbound/schema.js';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';

const updateInboundCall = vi.fn<(...args: unknown[]) => Promise<InboundCall>>(async () => ({}) as InboundCall);
vi.mock('../../src/inbound/service.js', () => ({
  updateInboundCall: (...args: unknown[]) => updateInboundCall(...args),
}));

const { buildInboundCallSessionOptions: buildOpts } = await import('../../src/inbound/callSessionAdapter.js');

const fakeInboundCall = { id: 'inbound-call-1', twilioCallSid: 'CA-inbound-1' } as InboundCall;

const fakeTelephony: TelephonyProvider = {
  name: 'fake-telephony',
  nativeAudioFormat: 'g711_ulaw_8k',
  originateCall: vi.fn(async () => ({ providerCallId: 'CA-fake-sid' })),
  sendAudio: vi.fn(),
  sendDigits: vi.fn(async () => {}),
  interrupt: vi.fn(),
  hangUp: vi.fn(async () => {}),
  on: vi.fn(),
  off: vi.fn(),
};

const fakeCalendar: CalendarProvider = {
  computeCandidateWindows: vi.fn(async () => []),
  isFree: vi.fn(async () => true),
  createEventIdempotent: vi.fn(async () => ({
    eventId: 'evt-1',
    confirmedStart: '2026-08-11T18:00:00.000Z',
    confirmedEnd: '2026-08-11T18:30:00.000Z',
  })),
  deleteEvent: vi.fn(async () => {}),
};

function buildOptions() {
  return buildOpts({
    inboundCall: fakeInboundCall,
    callerPhoneNumber: '+15555550100',
    telephony: fakeTelephony,
    calendar: fakeCalendar,
    systemPrompt: 'irrelevant for this test',
  });
}

describe('buildInboundCallSessionOptions', () => {
  it('wires up the non-empty inbound tool set', () => {
    const options = buildOptions();
    expect(options.tools.length).toBeGreaterThan(0);
    expect(options.tools.some((t) => t.name === 'book_appointment')).toBe(true);
    expect(options.tools.some((t) => t.name === 'find_my_booking')).toBe(true);
  });

  it('uses the Twilio CallSid as callId — no second id is minted', () => {
    const options = buildOptions();
    expect(options.callId).toBe('CA-inbound-1');
  });

  it('beginCall resolves the already-known providerCallId without originating anything', async () => {
    const options = buildOptions();
    const result = await options.beginCall();
    expect(result).toEqual({ providerCallId: 'CA-inbound-1' });
    expect(fakeTelephony.originateCall).not.toHaveBeenCalled();
  });

  it('buildToolContext returns an InboundCallContext keyed correctly, including the estimated audio-done timestamp', async () => {
    const options = buildOptions();
    const ctx = await options.buildToolContext(12345);
    expect(ctx).toEqual({
      inboundCallId: 'inbound-call-1',
      callId: 'CA-inbound-1',
      callerPhoneNumber: '+15555550100',
      telephony: fakeTelephony,
      calendar: fakeCalendar,
      estimatedAudioDoneAt: 12345,
    });
  });

  it('onStatusChange persists status=ended on the inbound call', async () => {
    updateInboundCall.mockClear();
    const options = buildOptions();
    await options.onStatusChange({ kind: 'ended', reason: 'stop' });
    expect(updateInboundCall).toHaveBeenCalledWith('inbound-call-1', { status: 'ended' });
  });

  it('onStatusChange persists status=error on failure', async () => {
    updateInboundCall.mockClear();
    const options = buildOptions();
    await options.onStatusChange({ kind: 'failed', reason: 'telephony_error' });
    expect(updateInboundCall).toHaveBeenCalledWith('inbound-call-1', { status: 'error' });
  });

  it('onStatusChange does not persist anything for started or answering_machine_detected (AMD is outbound-only)', async () => {
    updateInboundCall.mockClear();
    const options = buildOptions();
    await options.onStatusChange({ kind: 'started', providerCallId: 'CA-inbound-1' });
    await options.onStatusChange({ kind: 'answering_machine_detected', answeredBy: 'human' });
    expect(updateInboundCall).not.toHaveBeenCalled();
  });

  it('notifyIfTerminal is a no-op — inbound has no call-level outcome, each booking already notified inline', async () => {
    const options = buildOptions();
    await expect(options.notifyIfTerminal()).resolves.toBeUndefined();
  });

  it('onFailure is a no-op — status is already persisted via onStatusChange\'s failed case', async () => {
    updateInboundCall.mockClear();
    const options = buildOptions();
    await options.onFailure('some_reason');
    expect(updateInboundCall).not.toHaveBeenCalled();
  });
});
