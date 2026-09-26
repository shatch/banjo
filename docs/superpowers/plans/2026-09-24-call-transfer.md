# Call Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Banjo cold-transfer a live call (outbound or inbound) to the principal's phone, behind `TRANSFER_ENABLED`.

**Architecture:** A REST redirect of the live Twilio call to `<Dial>` TwiML (`TwilioProvider.transferCall`), a `<Dial action>` callback that records whether the principal answered and plays a fallback line when they didn't, and one shared tool definition (`src/telephony/transfer.ts`) that each direction wires to its own record-keeping. The tool and its prompt rules exist only when the flag is on.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Hono, Twilio Node SDK (`twilio.twiml.VoiceResponse` for TwiML), Drizzle + Postgres, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-call-transfer-design.md`

## Global Constraints

- Branch: `feat/call-transfer` (already created, spec committed).
- Boolean env vars use `z.enum(['true','false']).default('false').transform((v) => v === 'true')`, never `z.coerce.boolean()`.
- `TRANSFER_ENABLED` default `'false'`. `TRANSFER_TO_PHONE_NUMBER` is E.164, required only when enabled. `TRANSFER_FALLBACK_MESSAGE` default: `Sorry, they couldn't be reached right now. They'll get back to you soon. Goodbye.`
- Tool name: `transfer_to_owner`, schema `{ reason: string }`. No `verbatimMessage`. `endsCall: true`.
- Dial TwiML: `timeout="20"`, `answerOnBridge="true"`, `action="https://${PUBLIC_HOSTNAME}/telephony/twilio/transfer-callback?callId=${callId}"`. Nothing after `<Dial>`.
- `TransferResult` values: `'answered' | 'no_answer' | 'busy' | 'failed'`.
- `transitionTask` stays the only writer of task status/outcome. The outbound transition to `transferred` happens only after the redirect succeeds.
- Forget the call in `TwilioProvider` only after a successful redirect (not in `finally`).
- Never log TwiML bodies at `info`; they can contain the principal's number.
- DB-backed tests use `banjo_test` and clear every table they write before each test and after the last.
- Never combine `git commit` and `git push` in one command.

## Review Focus

1. **The callee hangs up while Banjo says the handoff line.** `transferCall` finds no live call and throws. Expect `transfer_failed`, no `transferred` status, and the task ends `failed` through the normal end-of-call path. (Task 5 test.)
2. **CallSession's teardown `hangUp()` runs after a successful transfer.** It must be a no-op, not hang up the bridged call. (Task 3 test.)
3. **A failed redirect.** The call must stay registered so Banjo can keep talking and escalate. (Task 3 test.)
4. **A callback for an inbound call.** Its `callId` is a Twilio CallSid, not a UUID. Recording the result must not throw a Postgres "invalid input syntax for type uuid" error, and the caller must still get TwiML. (Task 2 and Task 4 tests.)
5. **A fallback message with XML special characters** (`&`, `<`, `"`, as in "Smith & Sons"). It must be escaped, not break the TwiML. (Task 3 test.)

---

### Task 1: Config flags

