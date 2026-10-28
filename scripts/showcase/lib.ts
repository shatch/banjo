/**
 * The README's "See it work" transcripts, rendered from eval recordings
 * (evals/recordings/*.json): Banjo's side is the real model's, the other side
 * the scenario's script. Generated, not pasted, so a re-record after a prompt
 * change shows up here too: tests/scripts/showcaseLib.test.ts fails while the
 * README is behind, and `npm run readme:showcase` brings it up to date.
 */
import { join } from 'node:path';
import type { LogEntry } from '../../src/evals/recorder.js';
import { readRecording } from '../../src/evals/recording.js';
import { loadScenario } from '../../src/evals/scenario.js';

export interface Pick {
  scenarioId: string;
  headline: string;
  /** Who Banjo is talking to, as the transcript labels them. */
  them: string;
}

/** Order is the README's. Leave out a scenario Banjo can't do on a live call yet (ivr-spanish: #225). */
export const PICKS: Pick[] = [
  { scenarioId: 'profile-probe', headline: 'Keeps your private details private, and gets the booking anyway.', them: 'Groomer' },
  { scenarioId: 'hold-then-person', headline: 'Waits through a hold queue, then starts over with the person who picks up.', them: 'Riverside Auto' },
  { scenarioId: 'ask-unknown-call-back', headline: "Asks your questions, and says so when one goes unanswered.", them: 'Groomer' },
  { scenarioId: 'asks-for-lookup', headline: 'Passes on what they ask for, without promising what happens next.', them: 'Marisol' },
  { scenarioId: 'tired-callee', headline: 'Reads the room on a check-in call.', them: 'Robin' },
];

export interface Line {
  kind: 'them' | 'recording' | 'banjo' | 'tool';
  text: string;
  /** An ask call's result, on its report_answers_and_end_call line. */
  answers?: { question: string; answer: string | null }[];
}

const WEEKDAY = '(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DATED = new RegExp(`\\b${WEEKDAY},? ${MONTH} \\d{1,2}(?:st|nd|rd|th)?\\b`, 'g');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Wednesday, October 28" → "Wednesday": a recording's dates would date the README. */
export function undate(text: string): string {
  return text.replace(DATED, '$1');
}

/** "2026-10-28T09:00:00" (a local time, as confirm_appointment takes it) → "Wednesday at 9:00 AM". */
function spokenTime(local: string): string {
  const [date = '', time = ''] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h = 0, min = 0] = time.split(':').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()];
  return `${weekday} at ${h % 12 || 12}:${String(min).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function describeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'press_digits':
      return `${name}: ${String(args.digits)}`;
    case 'confirm_appointment':
      return `${name}: booked ${spokenTime(String(args.confirmedStart))}`;
    case 'record_answer':
      return `${name}: question ${String(args.question)} ${args.answered ? 'answered' : 'unanswered'}`;
    case 'note_follow_up':
      return `${name}: "${String(args.request)}"`;
    default:
      return name;
  }
}

/** A recording's log as a reader would follow the call: final lines and tool calls, in order. */
export function transcriptOf(log: LogEntry[], questions: string[] = []): Line[] {
  const lines: Line[] = [];
  let onHold = false;
  for (const entry of log) {
    if (entry.dir === 'in') {
      if (entry.call === 'setHold') {
        // A hold ends on the line that was judged a person, which has already arrived.
        const last = lines.at(-1);
        if (onHold && !entry.onHold && last?.kind === 'recording') last.kind = 'them';
        onHold = entry.onHold;
      }
      continue;
    }
    const event = entry.event;
    if (event.type === 'transcript' && event.isFinal) {
      const text = undate(event.text.replace(/\s+/g, ' ').trim());
      if (!text) continue;
      lines.push({ kind: event.role === 'assistant' ? 'banjo' : onHold ? 'recording' : 'them', text });
    } else if (event.type === 'tool_call') {
      const args = event.call.arguments as Record<string, unknown>;
      const line: Line = { kind: 'tool', text: describeTool(event.call.name, args) };
      if (event.call.name === 'report_answers_and_end_call' && Array.isArray(args.answers)) {
        line.answers = (args.answers as { question: number; answered: boolean; answer?: string }[]).map((a) => ({
          question: questions[a.question - 1] ?? `Question ${a.question}`,
          answer: a.answered ? (a.answer ?? '') : null,
        }));
      }
      lines.push(line);
    }
  }
  return lines;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|');

export function renderPick(pick: Pick, lines: Line[]): string {
  const quoted = lines.map((line) => {
    switch (line.kind) {
      case 'them':
        return `**${pick.them}:** ${line.text}`;
      case 'recording':
        return `**${pick.them} (recording):** _${line.text}_`;
      case 'banjo':
        return `**Banjo:** ${line.text}`;
      case 'tool': {
        const [name, ...rest] = line.text.split(': ');
        return `▸ \`${name}\`${rest.length ? `: ${rest.join(': ')}` : ''}`;
      }
    }
  });
  const out = ['<details>', `<summary><b>${pick.headline}</b></summary>`, '', quoted.map((q) => `> ${q}`).join('\n>\n')];
  const answers = lines.find((line) => line.answers)?.answers;
  if (answers) {
    out.push('', 'What `get_task_status` returns:', '', '| Question | Answer |', '|---|---|');
    for (const a of answers) out.push(`| ${cell(a.question)} | ${a.answer === null ? '_unanswered_' : cell(a.answer)} |`);
  }
  out.push('', '</details>');
  return out.join('\n');
}

/** Every pick, rendered from its recording and scenario. */
export function renderShowcase(recordings = 'evals/recordings', scenarios = 'evals/scenarios'): string {
  return PICKS.map((pick) => {
    const rec = readRecording(recordings, pick.scenarioId);
    if (!rec) throw new Error(`no recording for ${pick.scenarioId}: run npm run eval -- --scenario ${pick.scenarioId} --record`);
    const scenario = loadScenario(join(scenarios, `${pick.scenarioId}.yaml`));
    return renderPick(pick, transcriptOf(rec.log, scenario.task.questions));
  }).join('\n\n');
}

const START = '<!-- showcase:start -->';
const END = '<!-- showcase:end -->';

/** `readme` with what's between the showcase markers set to `body`. */
export function replaceSection(readme: string, body: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) throw new Error(`README needs ${START} and ${END} around the showcase`);
  return `${readme.slice(0, start + START.length)}\n${body}\n${readme.slice(end)}`;
}
