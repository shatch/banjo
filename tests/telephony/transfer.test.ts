import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelephonyProvider } from '../../src/telephony/providers/types.js';

// transfer.ts reuses runToolSafely from callTools.ts, which imports the task
// service; stub it so nothing here reaches a DB.
vi.mock('../../src/tasks/service.js', () => ({ transitionTask: vi.fn(), isTerminalStatus: () => false }));

const { config } = await import('../../src/config/index.js');
const { defineTransferTool, transferAfterSpeaking, TRANSFER_TOOL_NAME } = await import('../../src/telephony/transfer.js');

function ctxWith(transferCall?: TelephonyProvider['transferCall'], estimatedAudioDoneAt = Date.now()) {
  return {
    callId: 'call-1',
    estimatedAudioDoneAt,
    telephony: { transferCall } as unknown as TelephonyProvider,
  };
}

beforeEach(() => {
  config.TRANSFER_TO_PHONE_NUMBER = '+15557654321';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('transferAfterSpeaking (#7)', () => {
  it('waits for the handoff line to finish playing, then transfers to the configured number', async () => {
    vi.useFakeTimers();
    const transferCall = vi.fn(async () => {});
    const done = transferAfterSpeaking(ctxWith(transferCall, Date.now() + 2000));

    await vi.advanceTimersByTimeAsync(1500);
    expect(transferCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(transferCall).toHaveBeenCalledWith('call-1', { to: '+15557654321' });
  });

  it('throws when the provider cannot transfer', async () => {
    await expect(transferAfterSpeaking(ctxWith(undefined))).rejects.toThrow(/transfer/i);
  });
});

describe('defineTransferTool (#7)', () => {
  it('is named transfer_to_owner, ends the call, and has no verbatim message', () => {
    const tool = defineTransferTool({ onTransferred: vi.fn(async () => {}) });
    expect(tool.name).toBe(TRANSFER_TOOL_NAME);
    expect(tool.endsCall).toBe(true);
    expect(tool.verbatimMessage).toBeUndefined();
    expect(tool.schema.safeParse({ reason: 'needs a card number' }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  it('records the transfer only after the redirect succeeds', async () => {
    const transferCall = vi.fn(async () => {});
    const onTransferred = vi.fn(async () => {});
    const tool = defineTransferTool({ onTransferred });

    const result = await tool.handler({ reason: 'needs a card number' }, ctxWith(transferCall));

    expect(result).toEqual({ ok: true });
    expect(onTransferred).toHaveBeenCalledWith({ reason: 'needs a card number' }, expect.objectContaining({ callId: 'call-1' }));
    expect(transferCall.mock.invocationCallOrder[0]).toBeLessThan(onTransferred.mock.invocationCallOrder[0]!);
  });

  it('returns transfer_failed and records nothing when the redirect fails (e.g. the callee already hung up)', async () => {
    const transferCall = vi.fn(async () => {
      throw new Error('transferCall: no live Twilio call for call-1');
    });
    const onTransferred = vi.fn(async () => {});
    const tool = defineTransferTool({ onTransferred });

    const result = await tool.handler({ reason: 'x' }, ctxWith(transferCall));

    expect(result).toMatchObject({ ok: false, error: 'transfer_failed' });
    expect(onTransferred).not.toHaveBeenCalled();
  });

  it('still reports success when recording it afterwards fails — the call has already been handed over', async () => {
    const tool = defineTransferTool({
      onTransferred: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const result = await tool.handler({ reason: 'x' }, ctxWith(vi.fn(async () => {})));
    expect(result).toEqual({ ok: true });
  });
});