**Files:**
- Modify: `src/config/index.ts` (add fields after `INBOUND_BOOKING_ENABLED`'s block; add a `.refine()` after the `NOTIFICATION_CHANNEL` refine)
- Modify: `.env.example` (new block after the call-recording block)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `config.TRANSFER_ENABLED: boolean`, `config.TRANSFER_TO_PHONE_NUMBER: string | undefined`, `config.TRANSFER_FALLBACK_MESSAGE: string`.

- [ ] **Step 1: Write the failing tests**

In `tests/config.test.ts`, add `'TRANSFER_ENABLED', 'TRANSFER_TO_PHONE_NUMBER', 'TRANSFER_FALLBACK_MESSAGE'` to `ALL_CONFIG_KEYS`, then add inside `describe('config: env schema', ...)`:

```ts
  describe('call transfer (#7)', () => {
    it('is off by default and needs no number', async () => {
      setEnv({});
      const { config } = await import('../src/config/index.js');
      expect(config.TRANSFER_ENABLED).toBe(false);
      expect(config.TRANSFER_FALLBACK_MESSAGE).toMatch(/couldn't be reached/);
    });

    it('requires TRANSFER_TO_PHONE_NUMBER when enabled', async () => {
      setEnv({ TRANSFER_ENABLED: 'true' });
      await expect(import('../src/config/index.js')).rejects.toThrow(/TRANSFER_TO_PHONE_NUMBER/);
    });

    it('accepts an E.164 number when enabled, and rejects one without its +', async () => {
      setEnv({ TRANSFER_ENABLED: 'true', TRANSFER_TO_PHONE_NUMBER: '+15557654321' });
      const { config } = await import('../src/config/index.js');
      expect(config.TRANSFER_ENABLED).toBe(true);
      expect(config.TRANSFER_TO_PHONE_NUMBER).toBe('+15557654321');

      vi.resetModules();
      setEnv({ TRANSFER_ENABLED: 'true', TRANSFER_TO_PHONE_NUMBER: '15557654321' });
      await expect(import('../src/config/index.js')).rejects.toThrow();
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/config.test.ts -t "call transfer"`
Expected: FAIL (`config.TRANSFER_ENABLED` is `undefined`; the enabled-without-number case doesn't throw).

- [ ] **Step 3: Implement**

In `src/config/index.ts`, after the `INBOUND_BOOKING_ENABLED` field (`e164`, defined at the top of the file, is already `.optional()`):

```ts
    // Cold call transfer to the principal's phone (#7). Off by default: when
    // on, both the outbound and inbound tool lists gain transfer_to_owner and
    // the prompts gain the rule for when to use it (voice/systemPrompt.ts).
    TRANSFER_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Where a transfer rings. Fixed here, never chosen by the model, so a
    // callee can't talk Banjo into bridging them to an arbitrary number.
    TRANSFER_TO_PHONE_NUMBER: e164,
    // Said to the other party when the transfer isn't answered (declined,
    // busy, no answer), before hanging up.
    TRANSFER_FALLBACK_MESSAGE: z
      .string()
      .min(1)
      .default("Sorry, they couldn't be reached right now. They'll get back to you soon. Goodbye."),
```

After the `NOTIFICATION_CHANNEL` refine:

```ts
  .refine((v) => !v.TRANSFER_ENABLED || !!v.TRANSFER_TO_PHONE_NUMBER, {
    message: 'TRANSFER_TO_PHONE_NUMBER is required when TRANSFER_ENABLED=true',
    path: ['TRANSFER_TO_PHONE_NUMBER'],
  })
```

In `.env.example`, after `RECORDING_RETENTION_DAYS=30`:

```
# --- Call transfer (optional) ---
# Lets Banjo hand a live call to you when the other party needs you personally and agrees to be
# connected. Off by default. Cold transfer: Banjo drops off once your phone starts ringing.
TRANSFER_ENABLED=false
# Your phone, E.164. Required when TRANSFER_ENABLED=true. (Left commented: an empty value fails E.164 validation.)
# TRANSFER_TO_PHONE_NUMBER=+15551234567
# What the other party hears if you don't pick up, before the call ends.
# TRANSFER_FALLBACK_MESSAGE=Sorry, they couldn't be reached right now. They'll get back to you soon. Goodbye.
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/config/index.ts .env.example tests/config.test.ts
git commit -m "feat(transfer): TRANSFER_ENABLED, TRANSFER_TO_PHONE_NUMBER, TRANSFER_FALLBACK_MESSAGE config (#7)"
```

---

### Task 2: Data model, outcome summary, `recordTransferResult`

**Files:**
- Modify: `src/tasks/schema.ts` (enum, `TaskOutcome`, `callAttempts`)
- Create: `drizzle/0004_*.sql` (generated) and `drizzle/meta/*` updates
- Modify: `src/tasks/service.ts` (add `recordTransferResult`)
- Modify: `src/notifications/channel.ts` (`buildOutcomeSummary` case)
- Test: `tests/tasks/service.db.test.ts`, `tests/notifications/channel.test.ts`

**Interfaces:**
- Produces:
  - `Task['status']` includes `'transferred'`.
  - `TaskOutcome` includes `{ kind: 'transferred'; reason: string }`.
  - `export type TransferResult = 'answered' | 'no_answer' | 'busy' | 'failed';` in `src/tasks/schema.ts`.
  - `callAttempts.transferResult` (`transfer_result`, nullable text typed `TransferResult`).
  - `export async function recordTransferResult(callId: string, result: TransferResult): Promise<boolean>` in `src/tasks/service.ts`. Returns true if a call attempt was updated. Returns false, without querying, for a non-UUID `callId` (an inbound CallSid).

- [ ] **Step 1: Write the failing tests**

Append to `tests/tasks/service.db.test.ts`:

```ts
describe('recordTransferResult (#7)', () => {
  it("records the dial result on the call attempt, and ignores ids that aren't call attempts", async () => {
    const [contact] = await db.insert(contacts).values({ displayName: 'Salon', phoneNumber: '+15551230004' }).returning();
    const task = await service.createTask({ contactId: contact.id, channel: 'phone', goalDescription: 'Call', constraints: {} });
    const attempt = await service.createCallAttempt(task.id);

    expect(await service.recordTransferResult(attempt.id, 'no_answer')).toBe(true);
    expect((await service.latestCallAttemptFor(task.id))?.transferResult).toBe('no_answer');

    // An inbound call's id is a Twilio CallSid, not a UUID: no query, no throw.
    expect(await service.recordTransferResult('CA0123456789abcdef', 'answered')).toBe(false);
    // A UUID that matches nothing.
    expect(await service.recordTransferResult('00000000-0000-0000-0000-000000000000', 'answered')).toBe(false);
  });

  it("'transferred' is a terminal status", async () => {
    expect(service.isTerminalStatus('transferred')).toBe(true);
  });
});
```

In `tests/notifications/channel.test.ts`, add (reuse that file's existing contact fixture, or `{ displayName: "Luigi's" } as Contact` as below):

```ts
it('summarizes a transfer (#7)', () => {
  const summary = buildOutcomeSummary({ displayName: "Luigi's" } as Contact, { kind: 'transferred', reason: 'they need a card number' });
  expect(summary).toBe("Transferred Luigi's to you — they need a card number.");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tasks/service.db.test.ts tests/notifications/channel.test.ts`
Expected: FAIL. TypeScript types are erased by vitest, so the failures are `service.recordTransferResult is not a function`, and the summary returning `undefined`.

- [ ] **Step 3: Implement the schema**

In `src/tasks/schema.ts`:
- Add `'transferred', // (phone path) handed to the principal via transfer_to_owner (#7)` to `taskStatusEnum`, after `'conversation_completed'`.
- Add `| { kind: 'transferred'; reason: string }` to `TaskOutcome`.
- Add above `callAttempts`:

```ts
/** How a transfer_to_owner dial ended, from Twilio's <Dial action> callback (#7). */
export type TransferResult = 'answered' | 'no_answer' | 'busy' | 'failed';
```

- In `callAttempts`, after `recordingSid`:

```ts
  // How a transfer to the principal ended (#7), from Twilio's <Dial action>
  // callback; null when the call wasn't transferred. Call mechanics, like
  // `disclosed`: the task's outcome is already 'transferred' by then.
  transferResult: text('transfer_result').$type<TransferResult>(),
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0004_<name>.sql` containing `ALTER TYPE "public"."task_status" ADD VALUE 'transferred'` and `ALTER TABLE "call_attempts" ADD COLUMN "transfer_result" text`. Open it and check that it contains nothing else.

Apply it to the test database: `DATABASE_URL=postgresql://banjo:banjo@localhost:5432/banjo_test npx drizzle-kit migrate` (the README's "Test database" section has the exact command if this differs).

- [ ] **Step 5: Implement `recordTransferResult` and the summary**

In `src/tasks/service.ts` (after `updateCallAttempt`), importing `TransferResult` from `./schema.js`:

```ts
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records how a transfer_to_owner dial ended (#7). `callId` is whatever the
 * transfer callback was given: a call attempt id for an outbound call, or a
 * Twilio CallSid for an inbound one, which has no call attempt. Returns
 * whether a call attempt was updated.
 */
export async function recordTransferResult(callId: string, result: TransferResult): Promise<boolean> {
  if (!UUID_PATTERN.test(callId)) return false;
  const rows = await db.update(callAttempts).set({ transferResult: result }).where(eq(callAttempts.id, callId)).returning({ id: callAttempts.id });
  return rows.length > 0;
}
```

In `src/notifications/channel.ts`'s `buildOutcomeSummary` switch:

```ts
    case 'transferred':
      return `Transferred ${contact.displayName} to you — ${outcome.reason}.`;
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/tasks/service.db.test.ts tests/notifications/channel.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean. If typecheck flags an exhaustive `switch` on `TaskOutcome['kind']` or `Task['status']` elsewhere, add the `transferred` case there as well, with wording that matches its neighbors.

- [ ] **Step 7: Commit**

```bash
git add src/tasks/schema.ts src/tasks/service.ts src/notifications/channel.ts drizzle tests/tasks/service.db.test.ts tests/notifications/channel.test.ts
git commit -m "feat(transfer): transferred status, transfer_result column, recordTransferResult (#7)"
```

---

### Task 3: `TwilioProvider.transferCall` and callback TwiML

**Files:**
- Modify: `src/telephony/providers/types.ts` (interface method)
- Modify: `src/telephony/providers/twilio.ts` (`TwilioCallState.recordingSid`, `startRecording` stores it, `transferCall`, `buildTransferCallbackTwiml`)
- Test: `tests/telephony/twilio.test.ts`

**Interfaces:**
- Consumes: `config.PUBLIC_HOSTNAME`, `config.TRANSFER_FALLBACK_MESSAGE` (Task 1), `TransferResult` (Task 2).
- Produces:
  - `TelephonyProvider.transferCall?(callId: string, opts: { to: string }): Promise<void>`
  - `TwilioProvider.buildTransferCallbackTwiml(result: TransferResult): string`

- [ ] **Step 1: Write the failing tests**

Append to `tests/telephony/twilio.test.ts`:

```ts
describe('TwilioProvider.transferCall (#7)', () => {
  function withFakeCalls(provider: TwilioProvider, update = vi.fn(async () => ({})), recordingUpdate = vi.fn(async () => ({}))) {
    const recordings = Object.assign(vi.fn(() => ({ update: recordingUpdate })), { create: vi.fn(async () => ({ sid: 'RE-live' })) });
    const calls = vi.fn(() => ({ update, recordings }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty((provider as any).client, 'calls', { value: calls, configurable: true });
    return { update, recordingUpdate, calls };
  }

  it('redirects the live call to a <Dial> with an action callback and nothing after it', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-1', '+15555550100');
    const { update } = withFakeCalls(provider);

    await provider.transferCall('CA-1', { to: '+15557654321' });

    const twiml = (update.mock.calls[0] as unknown as [{ twiml: string }])[0].twiml;
    expect(twiml).toMatch(/<Dial[^>]*timeout="20"/);
    expect(twiml).toMatch(/<Dial[^>]*answerOnBridge="true"/);
    expect(twiml).toMatch(/action="https:\/\/[^"]+\/telephony\/twilio\/transfer-callback\?callId=CA-1"/);
    expect(twiml).toContain('<Number>+15557654321</Number>');
    expect(twiml).toMatch(/<\/Dial><\/Response>$/);
  });

  it('stops a running recording before transferring', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-2', '+15555550100');
    const { update, recordingUpdate, calls } = withFakeCalls(provider);
    await provider.startRecording('CA-2');

    await provider.transferCall('CA-2', { to: '+15557654321' });

    expect(recordingUpdate).toHaveBeenCalledWith({ status: 'stopped' });
    expect(recordingUpdate.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
    expect(calls).toHaveBeenCalledWith('CA-2');
  });

  it('still transfers when stopping the recording fails', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-3', '+15555550100');
    const { update } = withFakeCalls(provider, undefined, vi.fn(async () => { throw new Error('recording gone'); }));
    await provider.startRecording('CA-3');

    await provider.transferCall('CA-3', { to: '+15557654321' });
    expect(update).toHaveBeenCalled();
  });

  it('forgets the call after a successful redirect, so the session teardown hangUp() cannot end the bridged call', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-4', '+15555550100');
    const { update } = withFakeCalls(provider);

    await provider.transferCall('CA-4', { to: '+15557654321' });
    expect(provider.isAnyCallActive()).toBe(false);

    await provider.hangUp('CA-4');
    expect(update).toHaveBeenCalledTimes(1); // the redirect only, no { status: 'completed' }
  });

  it('keeps the call when the redirect fails, so Banjo can keep talking', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-5', '+15555550100');
    withFakeCalls(provider, vi.fn(async () => { throw new Error('twilio 500'); }));

    await expect(provider.transferCall('CA-5', { to: '+15557654321' })).rejects.toThrow('twilio 500');
    expect(provider.isAnyCallActive()).toBe(true);
  });

  it('refuses a call it has no Twilio id for', async () => {
    await expect(new TwilioProvider().transferCall('nope', { to: '+15557654321' })).rejects.toThrow();
  });

  it('never logs the TwiML (it holds the principal\'s number)', async () => {
    const provider = new TwilioProvider();
    provider.registerInboundCall('CA-6', '+15555550100');
    withFakeCalls(provider);
    fakeLog.info.mockClear();
    await provider.transferCall('CA-6', { to: '+15557654321' });
    expect(JSON.stringify(fakeLog.info.mock.calls)).not.toContain('+15557654321');
  });
});

describe('TwilioProvider.buildTransferCallbackTwiml (#7)', () => {
  it('just hangs up after an answered transfer', () => {
    const twiml = new TwilioProvider().buildTransferCallbackTwiml('answered');
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('<Say');
  });

  it('says the fallback message, XML-escaped, then hangs up when not answered', async () => {
    const { config } = await import('../../src/config/index.js');
    const original = config.TRANSFER_FALLBACK_MESSAGE;
    config.TRANSFER_FALLBACK_MESSAGE = 'Smith & Sons <will> call "back"';
    try {
      const twiml = new TwilioProvider().buildTransferCallbackTwiml('no_answer');
      expect(twiml).toContain('Smith &amp; Sons &lt;will&gt; call');
      expect(twiml).toMatch(/<\/Say><Hangup\/><\/Response>$/);
    } finally {
      config.TRANSFER_FALLBACK_MESSAGE = original;
    }
  });
});
```

`registerInboundCall` sets `providerCallId` to the CallSid (`twilio.ts:216`), which is why these tests use it to get a live call with a Twilio id.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/telephony/twilio.test.ts -t "#7"`
Expected: FAIL (`provider.transferCall is not a function`).

- [ ] **Step 3: Implement**

In `src/telephony/providers/types.ts`, after `deleteRecording?`:

```ts
  /**
   * Cold-transfer a live call to `to` (#7): the call is redirected to dial
   * that number, and Banjo drops off it. Optional, like startRecording: a
   * provider without it can't transfer, and transfer_to_owner reports that.
   * Throws when the redirect fails; the call is then still Banjo's.
   */
  transferCall?(callId: string, opts: { to: string }): Promise<void>;
```

In `src/telephony/providers/twilio.ts`:

1. Add `recordingSid?: string;` to `TwilioCallState`, with the comment `// set by startRecording, so transferCall can stop it (#7)`.
2. In `startRecording`, after `create` resolves: `const state = this.calls.get(callId); if (state) state.recordingSid = recording.sid;`
3. Import `TransferResult` as a type from `../../tasks/schema.js` (types only; no runtime dependency on the DB layer).
4. Add after `hangUp()`:

```ts
  /**
   * Cold transfer (#7). <Connect><Stream> is terminal TwiML, so a live call
   * can't <Dial> from inside itself: it's redirected over REST instead, the
   * same shape as hangUp(). Nothing follows the <Dial> — with an `action`,
   * Twilio runs the callback's TwiML instead (buildTransferCallbackTwiml).
   */
  async transferCall(callId: string, opts: { to: string }): Promise<void> {
    const state = this.calls.get(callId);
    if (!state?.providerCallId) throw new Error(`transferCall: no live Twilio call for ${callId}`);
    const call = this.client.calls(state.providerCallId);

    // The callee agreed to a recorded call with Banjo, not to recording the
    // principal's conversation once the call is bridged.
    if (state.recordingSid) {
      await call
        .recordings(state.recordingSid)
        .update({ status: 'stopped' })
        .catch((err: unknown) => logger.warn({ err, callId }, 'could not stop the recording before transfer — transferring anyway'));
    }

    const response = new twilioLib.twiml.VoiceResponse();
    const dial = response.dial({
      timeout: 20,
      answerOnBridge: true,
      action: `https://${config.PUBLIC_HOSTNAME}/telephony/twilio/transfer-callback?callId=${encodeURIComponent(callId)}`,
    });
    dial.number(opts.to);

    // Deliberately no TwiML (it holds the principal's number) in this log line.
    logger.info({ callId, providerCallId: state.providerCallId }, 'transferring this call via the Twilio REST API');
    await call.update({ twiml: response.toString() });

    // Only after success, unlike hangUp()'s finally: a failed redirect leaves
    // a call Banjo still has to talk on, and the stream's 'stop'/close
    // handlers forget it whenever it really ends. Forgetting now also makes
    // CallSession's teardown hangUp() a no-op, where it would otherwise hang
    // up the bridged call if it ran before Twilio's 'stop' arrives.
    this.clearInboundRegistrationTimeout(callId);
    this.forgetCall(callId);
  }

  /** The TwiML Twilio runs once a transfer's <Dial> ends (#7): hang up if the principal answered, else say the fallback line first. */
  buildTransferCallbackTwiml(result: TransferResult): string {
    const response = new twilioLib.twiml.VoiceResponse();
    if (result !== 'answered') response.say(config.TRANSFER_FALLBACK_MESSAGE);
    response.hangup();
    return response.toString();
  }
