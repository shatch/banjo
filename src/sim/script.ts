import { readFileSync } from 'node:fs';
import { formatInZone } from '../lib/timezone.js';
import type { TextVoiceAIProvider } from './simCall.js';
import type { SimTelephonyProvider } from './simTelephony.js';

/**
 * One step of the other party's script (`npm run sim -- --script`, and the
 * eval scenarios, #188): a line said once Banjo has spoken and gone quiet; a
 * recording (`~`), which plays on its own clock, like a phone menu or hold
 * queue; or a stretch of silence (`(silence N)`), N seconds of saying nothing.
 * A silence right after a ~ line is a pause in the recording: it runs on the
 * recording's clock, adding N seconds before the next ~ line.
 */
export type ScriptStep = { kind: 'line'; text: string } | { kind: 'recording'; text: string } | { kind: 'silence'; seconds: number };

export interface ScriptTiming {
  /** How long Banjo must stay quiet before the next line is said. */
  turnQuietMs: number;
  /** How long after the line before it a ~ line plays. */
  recordingGapMs: number;
  /** After the last step: how long to wait for Banjo to end the call before hanging up on it. */
  endQuietMs: number;
}

const DEFAULT_TIMING: ScriptTiming = { turnQuietMs: 1500, recordingGapMs: 3000, endQuietMs: 15_000 };

const SILENCE = /^\(silence\b(.*)\)$/;

export function parseScriptLines(lines: string[]): ScriptStep[] {
  return lines.map((line) => {
    const silence = SILENCE.exec(line);
    if (silence) {
      const seconds = Number(silence[1]!.trim());
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) {
        throw new Error(`"${line}": a silence step is (silence N), with N a whole number of seconds from 1 to 120`);
      }
      return { kind: 'silence', seconds };
    }
    if (line.startsWith('~')) return { kind: 'recording', text: line.slice(1).trim() };
    return { kind: 'line', text: line };
  });
}

const DAY_TOKEN = /\{day\+(\d{1,2})\}/g;

/**
 * Writes each {day+N} as the weekday and date N days after now's local date in
 * timeZone ("Saturday, October 24"), so a script names real days whenever it
 * runs (#188): the date in the line and the date the checks expect agree.
 */
export function renderDates(steps: ScriptStep[], now: Date, timeZone: string): ScriptStep[] {
  const [y, m, d] = formatInZone(now.toISOString(), timeZone).slice(0, 10).split('-').map(Number);
  const spoken = (days: number) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(Date.UTC(y!, m! - 1, d! + days, 12)));
  return steps.map((step) => (step.kind === 'silence' ? step : { ...step, text: step.text.replace(DAY_TOKEN, (_, n: string) => spoken(Number(n))) }));
}

/** A script file's steps, one per line; blank lines and # comments are skipped. */
export function readScript(path: string): ScriptStep[] {
  return parseScriptLines(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
}

/**
 * Plays the steps against Banjo, then hangs up if Banjo hasn't ended the call
 * itself soon after the last one. Resolves once the line is dead, whoever hung up.
 */
export function runScript(
  steps: ScriptStep[],
  voice: TextVoiceAIProvider,
  telephony: SimTelephonyProvider,
  print: (line: string) => void,
  timing: Partial<ScriptTiming> = {},
): Promise<void> {
  const t = { ...DEFAULT_TIMING, ...timing };
  let next = 0;
  let banjoSpoke = false;
  let inSilence = false;
  let over = false;
  let timer: NodeJS.Timeout | undefined;
  /** The step a ~ line's (or a pause in a recording's) timer is already counting down for: Banjo's events don't restart it. */
  let recordingTimerFor: number | undefined;

  const say = () => {
    const step = steps[next++]! as Extract<ScriptStep, { text: string }>;
    print(`You: ${step.text}`);
    banjoSpoke = false;
    voice.sendUserText(step.text);
  };
  const schedule = () => {
    const step = steps[next];
    if (step && recordingTimerFor === next) return;
    clearTimeout(timer);
    recordingTimerFor = undefined;
    if (!step) {
      timer = setTimeout(() => {
        print('[End of script.]');
        telephony.calleeHangsUp();
      }, t.endQuietMs);
    } else if (step.kind === 'silence' && steps[next - 1]?.kind === 'recording') {
      // A pause in a recording (#207: a two-part carrier greeting), on the
      // recording's clock: it starts with the ~ line before it, whatever Banjo does.
      recordingTimerFor = next;
      timer = setTimeout(() => {
        recordingTimerFor = undefined;
        next++;
        if (!over) schedule();
      }, step.seconds * 1000);
    } else if (step.kind === 'silence') {
      // Reached like a line, once Banjo has spoken and gone quiet; then
      // counted on its own clock, whatever Banjo says meanwhile.
      timer = setTimeout(() => {
        if (!banjoSpoke) return;
        inSilence = true;
        timer = setTimeout(() => {
          inSilence = false;
          next++;
          // They speak again after the silence whether or not Banjo has.
          banjoSpoke = true;
          if (!over) schedule();
        }, step.seconds * 1000);
      }, t.turnQuietMs);
    } else if (step.kind === 'recording') {
      // A recording plays on regardless of Banjo, on its own clock.
      recordingTimerFor = next;
      timer = setTimeout(() => {
        recordingTimerFor = undefined;
        if (over) return;
        say();
        schedule();
      }, t.recordingGapMs);
    } else {
      timer = setTimeout(() => {
        if (!banjoSpoke) return;
        say();
        schedule();
      }, t.turnQuietMs);
    }
  };

  return new Promise((resolve) => {
    voice.on('event', (event) => {
      if (event.type === 'transcript' && event.role === 'assistant') banjoSpoke = true;
      if (!over && !inSilence) schedule();
    });
    // Nothing more to say once the line is dead, whoever hung up.
    telephony.on('event', (event) => {
      if (event.type !== 'ended') return;
      over = true;
      clearTimeout(timer);
      resolve();
    });
    // The callee speaks first on an outbound call.
    const first = steps[0];
    if (first && first.kind !== 'silence') say();
    schedule();
  });
}
