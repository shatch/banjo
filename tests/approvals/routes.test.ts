import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTask, approveTask, getContact, triggerOrchestration } = vi.hoisted(() => ({
  getTask: vi.fn(),
  approveTask: vi.fn(),
  getContact: vi.fn(),
  triggerOrchestration: vi.fn(),
}));
vi.mock('../../src/tasks/service.js', () => ({ getTask, approveTask }));
vi.mock('../../src/contacts/service.js', () => ({ getContact }));
vi.mock('../../src/tasks/orchestrator.js', () => ({ triggerOrchestration }));
const { addressBookNameFor } = vi.hoisted(() => ({ addressBookNameFor: vi.fn(async (): Promise<string | undefined> => undefined) }));
vi.mock('../../src/googleContacts/lookup.js', () => ({ addressBookNameFor }));

const { approvalRoutes } = await import('../../src/approvals/routes.js');
const { approvalSignature } = await import('../../src/approvals/link.js');

const ID = '11111111-1111-1111-1111-111111111111';
const EXPIRES = new Date(Date.now() + 20 * 60_000);
const SIG = approvalSignature(ID, EXPIRES);

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    contactId: 'c1',
    status: 'pending',
    goalDescription: 'Book <b>Friday</b> "at 7"',
    mode: 'booking',
    questions: null,
    scheduledFor: null,
    approvalExpiresAt: EXPIRES,
    approvedAt: null,
    constraints: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getTask.mockResolvedValue(task());
  getContact.mockResolvedValue({ displayName: 'Salon <i>', phoneNumber: '+15550001111' });
});

describe('GET /approve/:taskId', () => {
  it('shows the request with what the agent wrote escaped, and changes nothing', async () => {
    const res = await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Book &lt;b&gt;Friday&lt;/b&gt; &quot;at 7&quot;');
    expect(html).not.toContain('<b>Friday');
    expect(html).toContain('Salon &lt;i&gt; (+15550001111)');
    expect(html).toContain(`name="sig" value="${SIG}"`);
    expect(html).toContain(`action="/approve/${ID}"`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(approveTask).not.toHaveBeenCalled();
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });

  it('shows why call screening held it, escaped, and who asked (#150)', async () => {
    getTask.mockResolvedValue(task({ requestedByAgent: false, screenFlag: "Banjo's screening flagged it: <script>x</script>" }));
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text();
    expect(html).toContain('<dt>Held by call screening</dt><dd>Banjo&#39;s screening flagged it: &lt;script&gt;x&lt;/script&gt;</dd>');
    expect(html).toContain('<dt>What was asked for</dt>');
    expect(html).not.toContain('What the agent asked for');
  });

  it("lists an ask call's questions", async () => {
    getTask.mockResolvedValue(task({ mode: 'ask', questions: ['Open <Sunday>?'] }));
    expect(await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text()).toContain('1. Open &lt;Sunday&gt;?');
  });

  it.each([
    ['a wrong sig', `/approve/${ID}?sig=${'0'.repeat(64)}`, task()],
    ['no sig', `/approve/${ID}`, task()],
    ['a task that never needed approval', `/approve/${ID}?sig=${SIG}`, task({ approvalExpiresAt: null })],
    ['an unknown task', `/approve/${ID}?sig=${SIG}`, undefined],
    ['a malformed id', `/approve/not-a-uuid?sig=${SIG}`, task()],
  ])('shows the same invalid-link page for %s', async (_label, path, row) => {
    getTask.mockResolvedValue(row);
    const res = await approvalRoutes.request(path);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('This link isn’t valid');
  });

  it('says plainly when the scheduled time has passed', async () => {
    getTask.mockResolvedValue(task({ scheduledFor: new Date(Date.now() - 12 * 60_000) }));
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text();
    expect(html).toMatch(/12 minutes ago: approving calls now/);
  });

  it.each([
    ['already approved', task({ approvedAt: new Date() }), /already approved/i],
    ['cancelled', task({ status: 'cancelled' }), /cancelled/i],
    ['expired', task({ approvalExpiresAt: new Date(Date.now() - 1000) }), /expired/i],
  ])('offers no button once %s', async (_label, row, text) => {
    getTask.mockResolvedValue(row);
    const sig = approvalSignature(ID, row.approvalExpiresAt as Date);
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${sig}`)).text();
    expect(html).toMatch(text);
    expect(html).not.toContain('<button');
  });
});

describe('POST /approve/:taskId', () => {
  const post = (sig: string) =>
    approvalRoutes.request(`/approve/${ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sig }).toString(),
    });

  it('approves and starts the call', async () => {
    approveTask.mockResolvedValue('approved');
    const res = await post(SIG);
    expect(res.status).toBe(200);
    expect(approveTask).toHaveBeenCalledWith(ID);
    expect(triggerOrchestration).toHaveBeenCalledWith(ID);
    expect(await res.text()).toMatch(/Approved/);
  });

  it.each([
    ['already_approved', /already approved/i],
    ['expired', /expired/i],
    ['not_waiting', /cancelled/i],
  ])('reports %s without starting a call', async (outcome, text) => {
    approveTask.mockResolvedValue(outcome);
    const res = await post(SIG);
    expect(await res.text()).toMatch(text);
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });

  it('refuses a bad sig without touching the task', async () => {
    const res = await post('0'.repeat(64));
    expect(res.status).toBe(404);
    expect(approveTask).not.toHaveBeenCalled();
  });
});