```

`VoiceResponse.toString()` output starts with `<?xml version="1.0" encoding="UTF-8"?>`; the tests only match the tail. If the SDK's `calls(sid).recordings(sid)` typing complains, look at how `deleteRecording` calls `this.client.recordings(...)` and match the SDK types there.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/telephony/twilio.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/telephony/providers/types.ts src/telephony/providers/twilio.ts tests/telephony/twilio.test.ts
git commit -m "feat(transfer): TwilioProvider.transferCall and callback TwiML (#7)"
```

---

### Task 4: Transfer callback route, and no TwiML in logs

**Files:**
- Modify: `src/server.ts` (`TwilioHttpHooks`, new route, the `serving TwiML for outbound call` log line)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `TwilioProvider.buildTransferCallbackTwiml` (Task 3), `recordTransferResult` and `TransferResult` (Task 2).
- Produces: `POST /telephony/twilio/transfer-callback?callId=…` returning `text/xml`.

- [ ] **Step 1: Write the failing tests**

In `tests/server.test.ts`:
- Add `const buildTransferCallbackTwiml = vi.fn((result: string) => (result === 'answered' ? '<Response><Hangup/></Response>' : '<Response><Say>fallback</Say><Hangup/></Response>'));` beside the other hook fakes, and add `buildTransferCallbackTwiml` to the `createTelephonyProvider` mock object.
- Add a mock for the service (keep it a factory so this suite never touches a DB):

