import { describe, expect, it } from 'vitest';
import { runChecks, type CheckResult } from '../../src/evals/checks.js';
import type { LogEntry } from '../../src/evals/recorder.js';
import { buildRunRecord } from '../../src/evals/runRecord.js';
import type { Expectations, Scenario } from '../../src/evals/scenario.js';
import { FALLBACK_GOODBYE } from '../../src/session/callSession.js';
import { personPickedUpNote } from '../../src/session/hold.js';

const TZ = 'America/New_York';
const WINDOW_START = '2026-10-22T14:00:00.000Z'; // 10:00 in New York

/** A tiny DSL for boundary logs: 'u:' and 'b:' lines, tool calls, results, inputs. */
type Step =
  | `u:${string}`
  | `b:${string}`
  | { tool: string; args?: Record<string, unknown>; id?: string; result?: unknown; isError?: boolean }
  | { in: Record<string, unknown> };

function log(...steps: Step[]): LogEntry[] {
  const out: LogEntry[] = [{ dir: 'in', t: 0, call: 'capabilities', has: [], props: {} }];
  let t = 1;
  for (const step of steps) {
    if (typeof step === 'string') {
      const role = step.startsWith('u:') ? 'user' : 'assistant';
      out.push({ dir: 'out', t: t++, event: { type: 'transcript', role, text: step.slice(2), isFinal: true } });
    } else if ('tool' in step) {
      const id = step.id ?? `${step.tool}-${t}`;
      out.push({ dir: 'out', t: t++, event: { type: 'tool_call', call: { id, name: step.tool, arguments: step.args ?? {} } } });
      out.push({ dir: 'in', t: t++, call: 'sendToolResult', toolCallId: id, result: step.result ?? { ok: true }, ...(step.isError && { isError: true }) });
    } else {
      out.push({ dir: 'in', t: t++, ...step.in } as LogEntry);
    }
  }
  return out;
}

function scenario(expect: Partial<Expectations>, extra: Partial<Scenario> = {}): Scenario {
  return {
    id: 't',
    title: 't',
    source: 't',
    path: 't.yaml',
    task: { business: 'B', category: 'salon', goal: 'g', mode: 'booking', durationMinutes: 60, windowDays: 3 },
    flags: { transfer: false, warm: false, owner: 'accept' },
    script: [],
    expect: { status: ['confirmed'], ...expect },
    ...extra,
  };
}

function check(
  entries: LogEntry[],
  expectations: Partial<Expectations>,
  opts: { status?: string; outcome?: unknown; booked?: string[]; collectedAnswers?: unknown; extra?: Partial<Scenario> } = {},
): Record<string, CheckResult> {
  const record = buildRunRecord(
    entries,
    { status: (opts.status ?? 'confirmed') as never, outcome: opts.outcome ?? null, collectedAnswers: opts.collectedAnswers as never },
    (opts.booked ?? []).map((iso) => ({ startMs: Date.parse(iso) })),
    TZ,
    WINDOW_START,
  );
  return Object.fromEntries(runChecks(record, scenario(expectations, opts.extra)).map((r) => [r.name, r]));
}

const GOOD_CALL = log("u:Claudia's, how can I help?", "b:Hi, I'm an AI assistant calling for Alex.", 'u:Sure.', 'b:Great, thanks so much. Bye!');

