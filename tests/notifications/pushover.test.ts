import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked at fetch, Pushover's only way in.
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

let pushover: typeof import('../../src/notifications/pushover.js');
let owner: typeof import('../../src/notifications/owner.js');
let logger: typeof import('../../src/lib/logger.js').logger;

beforeAll(async () => {
  process.env.NOTIFICATION_CHANNEL = 'pushover';
  process.env.PUSHOVER_APP_TOKEN = 'app-token-123';
  process.env.PUSHOVER_USER_KEY = 'user-key-456';
  vi.resetModules();
  pushover = await import('../../src/notifications/pushover.js');
  owner = await import('../../src/notifications/owner.js');
  logger = (await import('../../src/lib/logger.js')).logger;
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const sentForm = (call = 0) => new URLSearchParams(String(fetchMock.mock.calls[call]![1].body));
const ok = () => new Response(JSON.stringify({ status: 1, request: 'r1' }), { status: 200 });

describe('sendPushover', () => {
  it('posts the token, user key, message, title and priority as a form', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await pushover.sendPushover({ message: 'Booked with Luigi', title: 'Banjo: booked' });

    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.pushover.net/1/messages.json');
    expect(fetchMock.mock.calls[0]![1].method).toBe('POST');
    expect(Object.fromEntries(sentForm())).toEqual({
      token: 'app-token-123',
      user: 'user-key-456',
      message: 'Booked with Luigi',
      title: 'Banjo: booked',
      priority: '0',
    });
  });

  it('sends urgent messages at priority 1, and trims messages to Pushover’s 1024-character limit', async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await pushover.sendPushover({ message: 'x'.repeat(2000), urgent: true });

    expect(sentForm().get('priority')).toBe('1');
    expect(sentForm().get('message')).toHaveLength(1024);
  });

  it('logs a rejected request without retrying or throwing, and without logging the token', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 0, errors: ['user identifier is invalid'] }), { status: 400 }));

    await expect(pushover.sendPushover({ message: 'hi' })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ status: 400, errors: ['user identifier is invalid'] }), expect.any(String));
    expect(JSON.stringify(error.mock.calls)).not.toContain('app-token-123');
  });

  it('retries once, after the delay Pushover asks for, on a server error', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(ok());

    const sending = pushover.sendPushover({ message: 'hi' });
    await vi.advanceTimersByTimeAsync(pushover.RETRY_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await sending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the network fails twice', async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const sending = pushover.sendPushover({ message: 'hi' });
    await vi.advanceTimersByTimeAsync(pushover.RETRY_DELAY_MS);
    await expect(sending).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('with NOTIFICATION_CHANNEL=pushover', () => {
  it('sends call outcomes through Pushover, urgent when they need attention', async () => {
    fetchMock.mockResolvedValue(ok());
    const channel = owner.createNotificationChannel();

    await channel.notify('task-1', { kind: 'confirmed', start: '2026-09-25T15:00:00.000Z', durationMinutes: 30 } as never, 'Booked with Luigi');
    await channel.notify('task-2', { kind: 'escalated', reason: 'asked for a card number' } as never, 'Got stuck calling Luigi');

    expect(sentForm(0).get('title')).toBe('Banjo: booked');
    expect(sentForm(0).get('priority')).toBe('0');
    expect(sentForm(1).get('title')).toBe('Banjo: needs your attention');
    expect(sentForm(1).get('priority')).toBe('1');
  });

  it('sends direct messages to the owner through Pushover too', async () => {
    fetchMock.mockResolvedValue(ok());

    await owner.sendOwnerMessage('Inbound call needs your attention', { urgent: true });

    expect(sentForm().get('message')).toBe('Inbound call needs your attention');
    expect(sentForm().get('priority')).toBe('1');
  });
});