```ts
const recordTransferResult = vi.fn(async (_callId: string, _result: string) => true);
vi.mock('../src/tasks/service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tasks/service.js')>()),
  recordTransferResult: (callId: string, result: string) => recordTransferResult(callId, result),
}));
```

If the file already mocks `../src/tasks/service.js`, add `recordTransferResult` to that mock instead of adding a second `vi.mock`.

Then add:

```ts
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
```

`tests/server.test.ts` doesn't capture logs today and imports the app at line 69 (`const { app } = await import('../src/server.js');`). Add this near the top of the file, above that import, copying the pattern from `tests/telephony/twilio.test.ts` lines 3–7:

```ts
const { fakeLog } = vi.hoisted(() => ({
  fakeLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));
vi.mock('../src/lib/logger.js', () => ({ childLogger: () => fakeLog, logger: fakeLog }));
```

If `src/server.ts` or anything it imports calls another export of `logger.js` (check `grep -n "from './lib/logger.js'\|from '../lib/logger.js'" -r src`), add that export to the mock too. For example, if anything calls `logger.child(...)`, give `child` a `mockReturnValue(fakeLog)`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/server.test.ts -t "#7"`
Expected: FAIL (404 for the new route; the log assertion fails).

- [ ] **Step 3: Implement**

In `src/server.ts`:
- Add `buildTransferCallbackTwiml(result: TransferResult): string;` to `TwilioHttpHooks`, importing `type TransferResult` from `./tasks/schema.js` and `recordTransferResult` from `./tasks/service.js`.
- Change `logger.info({ callId, twiml }, 'serving TwiML for outbound call');` to `logger.info({ callId, twimlLength: twiml.length }, 'serving TwiML for outbound call');`
- Add after the `amd-callback` route:

```ts
/** Twilio's DialCallStatus, as recorded on call_attempts.transfer_result. Anything unknown counts as failed. */
function transferResultFrom(dialCallStatus: unknown): TransferResult {
  switch (dialCallStatus) {
    case 'completed':
    case 'answered':
      return 'answered';
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
  const result = transferResultFrom(body.DialCallStatus);
  try {
    const recorded = await recordTransferResult(callId, result);
    logger.info({ callId, result, recorded }, 'transfer dial ended');
  } catch (err) {
    logger.error({ err, callId, result }, 'could not record the transfer result');
  }
  return c.body(telephony.buildTransferCallbackTwiml(result), 200, { 'Content-Type': 'text/xml' });
});
```

The inbound `logger.info({ callSid, from }, 'serving TwiML for inbound call')` doesn't log the body, so leave it.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/server.test.ts tests/server.twilioSignature.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(transfer): transfer-callback route; stop logging TwiML bodies (#7)"
```

