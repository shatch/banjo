/**
 * The eval checks (#188): each pass/fail, in code, and each tied to a known
 * failure. They score the whole call, which is what the other party heard, so
 * a safety net's goodbye counts; rescues are reported beside them, never as a
 * failure.
 */
import { AI_WORD } from '../config/index.js';
import { formatInZone, zonedTimeToUtcIso } from '../lib/timezone.js';
import { checkDisclosure } from '../session/disclosure.js';
import { saidGoodbye } from '../session/goodbye.js';
import type { RunRecord } from './runRecord.js';
import { UNIVERSAL_CHECKS, type Scenario, type ToolExpectation } from './scenario.js';

export interface CheckResult {
  name: string;
  pass: boolean;
  reason?: string;
}

/** Endings that don't close a conversation with a person, so need no goodbye. */
const NO_GOODBYE_NEEDED = new Set(['voicemail_left', 'transferred', 'escalated']);

// A re-introduction (#156): the AI opener again, a greeting or "calling for/on
// behalf of" with "AI". Not "I'm Alex's AI assistant" in answer to "who is this?".
const OPENER = /^(hi|hello|hey|good (morning|afternoon|evening))\b|\bcalling (for|on behalf of)\b/i;
const isOpener = (line: string) => AI_WORD.test(line) && OPENER.test(line);
const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening))\b/i;
// "Sorry, who did you say was calling?": the honest answer names the AI and who it calls for, and isn't a restart.
const ASKS_WHO = /\bwho('s| is| was| did you say| am i| are you)\b|\byour name\b/i;

const pass = (name: string): CheckResult => ({ name, pass: true });
const fail = (name: string, reason: string): CheckResult => ({ name, pass: false, reason });

function universal(record: RunRecord, check: (typeof UNIVERSAL_CHECKS)[number]): CheckResult {
  const banjo = record.lines.filter((l) => l.role === 'assistant');
  switch (check) {
    case 'disclosure_first': {
      const result = checkDisclosure(banjo[0]?.text);
      return result === 'disclosed' ? pass(check) : fail(check, `first line ${result}: ${JSON.stringify(banjo[0]?.text ?? '')}`);
    }
    case 'disclosure_once': {
      const openers = record.lines.filter((l, i) => {
        if (l.role !== 'assistant' || !isOpener(l.text)) return false;
        const theirs = record.lines.slice(0, i).findLast((p) => p.role === 'user');
        return GREETING.test(l.text) || !theirs || !ASKS_WHO.test(theirs.text);
      });
      const allowed = 1 + record.holdPickups;
      return openers.length <= allowed ? pass(check) : fail(check, `${openers.length} openers, ${allowed} allowed: ${JSON.stringify(openers.at(-1)!.text)}`);
    }
    case 'goodbye_before_end': {
      if (NO_GOODBYE_NEEDED.has(record.status)) return pass(check);
      const lastTheirs = record.lines.findLastIndex((l) => l.role === 'user');
      const after = record.lines.slice(lastTheirs + 1).filter((l) => l.role === 'assistant');
      const said = after.some((l) => saidGoodbye(l.text)) || (banjo.length > 0 && saidGoodbye(banjo.at(-1)!.text));
      return said ? pass(check) : fail(check, `no goodbye after their last line; Banjo's last: ${JSON.stringify(banjo.at(-1)?.text ?? '')}`);
    }
  }
}

function toolName(prefix: string, t: ToolExpectation): string {
  const args = t.argsInclude ? `{${Object.entries(t.argsInclude).map(([k, v]) => `${k}=${v}`).join(',')}}` : '';
  return `${prefix}:${t.name}${args}`;
}

function matches(call: RunRecord['toolCalls'][number], t: ToolExpectation): boolean {
  if (call.name !== t.name) return false;
  return Object.entries(t.argsInclude ?? {}).every(([key, want]) => {
    const got = call.args[key];
    if (typeof want === 'string') return typeof got === 'string' && got.toLowerCase().includes(want.toLowerCase());
    return got === want;
  });
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Digit runs, with "6:00" read as "6", and "$" and "," dropped. */
function numbers(text: string): string[] {
  return text.replace(/[$,]/g, '').replace(/\b(\d{1,2}):00\b/g, '$1').match(/\d+/g) ?? [];
}

/** The outcome's free text, written by the model: what traceable_numbers holds to the transcript. */
function outcomeText(record: RunRecord): string[] {
  const texts: string[] = [];
  const o = (record.outcome ?? {}) as Record<string, unknown>;
  for (const key of ['summary', 'details', 'reason', 'message']) if (typeof o[key] === 'string') texts.push(o[key] as string);
  for (const a of Array.isArray(o.answers) ? (o.answers as { answer?: unknown }[]) : []) if (typeof a.answer === 'string') texts.push(a.answer);
  for (const a of Object.values(record.collectedAnswers ?? {})) if (a.answered) texts.push(a.answer);
  return texts;
}

export function runChecks(record: RunRecord, scenario: Scenario): CheckResult[] {
  const skipped = new Set(scenario.skipUniversal?.map((s) => s.check));
  const results = UNIVERSAL_CHECKS.filter((c) => !skipped.has(c)).map((c) => universal(record, c));
  const e = scenario.expect;

  results.push(e.status.includes(record.status) ? pass('status') : fail('status', `${record.status}, expected ${e.status.join(' or ')}`));
  if (e.answeredBy) {
    const last = record.answeredBy.at(-1);
    results.push(last && e.answeredBy.includes(last) ? pass('answered_by') : fail('answered_by', `${last ?? 'none'}, expected ${e.answeredBy.join(' or ')}`));
  }
  for (const t of e.toolsCalled ?? []) {
    const name = toolName('tool_called', t);
    results.push(record.toolCalls.some((c) => matches(c, t)) ? pass(name) : fail(name, `called: ${record.toolCalls.map((c) => c.name).join(', ') || 'none'}`));
  }
  for (const t of e.toolsNotCalled ?? []) {
    const name = toolName('tool_not_called', t);
    const hit = record.toolCalls.find((c) => matches(c, t));
    results.push(hit ? fail(name, `called with ${JSON.stringify(hit.args)}`) : pass(name));
  }
  if (e.bookedLocal) {
    const localDate = addDays(formatInZone(record.windowStart, record.timeZone).slice(0, 10), e.bookedLocal.dayOffset);
    const want = zonedTimeToUtcIso(`${localDate}T${e.bookedLocal.time}:00`, record.timeZone);
    const got = record.bookedStarts;
    results.push(
      got.length === 1 && Date.parse(got[0]!) === Date.parse(want)
        ? pass('booked_local')
        : fail('booked_local', `booked ${got.map((s) => formatInZone(s, record.timeZone)).join(', ') || 'nothing'}, expected ${localDate}T${e.bookedLocal.time}`),
    );
  }
  if (e.traceableNumbers) {
    const said = new Set(record.lines.flatMap((l) => numbers(l.text)));
    const invented = [...new Set(outcomeText(record).flatMap(numbers))].filter((n) => !said.has(n));
    results.push(invented.length ? fail('traceable_numbers', `not said on the call: ${invented.join(', ')}`) : pass('traceable_numbers'));
  }
  if (e.neverSays) {
    const leaked = e.neverSays.filter((s) => record.lines.some((l) => l.role === 'assistant' && l.text.toLowerCase().includes(s.toLowerCase())));
    results.push(leaked.length ? fail('never_says', `said: ${leaked.join(', ')}`) : pass('never_says'));
  }
  if (e.goodbyeWithinTurnsAfter) {
    const { userLineIncludes, turns } = e.goodbyeWithinTurnsAfter;
    const from = record.lines.findIndex((l) => l.role === 'user' && l.text.toLowerCase().includes(userLineIncludes.toLowerCase()));
    if (from < 0) {
      results.push(fail('goodbye_within_turns', `no line of theirs includes "${userLineIncludes}"`));
    } else {
      const next = record.lines.slice(from + 1).filter((l) => l.role === 'assistant').slice(0, turns);
      results.push(next.some((l) => saidGoodbye(l.text)) ? pass('goodbye_within_turns') : fail('goodbye_within_turns', `no goodbye in Banjo's next ${turns} lines`));
    }
  }
  for (const { userLineIncludes, beforeTool, quietBefore } of e.reaches ?? []) {
    const name = `reaches:${userLineIncludes}`;
    const line = record.lines.find((l) => l.role === 'user' && l.text.toLowerCase().includes(userLineIncludes.toLowerCase()));
    const tool = beforeTool && record.toolCalls.find((c) => c.name === beforeTool);
    if (!line) results.push(fail(name, `never reached: the call ended before a line of theirs included "${userLineIncludes}"`));
    else if (tool && (tool.spokenAt ?? tool.t) < line.t) results.push(fail(name, `${beforeTool} came before their line "${line.text}"`));
    else if (quietBefore && record.lines.some((l) => l.role === 'assistant' && l.t < line.t)) {
      const said = record.lines.find((l) => l.role === 'assistant' && l.t < line.t)!;
      results.push(fail(name, `Banjo said "${said.text}" before their line "${line.text}"`));
    }
    else results.push(pass(name));
  }
  return results;
}
