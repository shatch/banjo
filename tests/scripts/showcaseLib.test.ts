import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../src/evals/recorder.js';
import { PICKS, renderPick, renderShowcase, replaceSection, transcriptOf, undate } from '../../scripts/showcase/lib.js';

const said = (role: 'user' | 'assistant', text: string, isFinal = true): LogEntry =>
  ({ dir: 'out', t: 0, event: { type: 'transcript', role, text, isFinal } }) as LogEntry;
const tool = (name: string, args: Record<string, unknown>): LogEntry =>
  ({ dir: 'out', t: 0, event: { type: 'tool_call', call: { id: 'x', name, arguments: args } } }) as LogEntry;
const hold = (onHold: boolean): LogEntry => ({ dir: 'in', t: 0, call: 'setHold', onHold });

describe('undate', () => {
  it('drops the month and day after a weekday, so the transcript does not age', () => {
    expect(undate('Wednesday, October 28 at 9 AM works.')).toBe('Wednesday at 9 AM works.');
    expect(undate('on Thursday October 29th')).toBe('on Thursday');
  });

  it('leaves other text alone', () => {
    expect(undate('I leave on Thursday, I am so excited.')).toBe('I leave on Thursday, I am so excited.');
  });
});

describe('transcriptOf', () => {
  it('keeps final lines and tool calls in order, skipping partial transcripts', () => {
    const lines = transcriptOf([
      said('user', 'Hello?'),
      said('assistant', 'Hi', false),
      said('assistant', "Hi, I'm an AI assistant.\n\nHow are you?"),
      tool('end_conversation_call', { summary: 'x' }),
    ]);
    expect(lines).toEqual([
      { kind: 'them', text: 'Hello?' },
      { kind: 'banjo', text: "Hi, I'm an AI assistant. How are you?" },
      { kind: 'tool', text: 'end_conversation_call' },
    ]);
  });

  it('marks what they say while Banjo is on hold as a recording', () => {
    const lines = transcriptOf([said('user', 'Can you hold?'), hold(true), said('user', 'Your call is important to us.'), said('user', 'Please stay on the line.')]);
    expect(lines).toEqual([
      { kind: 'them', text: 'Can you hold?' },
      { kind: 'recording', text: 'Your call is important to us.' },
      { kind: 'recording', text: 'Please stay on the line.' },
    ]);
  });

  it('counts the line that ends a hold as the person, not the recording', () => {
    const lines = transcriptOf([hold(true), said('user', 'Thank you for holding.'), said('user', 'Hi, this is Sam.'), hold(false)]);
    expect(lines.map((line) => line.kind)).toEqual(['recording', 'them']);
  });

  it('describes the tool calls a reader cares about from their arguments', () => {
    const lines = transcriptOf([
      tool('press_digits', { digits: '1' }),
      tool('confirm_appointment', { confirmedStart: '2026-10-28T09:00:00', durationMinutes: 60, summary: 'Oil change' }),
      tool('record_answer', { question: 1, answered: true, answer: 'They close at 4.' }),
      tool('note_follow_up', { request: 'Find events in San Juan.' }),
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      'press_digits: 1',
      'confirm_appointment: booked Wednesday at 9:00 AM',
      'record_answer: question 1 answered',
      'note_follow_up: "Find events in San Juan."',
    ]);
  });
});

describe('renderPick', () => {
  it('renders a collapsed transcript with the speaker label, recordings and tool calls', () => {
    const md = renderPick(
      { scenarioId: 'x', headline: 'Waits on hold.', them: 'Riverside Auto' },
      [
        { kind: 'them', text: 'Can you hold?' },
        { kind: 'tool', text: 'wait_on_hold' },
        { kind: 'recording', text: 'Thank you for holding.' },
        { kind: 'banjo', text: 'Hi.' },
      ],
    );
    expect(md).toBe(
      [
        '<details>',
        '<summary><b>Waits on hold.</b></summary>',
        '',
        '> **Riverside Auto:** Can you hold?',
        '>',
        '> ▸ `wait_on_hold`',
        '>',
        '> **Riverside Auto (recording):** _Thank you for holding._',
        '>',
        '> **Banjo:** Hi.',
        '',
        '</details>',
      ].join('\n'),
    );
  });

  it("adds an ask call's result as a table, an unanswered question included", () => {
    const md = renderPick({ scenarioId: 'x', headline: 'Asks.', them: 'Dana' }, [
      { kind: 'tool', text: 'report_answers_and_end_call', answers: [
        { question: 'Saturday close?', answer: 'They close at 4.' },
        { question: 'Walk-ins?', answer: null },
      ] },
    ]);
    expect(md).toContain('| Question | Answer |');
    expect(md).toContain('| Saturday close? | They close at 4. |');
    expect(md).toContain('| Walk-ins? | _unanswered_ |');
  });
});

describe('replaceSection', () => {
  const readme = 'top\n<!-- showcase:start -->\nold\n<!-- showcase:end -->\nbottom\n';

  it('replaces only what is between the markers', () => {
    expect(replaceSection(readme, 'new')).toBe('top\n<!-- showcase:start -->\nnew\n<!-- showcase:end -->\nbottom\n');
  });

  it('throws when the markers are missing', () => {
    expect(() => replaceSection('no markers', 'new')).toThrow(/showcase:start/);
  });
});

describe('the README', () => {
  it('shows the current recordings (npm run readme:showcase updates it)', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(replaceSection(readme, renderShowcase()), 'README is stale: run npm run readme:showcase').toBe(readme);
  });

  it('renders every pick from a recording that exists', () => {
    expect(PICKS.length).toBeGreaterThanOrEqual(5);
    expect(renderShowcase().match(/<details>/g)?.length).toBe(PICKS.length);
  });
});