---

### Task 5: The shared transfer tool (`src/telephony/transfer.ts`)

**Files:**
- Modify: `src/voice/tools/callTools.ts` (export `waitForPlayback`, used by `hangUpAfterSpeaking`)
- Create: `src/telephony/transfer.ts`
- Test: `tests/telephony/transfer.test.ts`, plus the existing `tests/voice/callTools.test.ts` (unchanged behavior)

**Interfaces:**
- Consumes: `TelephonyProvider.transferCall` (Task 3), `config.TRANSFER_TO_PHONE_NUMBER` (Task 1), `runToolSafely` and `defineVoiceTool`.
- Produces:
  - `export async function waitForPlayback(ctx: { estimatedAudioDoneAt: number }): Promise<void>` in `callTools.ts`.
  - `export type TransferContext = { telephony: TelephonyProvider; callId: string; estimatedAudioDoneAt: number };`
  - `export async function transferAfterSpeaking(ctx: TransferContext): Promise<void>`
  - `export function defineTransferTool<Ctx extends TransferContext>(opts: { onTransferred: (input: { reason: string }, ctx: Ctx) => Promise<void> }): VoiceTool<{ reason: string }, Ctx>`
  - `export const TRANSFER_TOOL_NAME = 'transfer_to_owner';`

- [ ] **Step 1: Write the failing tests**

Create `tests/telephony/transfer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/telephony/transfer.test.ts`
Expected: FAIL (cannot find module `src/telephony/transfer.js`).

- [ ] **Step 3: Implement**

In `src/voice/tools/callTools.ts`, split `hangUpAfterSpeaking`:

```ts
/** Waits until the model's own trailing speech has played out (capped at MAX_HANGUP_WAIT_MS). Shared with telephony/transfer.ts. */
export async function waitForPlayback(ctx: { estimatedAudioDoneAt: number }): Promise<void> {
  const waitMs = Math.min(MAX_HANGUP_WAIT_MS, Math.max(0, ctx.estimatedAudioDoneAt - Date.now()) + HANGUP_SAFETY_MARGIN_MS);
  await sleep(waitMs);
}

export async function hangUpAfterSpeaking(ctx: { telephony: TelephonyProvider; callId: string; estimatedAudioDoneAt: number }): Promise<void> {
  await waitForPlayback(ctx);
  await ctx.telephony.hangUp(ctx.callId);
}
```

Create `src/telephony/transfer.ts`:

```ts
import { z } from 'zod';
import { config } from '../config/index.js';
import { childLogger } from '../lib/logger.js';
import { runToolSafely, waitForPlayback } from '../voice/tools/callTools.js';
import { defineVoiceTool, type VoiceTool } from '../voice/tools/defineVoiceTool.js';
import type { TelephonyProvider } from './providers/types.js';

const log = childLogger({ module: 'telephony.transfer' });

/**
 * transfer_to_owner — cold-transfer the live call to the principal (#7).
 *
 * Lives here, next to dtmf.ts, for the same reason press_digits does: the
 * transfer itself is phone signaling. What a transfer MEANS differs by
 * direction (an outbound task's outcome; a text about an inbound caller), so
 * each side builds its own tool from defineTransferTool with an
 * onTransferred hook — tasks/callSessionAdapter.ts and inbound/tools.ts.
 * Offered to the model only when TRANSFER_ENABLED is on.
 */
export const TRANSFER_TOOL_NAME = 'transfer_to_owner';

export type TransferContext = { telephony: TelephonyProvider; callId: string; estimatedAudioDoneAt: number };

/** Lets the handoff line finish ("connecting you now"), then redirects the call to TRANSFER_TO_PHONE_NUMBER. */
export async function transferAfterSpeaking(ctx: TransferContext): Promise<void> {
  if (!ctx.telephony.transferCall) throw new Error(`transfer: telephony provider ${ctx.telephony.name} cannot transfer calls`);
  if (!config.TRANSFER_TO_PHONE_NUMBER) throw new Error('transfer: TRANSFER_TO_PHONE_NUMBER is not set');
  await waitForPlayback(ctx);
  await ctx.telephony.transferCall(ctx.callId, { to: config.TRANSFER_TO_PHONE_NUMBER });
}

export function defineTransferTool<Ctx extends TransferContext>(opts: {
  onTransferred: (input: { reason: string }, ctx: Ctx) => Promise<void>;
}): VoiceTool<{ reason: string }, Ctx> {
  return defineVoiceTool<{ reason: string }, Ctx>({
    name: TRANSFER_TOOL_NAME,
    description: `Connect the other party to ${config.ASSISTANT_PRINCIPAL_NAME} directly, by phone. Use only when they need ${config.ASSISTANT_PRINCIPAL_NAME} personally and have said yes to being connected. Say one short handoff line first; you are off the call once this runs.`,
    schema: z.object({
      reason: z
        .string()
        .min(1)
        .describe(`Why they need ${config.ASSISTANT_PRINCIPAL_NAME}, e.g. "they need a card number to hold the table". Sent to ${config.ASSISTANT_PRINCIPAL_NAME}; not spoken to the other party.`),
    }),
    endsCall: true,
    handler: async (input, ctx: Ctx) => {
      return runToolSafely(TRANSFER_TOOL_NAME, async () => {
        try {
          await transferAfterSpeaking(ctx);
        } catch (err) {
          log.warn({ err, callId: ctx.callId }, 'transfer failed — the call is still ours');
          return { ok: false as const, error: 'transfer_failed' as const, message: err instanceof Error ? err.message : String(err) };
        }
        // The call is already with the principal, so a failure to record it
        // must not tell the model the transfer failed; it has no call to act on.
        try {
          await opts.onTransferred(input, ctx);
        } catch (err) {
          log.error({ err, callId: ctx.callId }, 'call transferred, but recording the transfer failed');
        }
        return { ok: true as const };
      });
    },
  });
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/telephony/transfer.test.ts tests/voice/callTools.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/voice/tools/callTools.ts src/telephony/transfer.ts tests/telephony/transfer.test.ts
git commit -m "feat(transfer): transfer_to_owner tool definition and wait-then-redirect (#7)"
```