describe('the page shows everything the call will use', () => {
  it("shows the task's notes, time windows, length and hold limit, escaped", async () => {
    getTask.mockResolvedValue(
      task({
        constraints: {
          notes: 'Say <yes> to anything',
          durationMinutes: 45,
          maxHoldMinutes: 20,
          dateWindows: [{ start: '2026-10-16T19:00:00.000Z', end: '2026-10-16T21:00:00.000Z' }],
        },
      }),
    );
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text();
    expect(html).toContain('Say &lt;yes&gt; to anything');
    expect(html).toContain('45 minutes');
    expect(html).toContain('20 minutes');
    expect(html).toMatch(/Oct 16, 2026, 3:00\s?PM/);
  });

  it("shows the contact's own notes, which every call to them uses", async () => {
    getContact.mockResolvedValue({ displayName: 'Salon', phoneNumber: '+15550001111', notes: 'Ask for <Dana>' });
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text();
    expect(html).toContain('Ask for &lt;Dana&gt;');
  });
});

describe('the page says what the owner can and can\'t trust about the contact', () => {
  it('marks a name that is not from the address book', async () => {
    getContact.mockResolvedValue({ displayName: 'Mom', phoneNumber: '+15550001111', googleResourceName: null });
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text();
    expect(html).toContain('<dt>Who (name typed in, not from your address book)</dt><dd>Mom (+15550001111)</dd>');
  });

  it('says a family contact may hear about the owner from their profile', async () => {
    getContact.mockResolvedValue({ displayName: 'Mom', phoneNumber: '+15550001111', googleResourceName: 'people/c1', relationshipTier: 'family' });
    addressBookNameFor.mockResolvedValueOnce('Mom');
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text();
    expect(html).toContain('<dt>Who (from your address book)</dt><dd>Mom (+15550001111)</dd>');
    expect(html).not.toContain('Name saved in Banjo');
    expect(html).toContain('Tagged family: on this call Banjo may answer their questions about you from your profile.');
  });

  it("vouches only for the address book's own name, and shows the typed-in one separately", async () => {
    getContact.mockResolvedValue({ displayName: "Dr. Smith's office", phoneNumber: '+15550001111', googleResourceName: 'people/c1' });
    addressBookNameFor.mockResolvedValueOnce('Jane Hatch');
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text();
    expect(html).toContain('<dt>Who (from your address book)</dt><dd>Jane Hatch (+15550001111)</dd>');
    expect(html).toContain('<dt>Name saved in Banjo, typed in (used on the call)</dt><dd>Dr. Smith&#39;s office</dd>');
  });

  it('drops invisible direction and zero-width marks', async () => {
    getTask.mockResolvedValue(task({ goalDescription: 'Book \u202Eevil\u200B' }));
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${SIG}`)).text();
    expect(html).toContain('Book evil');
    expect(html).not.toMatch(/[\u200B\u202E]/);
  });
});

describe('GET /approve/:taskId when the request is no longer waiting', () => {
  it.each([
    ['already approved', { approvedAt: new Date() }, 'Already approved.'],
    ['cancelled', { status: 'cancelled' }, 'This request was cancelled'],
    ['expired', { approvalExpiresAt: new Date(Date.now() - 60_000) }, 'This request expired'],
  ])('shows no Approve button when %s', async (_label, overrides, text) => {
    const expires = (overrides as { approvalExpiresAt?: Date }).approvalExpiresAt ?? EXPIRES;
    getTask.mockResolvedValue(task(overrides));
    const html = await (await approvalRoutes.request(`/approve/${ID}?sig=${approvalSignature(ID, expires)}`)).text();
    expect(html).toContain(text);
    expect(html).not.toContain('<form');
  });
});

describe('POST /approve/:taskId when the request is no longer waiting', () => {
  it.each([
    ['expired', 'This request expired'],
    ['already_approved', 'This call was already approved.'],
    ['not_waiting', 'This request was cancelled'],
  ])('reports %s and starts nothing', async (result, text) => {
    approveTask.mockResolvedValue(result);
    const res = await approvalRoutes.request(`/approve/${ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `sig=${SIG}`,
    });
    expect(await res.text()).toContain(text);
    expect(triggerOrchestration).not.toHaveBeenCalled();
  });
});