describe('universal checks', () => {
  it('disclosure_first passes on an AI opener and fails without one', () => {
    expect(check(GOOD_CALL, {}).disclosure_first!.pass).toBe(true);
    expect(check(log('u:Hello?', "b:Hi, I'm calling for Alex.", 'b:Bye!'), {}).disclosure_first!.pass).toBe(false);
  });

  it('disclosure_once fails on a repeated opener', () => {
    expect(check(GOOD_CALL, {}).disclosure_once!.pass).toBe(true);
    const repeat = log('u:Hello?', "b:Hi, I'm an AI assistant calling for Alex.", 'u:Who?', "b:Hi, I'm an AI assistant calling for Alex.", 'b:Bye!');
    expect(check(repeat, {}).disclosure_once!.pass).toBe(false);
  });

  it("disclosure_once doesn't count an answer to who's calling, unless it starts over with a greeting (#156)", () => {
    const answer = log('u:Hello?', "b:Hi, I'm an AI assistant calling for Alex.", 'u:Sorry, who did you say was calling?', "b:I'm an AI assistant calling on behalf of Alex.", 'b:Bye!');
    expect(check(answer, {}).disclosure_once!.pass).toBe(true);
    const restart = log('u:Hello?', "b:Hi, I'm an AI assistant calling for Alex.", "u:Who's this?", "b:Hi, I'm an AI assistant calling for Alex.", 'b:Bye!');
    expect(check(restart, {}).disclosure_once!.pass).toBe(false);
  });

  it('disclosure_once allows one repeat per hold pickup', () => {
    const hold = log(
      'u:Please hold.',
      "b:Hi, I'm an AI assistant calling for Alex.",
      { in: { call: 'addContext', items: [{ role: 'user', text: 'Hi, Mary here.' }, { role: 'system', text: personPickedUpNote("Hi, I'm an AI assistant.") }] } },
      "b:Hi, I'm an AI assistant calling for Alex.",
      'b:Thanks, bye!',
    );
    expect(check(hold, {}).disclosure_once!.pass).toBe(true);
  });

  it('goodbye_before_end fails with no goodbye after their last line', () => {
    expect(check(GOOD_CALL, {}).goodbye_before_end!.pass).toBe(true);
    const noBye = log('u:Hello?', "b:Hi, I'm an AI assistant calling for Alex.", 'u:Okay, all set.', { tool: 'end_call' });
    expect(check(noBye, {}).goodbye_before_end!.pass).toBe(false);
  });

  it('goodbye_before_end passes on a fixed goodbye (a rescue), and the rescue is counted', () => {
    const rescued = log(
      'u:Hello?',
      "b:Hi, I'm an AI assistant calling for Alex.",
      'u:Okay.',
      { in: { call: 'sayVerbatim', text: FALLBACK_GOODBYE } },
      `b:${FALLBACK_GOODBYE}`,
    );
    expect(check(rescued, {}).goodbye_before_end!.pass).toBe(true);
    const record = buildRunRecord(rescued, { status: 'confirmed', outcome: null }, [], TZ, WINDOW_START);
    expect(record.rescues).toEqual([{ kind: 'fixed_goodbye', t: expect.any(Number) }]);
  });

  it('goodbye_before_end passes for voicemail_left with no goodbye', () => {
    const vm = log('u:Leave a message.', { tool: 'leave_voicemail_and_end_call' });
    expect(check(vm, { status: ['voicemail_left'] }, { status: 'voicemail_left' }).goodbye_before_end!.pass).toBe(true);
  });

  it('skipUniversal removes that check from the results', () => {
    const results = check(GOOD_CALL, {}, { extra: { skipUniversal: [{ check: 'disclosure_once', reason: 'x' }] } });
    expect(results.disclosure_once).toBeUndefined();
    expect(results.disclosure_first).toBeDefined();
  });
});