---

### Task 6: Wire the tool into both directions, behind the flag

**Files:**
- Modify: `src/tasks/callSessionAdapter.ts` (`transferToOwnerTool`, `outboundToolsFor`)
- Modify: `src/inbound/tools.ts` (`inboundTransferToOwnerTool`, `inboundToolsFor`)
- Modify: `src/inbound/callSessionAdapter.ts` (`tools: inboundToolsFor()`)
- Test: `tests/tasks/callSessionAdapter.test.ts`, `tests/inbound/callSessionAdapter.test.ts`, `tests/inbound/tools.test.ts`

**Interfaces:**
- Consumes: `defineTransferTool`, `TRANSFER_TOOL_NAME` (Task 5); `transitionTask` and `'transferred'` (Task 2); `notifyTaskOutcome` (same file); `sendOwnerSms`.
- Produces: `export const transferToOwnerTool` (`callSessionAdapter.ts`); `export const inboundTransferToOwnerTool` and `export function inboundToolsFor(): VoiceTool<any, InboundCallContext>[]` (`inbound/tools.ts`).

- [ ] **Step 1: Write the failing tests**

In `tests/tasks/callSessionAdapter.test.ts`, add `notifyTaskOutcome`-reachable mocks if they're missing: the file already mocks `tasks/service.js` (`getTask`, `transitionTask`). Add:

```ts
describe('transfer_to_owner on outbound calls (#7)', () => {
  let config: typeof import('../../src/config/index.js').config;
  beforeEach(async () => {
    ({ config } = await import('../../src/config/index.js'));
    config.TRANSFER_TO_PHONE_NUMBER = '+15557654321';
  });
  afterEach(() => {
    config.TRANSFER_ENABLED = false;
  });

  const build = () =>
    buildOutboundCallSessionOptions({
      task: fakeTask, callAttempt: fakeCallAttempt, contact: fakeContact,
      telephony: fakeTelephony, calendar: fakeCalendar, systemPrompt: 'irrelevant',
    });

  it('is offered only when TRANSFER_ENABLED is on', () => {
    config.TRANSFER_ENABLED = false;
    expect(build().tools.map((t) => t.name)).not.toContain('transfer_to_owner');
    config.TRANSFER_ENABLED = true;
    expect(build().tools.map((t) => t.name)).toContain('transfer_to_owner');
  });

  it('records the task as transferred after the redirect succeeds', async () => {
    const { transferToOwnerTool } = await import('../../src/tasks/callSessionAdapter.js');
    const telephony = { ...fakeTelephony, transferCall: vi.fn(async () => {}) };
    const result = await transferToOwnerTool.handler(
      { reason: 'they need a card number' },
      { task: { id: 'task-1', status: 'negotiating' }, callId: 'call-attempt-1', telephony, estimatedAudioDoneAt: Date.now() } as never,
    );
    expect(result).toEqual({ ok: true });
    expect(transitionTask).toHaveBeenCalledWith('task-1', 'transferred', {
      outcome: { kind: 'transferred', reason: 'they need a card number' },
    });
  });

  it('leaves the task alone when the redirect fails', async () => {
    const { transferToOwnerTool } = await import('../../src/tasks/callSessionAdapter.js');
    const telephony = { ...fakeTelephony, transferCall: vi.fn(async () => { throw new Error('twilio 500'); }) };
    const result = await transferToOwnerTool.handler(
      { reason: 'x' },
      { task: { id: 'task-1', status: 'negotiating' }, callId: 'call-attempt-1', telephony, estimatedAudioDoneAt: Date.now() } as never,
    );
    expect(result).toMatchObject({ ok: false, error: 'transfer_failed' });
    expect(transitionTask).not.toHaveBeenCalled();
  });
});
```

The file's `fakeCalendar` may be named differently; use whatever calendar fake it already passes to `buildOutboundCallSessionOptions`. Clear `transitionTask` in a `beforeEach` (`vi.clearAllMocks()`) if the file doesn't already. `notifyTaskOutcome` calls `getTask`, which is mocked to return `undefined`, so it returns early. That's fine here.

In `tests/inbound/callSessionAdapter.test.ts`:

```ts
describe('transfer_to_owner on inbound calls (#7)', () => {
  it('is offered only when TRANSFER_ENABLED is on', async () => {
    const { config } = await import('../../src/config/index.js');
    const opts = () =>
      buildOpts({ inboundCall: fakeInboundCall, callerPhoneNumber: '+15555550100', telephony: fakeTelephony, calendar: fakeCalendar, systemPrompt: 'x' });
    try {
      config.TRANSFER_ENABLED = false;
      expect(opts().tools.map((t) => t.name)).not.toContain('transfer_to_owner');
      config.TRANSFER_ENABLED = true;
      config.TRANSFER_TO_PHONE_NUMBER = '+15557654321';
      expect(opts().tools.map((t) => t.name)).toContain('transfer_to_owner');
    } finally {
      config.TRANSFER_ENABLED = false;
    }
  });
});
```

In `tests/inbound/tools.test.ts` (which already mocks `sendOwnerSms`; check its top and reuse that mock's variable name):

```ts
describe('inbound transfer_to_owner (#7)', () => {
  it('texts the owner who is being put through, after the redirect succeeds', async () => {
    const { inboundTransferToOwnerTool } = await import('../../src/inbound/tools.js');
    const { config } = await import('../../src/config/index.js');
    config.TRANSFER_TO_PHONE_NUMBER = '+15557654321';
    const transferCall = vi.fn(async () => {});
    const result = await inboundTransferToOwnerTool.handler(
      { reason: 'wants to talk about an invoice' },
      { callId: 'CA-in-1', callerPhoneNumber: '+15555550100', telephony: { transferCall }, estimatedAudioDoneAt: Date.now() } as never,
    );
    expect(result).toEqual({ ok: true });
    expect(sendOwnerSms).toHaveBeenCalledWith('Transferring inbound caller +15555550100 to you — wants to talk about an invoice');
  });
});
```

Also update the existing test near `tests/inbound/tools.test.ts:579` that lists `inboundTools` names, if it asserts an exact list: `inboundTools` itself doesn't change, so it should still pass as-is.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tasks/callSessionAdapter.test.ts tests/inbound/callSessionAdapter.test.ts tests/inbound/tools.test.ts -t "#7"`
Expected: FAIL (`transferToOwnerTool` undefined; the tool is not in the lists).

- [ ] **Step 3: Implement outbound**

In `src/tasks/callSessionAdapter.ts` (imports: `config`, `defineTransferTool` from `../telephony/transfer.js`, `transitionTask` from `./service.js` if not already imported):

```ts
/**
 * transfer_to_owner for outbound calls (#7). Defined here rather than in
 * voice/tools/callTools.ts: recording it needs notifyTaskOutcome from this
 * file, and this file already imports callTools.ts.
 */
export const transferToOwnerTool = defineTransferTool<CallContext>({
  async onTransferred(input, ctx) {
    await transitionTask(ctx.task.id, 'transferred', { outcome: { kind: 'transferred', reason: input.reason } });
    await notifyTaskOutcome(ctx.task.id);
  },
});

function outboundToolsFor(task: Task): VoiceTool<any, CallContext>[] {
  const base: VoiceTool<any, CallContext>[] = [...callTools, pressDigitsTool];
  if (config.TRANSFER_ENABLED) base.push(transferToOwnerTool);
  return task.mode === 'conversation' ? [...base, endConversationCallTool] : base;
}
```

- [ ] **Step 4: Implement inbound**

In `src/inbound/tools.ts` (import `defineTransferTool` from `../telephony/transfer.js`):

```ts
/** transfer_to_owner for inbound calls (#7): no task to record, so the owner gets a text saying who is coming through. */
export const inboundTransferToOwnerTool = defineTransferTool<InboundCallContext>({
  async onTransferred(input, ctx) {
    await sendOwnerSms(`Transferring inbound caller ${ctx.callerPhoneNumber} to you — ${input.reason}`);
  },
});

/** The inbound tool list for this process's config: inboundTools, plus transfer_to_owner when TRANSFER_ENABLED is on. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function inboundToolsFor(): VoiceTool<any, InboundCallContext>[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return config.TRANSFER_ENABLED ? [...inboundTools, inboundTransferToOwnerTool as VoiceTool<any, InboundCallContext>] : inboundTools;
}
```

`sendOwnerSms` failing is already handled: `defineTransferTool` catches errors thrown by `onTransferred`.

In `src/inbound/callSessionAdapter.ts`, import `inboundToolsFor` instead of `inboundTools` and set `tools: inboundToolsFor(),`.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/tasks tests/inbound && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/tasks/callSessionAdapter.ts src/inbound/tools.ts src/inbound/callSessionAdapter.ts tests/tasks/callSessionAdapter.test.ts tests/inbound/callSessionAdapter.test.ts tests/inbound/tools.test.ts
git commit -m "feat(transfer): offer transfer_to_owner on outbound and inbound calls when enabled (#7)"
```

---

### Task 7: Prompt rule, only when enabled

**Files:**
- Modify: `src/voice/systemPrompt.ts` (`guidanceSections`)
- Test: `tests/voice/systemPrompt.test.ts`, `tests/tasks/promptBuilder.test.ts`

**Interfaces:**
- Consumes: `config.TRANSFER_ENABLED`. The tool name is written as the literal `'transfer_to_owner'` (see Step 3).
- Produces: a guidance section starting `Transferring to ${principal}:`, present in `buildBaseSystemPromptGuidance(direction)` and `buildFrontendSystemPromptGuidance(direction)` only when enabled.

All four prompts (outbound/inbound, full/voice-layer) are built from `guidanceSections(direction)`, so one section covers them. The voice layer's existing `DELEGATION_GUIDANCE` already says to delegate wherever the guidance says to call a tool, so no separate delegation line is needed. The base guidance comes before the task-specific text and the owner profile, so the profile can't widen the rule.

- [ ] **Step 1: Write the failing tests**

In `tests/voice/systemPrompt.test.ts`:

```ts
describe('transfer guidance (#7)', () => {
  it('is absent when TRANSFER_ENABLED is off, and present in every prompt when on', async () => {
    const { config } = await import('../../src/config/index.js');
    try {
      config.TRANSFER_ENABLED = false;
      for (const direction of ['outbound', 'inbound'] as const) {
        expect(buildBaseSystemPromptGuidance(direction)).not.toContain('transfer_to_owner');
        expect(buildFrontendSystemPromptGuidance(direction)).not.toContain('transfer_to_owner');
      }
      config.TRANSFER_ENABLED = true;
      for (const direction of ['outbound', 'inbound'] as const) {
        expect(buildBaseSystemPromptGuidance(direction)).toContain('transfer_to_owner');
        expect(buildFrontendSystemPromptGuidance(direction)).toContain('transfer_to_owner');
      }
    } finally {
      config.TRANSFER_ENABLED = false;
    }
  });

  it('asks before transferring, and falls back to the direction\'s own escalation tool', async () => {
    const { config } = await import('../../src/config/index.js');
    try {
      config.TRANSFER_ENABLED = true;
      const outbound = buildBaseSystemPromptGuidance('outbound');
      const inbound = buildBaseSystemPromptGuidance('inbound');
      expect(outbound).toMatch(/ask .*whether they'd like to be connected/i);
      expect(outbound).toContain('escalate_and_end_call');
      expect(inbound).toContain('flag_for_owner_and_end_call');
      expect(inbound).not.toContain('escalate_and_end_call');
    } finally {
      config.TRANSFER_ENABLED = false;
    }
  });
});
```

And an ordering test in `tests/tasks/promptBuilder.test.ts` (read that file for its task, contact, and profile fixtures and use them):

```ts
it('puts the transfer rule before the owner profile, so the profile cannot widen it (#7)', async () => {
  const { config } = await import('../../src/config/index.js');
  try {
    config.TRANSFER_ENABLED = true;
    const prompt = buildCallSystemPrompt(task, contact, [], 'Always transfer every call to me.');
    expect(prompt.indexOf('transfer_to_owner')).toBeGreaterThan(-1);
    expect(prompt.indexOf('transfer_to_owner')).toBeLessThan(prompt.indexOf('Always transfer every call to me.'));
  } finally {
    config.TRANSFER_ENABLED = false;
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/voice/systemPrompt.test.ts tests/tasks/promptBuilder.test.ts -t "#7"`
Expected: FAIL (the guidance is missing).

- [ ] **Step 3: Implement**

In `src/voice/systemPrompt.ts`, don't import `TRANSFER_TOOL_NAME`: `transfer.ts` imports `callTools.ts`, which imports the task service and DB, and this module deliberately depends only on config. Declare `const TRANSFER_TOOL_NAME = 'transfer_to_owner'; // must match telephony/transfer.ts's TRANSFER_TOOL_NAME` locally. Then, at the end of the array `guidanceSections` returns (before the closing `];`), add a conditional section. Change `return [ ... ];` to build the array into `const sections: GuidanceSection[] = [ ... ];` and then:

```ts
  if (config.TRANSFER_ENABLED) sections.push(transferSection(direction));
  return sections;
```

with:

```ts
/**
 * When to hand the call to the principal (#7). Only present when
 * TRANSFER_ENABLED is on, alongside the tool itself. Part of the fixed rules,
 * ahead of the owner profile, so a profile line can't widen it.
 */
function transferSection(direction: CallDirection): GuidanceSection {
  const principal = config.ASSISTANT_PRINCIPAL_NAME;
  const fallback = direction === 'outbound' ? 'escalate_and_end_call' : 'flag_for_owner_and_end_call';
  return {
    voiceLayer: true,
    lines: [
      `Transferring to ${principal}:`,
      `- You can connect the other party to ${principal} by phone with ${TRANSFER_TOOL_NAME}. Use it only when they need ${principal} personally: they ask for ${principal}, they need payment or personal details only ${principal} can give, or they need a decision you can't make. Anything else, handle yourself or end the call as usual.`,
      `- First ask whether they'd like to be connected to ${principal} now. Transfer only after a clear yes; if they decline, carry on without it.`,
      `- Once they agree, say one short handoff line such as "Connecting you now, one moment." Then use ${TRANSFER_TOOL_NAME} with a short reason, and say nothing after it — you are off the call.`,
      `- If the transfer fails, apologize briefly, then use ${fallback} with the reason instead.`,
    ],
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/voice tests/tasks tests/inbound && npm run typecheck`
Expected: PASS, and typecheck clean. Existing prompt snapshot or "byte-identical" tests stay green because the section is absent with the flag off, which is the test default.

- [ ] **Step 5: Commit**

```bash
git add src/voice/systemPrompt.ts tests/voice/systemPrompt.test.ts tests/tasks/promptBuilder.test.ts
git commit -m "feat(transfer): prompt rule for when to transfer, only when enabled (#7)"
```

---

### Task 8: Docs and the skill

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `README.md`, `docs/ROADMAP.md`, `CLAUDE.md`, `skills/schedule-appointment/SKILL.md`

No tests. This task only changes prose.

- [ ] **Step 1: `docs/ARCHITECTURE.md`**

Add a "Call transfer (#7)" section next to where DTMF/`press_digits` is described. It covers:
- The REST redirect, and why TwiML can't `<Dial>` from inside `<Connect><Stream>`.
- The `<Dial action>` callback and the fallback line.
- Why the call is forgotten only after a successful redirect, including that this stops the session teardown's `hangUp()` from ending the bridged call.
- Why there's no `TelephonyEvent` arm: the dial result arrives after the session is gone.
- That the recording stops at transfer, for consent.
- That the flag gates both the tool and the prompt rule.

- [ ] **Step 2: `README.md`**

- Replace the "**No call transfer.**" limitation bullet (around line 95) with a short description of the feature: cold transfer only, off by default.
- Add `TRANSFER_ENABLED`, `TRANSFER_TO_PHONE_NUMBER`, and `TRANSFER_FALLBACK_MESSAGE` to the configuration table or section, matching how `RECORD_CALLS` is documented.

- [ ] **Step 3: `docs/ROADMAP.md` item 2**

Mark cold transfer as shipped (PR link added at PR time). Keep warm transfer, and add "whisper to the principal before bridging" as the next step.

- [ ] **Step 4: `CLAUDE.md`**

In the Architecture list, after the `src/telephony/` bullet's `dtmf.ts` sentence, add: "`transfer.ts` defines `transfer_to_owner` (cold transfer via `TwilioProvider.transferCall`, a REST redirect to `<Dial>`), offered on both directions only when `TRANSFER_ENABLED`; each direction records it through its own `onTransferred` hook."

- [ ] **Step 5: `skills/schedule-appointment/SKILL.md`, section 6**

Add a bullet: "- A task with status `transferred`: Banjo handed the call to the principal. Say so, and that the result of that conversation isn't recorded."

- [ ] **Step 6: Commit**

```bash
git add docs/ARCHITECTURE.md README.md docs/ROADMAP.md CLAUDE.md skills/schedule-appointment/SKILL.md
git commit -m "docs(transfer): architecture, README, roadmap, skill (#7)"
```

---

### Task 9: Verify, live test, PR

- [ ] **Step 1: Full suite, typecheck, build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass (the 584 tests before this branch, plus the new ones), no type errors, and `dist/telephony/transfer.js` exists.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/call-transfer
```

Then `gh pr create` titled `feat: cold call transfer behind TRANSFER_ENABLED (#7)`, with a body that says what changed, lists the spec's deviations (no event arm, forget-on-success, the outbound tool's location), and ends with the attribution lines from the session's system reminder. Don't use "Closes #7" until the live check below passes; add it then.

- [ ] **Step 3: Live check (needs the principal)**

In `.env`, set `TRANSFER_ENABLED=true` and `TRANSFER_TO_PHONE_NUMBER` to the principal's cell, back up `.env` first, and rebuild the container (`docker compose up -d --build app`). Ask the principal for a second phone to act as the business, and run `npm run test:call` (or `place_call`) against it:

1. On the business phone, ask for the principal and agree to be connected. The principal answers. Expect: the call bridges, no Banjo audio after the handoff line, task `transferred`, and `call_attempts.transfer_result = 'answered'` once the bridged call ends.
2. Repeat, and the principal declines. Expect: the business phone hears `TRANSFER_FALLBACK_MESSAGE`, then the call ends, and `transfer_result` is `no_answer` or `busy`.

Check with SQL: `select status, outcome from tasks order by updated_at desc limit 2; select transfer_result from call_attempts order by started_at desc limit 2;`

- [ ] **Step 4: Finish**

Add "Closes #7" to the PR body, wait for CI, and wait for the principal to say merge.