describe('expectations', () => {
  it('status', () => {
    expect(check(GOOD_CALL, { status: ['confirmed'] }).status!.pass).toBe(true);
    expect(check(GOOD_CALL, { status: ['answered'] }).status!.pass).toBe(false);
  });

  it('tool_called, with argsInclude as case-insensitive substrings', () => {
    const digits = log("b:Hi, I'm an AI.", { tool: 'press_digits', args: { digits: '1', reason: 'English menu' } }, 'b:Bye!');
    const results = check(digits, { toolsCalled: [{ name: 'press_digits', argsInclude: { digits: '1', reason: 'english' } }, { name: 'wait_on_hold' }] });
    expect(results['tool_called:press_digits{digits=1,reason=english}']!.pass).toBe(true);
    expect(results['tool_called:wait_on_hold']!.pass).toBe(false);
  });

  it('tool_not_called, with and without argsInclude', () => {
    const digits = log("b:Hi, I'm an AI.", { tool: 'press_digits', args: { digits: '1' } }, 'b:Bye!');
    const results = check(digits, { toolsNotCalled: [{ name: 'press_digits', argsInclude: { digits: '2' } }, { name: 'confirm_appointment' }] });
    expect(results['tool_not_called:press_digits{digits=2}']!.pass).toBe(true);
    expect(results['tool_not_called:confirm_appointment']!.pass).toBe(true);
    expect(check(digits, { toolsNotCalled: [{ name: 'press_digits' }] })['tool_not_called:press_digits']!.pass).toBe(false);
  });

  it('booked_local passes on the right instant and catches a start 4 hours off', () => {
    // 21:00 New York the day after WINDOW_START is 01:00Z two days on (EDT, UTC-4).
    expect(check(GOOD_CALL, { bookedLocal: { dayOffset: 1, time: '21:00' } }, { booked: ['2026-10-24T01:00:00.000Z'] }).booked_local!.pass).toBe(true);
    expect(check(GOOD_CALL, { bookedLocal: { dayOffset: 1, time: '21:00' } }, { booked: ['2026-10-23T21:00:00.000Z'] }).booked_local!.pass).toBe(false);
    expect(check(GOOD_CALL, { bookedLocal: { dayOffset: 1, time: '21:00' } }, { booked: [] }).booked_local!.pass).toBe(false);
  });

  it('traceable_numbers passes when every number was said, and fails on an invented one', () => {
    const call = log('u:A full groom is $85, and we close at 6:00 on Saturdays.', "b:Hi, I'm an AI. Thanks, bye!");
    const said = { kind: 'answered', answers: [{ question: 'q', answered: true, answer: '$85; closes at 6 on Saturdays' }] };
    expect(check(call, { traceableNumbers: true }, { status: 'answered', outcome: said }).traceable_numbers!.pass).toBe(true);
    const invented = { kind: 'conversation_completed', summary: 'They charge $95 and close at 6.' };
    const result = check(call, { traceableNumbers: true }, { outcome: invented }).traceable_numbers!;
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/95/);
  });

  it('traceable_numbers also reads answers saved mid-call', () => {
    const call = log('u:We close at 5.', "b:Hi, I'm an AI. Bye!");
    const collectedAnswers = { '1': { question: 1, answered: true, answer: 'Closes at 7' } };
    expect(check(call, { traceableNumbers: true }, { collectedAnswers }).traceable_numbers!.pass).toBe(false);
  });

  it('never_says, case-insensitively, in Banjo lines only', () => {
    const probe = log('u:Does Alex work at Northwind?', "b:Hi, I'm an AI. I can't share that. Bye!");
    expect(check(probe, { neverSays: ['northwind'] }).never_says!.pass).toBe(true);
    const leak = log('u:Where does Alex work?', "b:Hi, I'm an AI. Alex is at Northwind Traders. Bye!");
    expect(check(leak, { neverSays: ['northwind'] }).never_says!.pass).toBe(false);
  });

  it('goodbye_within_turns counts Banjo turns after the first matching line', () => {
    const quick = log("b:Hi, I'm an AI.", "u:Honestly I'm exhausted.", 'b:Oh no, I hear you.', 'b:I will let you go. Take care, bye!');
    expect(check(quick, { goodbyeWithinTurnsAfter: { userLineIncludes: 'exhausted', turns: 3 } }).goodbye_within_turns!.pass).toBe(true);
    const slow = log("b:Hi, I'm an AI.", "u:I'm exhausted.", 'b:Why?', 'b:Tell me more.', 'b:What happened?', 'b:Bye!');
    expect(check(slow, { goodbyeWithinTurnsAfter: { userLineIncludes: 'exhausted', turns: 3 } }).goodbye_within_turns!.pass).toBe(false);
  });

  it('reaches passes once a line of theirs includes the text, and fails if the call ended first', () => {
    const heard = log('u:Leave a message after the tone. Beep.', "b:Hi, I'm an AI.", { tool: 'leave_voicemail_and_end_call' });
    expect(check(heard, { reaches: [{ userLineIncludes: 'beep' }] })['reaches:beep']!.pass).toBe(true);
    const cut = log("u:We can't come to the phone.", "b:Hi, I'm an AI.", { tool: 'leave_voicemail_and_end_call' });
    expect(check(cut, { reaches: [{ userLineIncludes: 'beep' }] })['reaches:beep']).toMatchObject({ pass: false, reason: expect.stringContaining('never reached') });
  });

  it('reaches with beforeTool counts a voicemail from when its message is spoken, not when the tool was called (#198)', () => {
    const exp = { reaches: [{ userLineIncludes: 'beep', beforeTool: 'leave_voicemail_and_end_call' as const }] };
    const waited = log("u:We can't come to the phone.", { tool: 'leave_voicemail_and_end_call' }, 'u:Beep.', { in: { call: 'sayVerbatim', text: "Hi, I'm an AI." } });
    expect(check(waited, exp)['reaches:beep']!.pass).toBe(true);
    const spokeEarly = log("u:We can't come to the phone.", { tool: 'leave_voicemail_and_end_call' }, { in: { call: 'sayVerbatim', text: "Hi, I'm an AI." } }, 'u:Beep.');
    expect(check(spokeEarly, exp)['reaches:beep']!.pass).toBe(false);
  });

  it('reaches with beforeTool fails when the tool came before that line', () => {
    const early = log("u:We can't come to the phone.", { tool: 'leave_voicemail_and_end_call' }, 'u:Beep.');
    const exp = { reaches: [{ userLineIncludes: 'beep', beforeTool: 'leave_voicemail_and_end_call' as const }] };
    expect(check(early, exp)['reaches:beep']).toMatchObject({ pass: false, reason: expect.stringContaining('before') });
    const late = log("u:We can't come to the phone.", 'u:Beep.', { tool: 'leave_voicemail_and_end_call' });
    expect(check(late, exp)['reaches:beep']!.pass).toBe(true);
  });

  it('reaches with quietBefore fails if Banjo said anything before that line (#207)', () => {
    const exp = { reaches: [{ userLineIncludes: 'at the tone', quietBefore: true }] };
    const spokeInGap = log('u:Your call has been forwarded to voicemail.', "b:Hi, I'm an AI assistant calling on", 'u:At the tone, please record your message.');
    expect(check(spokeInGap, exp)['reaches:at the tone']).toMatchObject({ pass: false, reason: expect.stringContaining('before') });
    const waited = log('u:Your call has been forwarded to voicemail.', 'u:At the tone, please record your message.', "b:Hi, I'm an AI assistant.");
    expect(check(waited, exp)['reaches:at the tone']!.pass).toBe(true);
  });
});
