import { describe, expect, it } from 'vitest';
import type { Contact } from '../../src/contacts/schema.js';
import type { TaskAnswer } from '../../src/tasks/schema.js';
import { buildOutcomeSummary, OWNER_SUMMARY_MAX_CHARS, withDisclosureNote, withFollowUps, withSavedAnswers } from '../../src/notifications/channel.js';
import { PUSHOVER_MAX_MESSAGE_CHARS, SMS_MAX_CHARS } from '../../src/notifications/limits.js';

const contact = { displayName: 'Alex' } as Contact;

describe('buildOutcomeSummary', () => {
  it('summarizes a conversation_completed outcome', () => {
    const summary = buildOutcomeSummary(contact, {
      kind: 'conversation_completed',
      summary: 'Thanked them for hosting; said the visit was great.',
    });
    expect(summary).toContain('Alex');
    expect(summary).toContain('Thanked them for hosting; said the visit was great.');
  });

  it('lists an ask call\'s questions with their answers (#148)', () => {
    const summary = buildOutcomeSummary(contact, {
      kind: 'answered',
      answers: [
        { question: 'Open Sunday?', answered: true, answer: 'No, closed Sundays.' },
        { question: 'Walk-ins?', answered: false },
      ],
      summary: 'Busy on Saturdays.',
    });
    expect(summary).toBe('Asked Alex: 1 of 2 answered.\n1. Open Sunday? No, closed Sundays.\n2. Walk-ins? (no answer)\nBusy on Saturdays.');
  });

  it('says so when every question was answered', () => {
    const summary = buildOutcomeSummary(contact, {
      kind: 'answered',
      answers: [{ question: 'Open Sunday?', answered: true, answer: 'No.' }],
    });
    expect(summary).toBe('Asked Alex: all 1 answered.\n1. Open Sunday? No.');
  });

  // #148 review: an ask call that got nothing still ends 'answered', and
  // read "got your answers".
  it('leads with "No answers" when none of the questions was answered', () => {
    const summary = buildOutcomeSummary(contact, {
      kind: 'answered',
      answers: [
        { question: 'Open Sunday?', answered: false },
        { question: 'Walk-ins?', answered: false },
      ],
      summary: 'They hung up.',
    });
    expect(summary.split('\n')[0]).toBe('No answers from Alex (0 of 2). Needs your attention.');
    expect(summary).toContain('1. Open Sunday? (no answer)');
    expect(summary).toContain('2. Walk-ins? (no answer)');
  });

  it('leads with "No answers" when the outcome recorded no answers at all', () => {
    const summary = buildOutcomeSummary(contact, { kind: 'answered', answers: [] });
    expect(summary).toBe('No answers from Alex: none were recorded. Needs your attention.');
  });

  describe('fitting an ask summary into one notification', () => {
    const long = (label: string, n: number) => `${label} ${'x'.repeat(n)}`.slice(0, n);
    const answers: TaskAnswer[] = [1, 2, 3, 4, 5].map((n) =>
      n === 4
        ? { question: long(`Q${n}`, 300), answered: false }
        : { question: long(`Q${n}`, 300), answered: true, answer: long(`A${n}`, 2000) },
    );
    const outcome = { kind: 'answered' as const, answers, summary: long('S', 3000) };

    it("stays within both channels' limits, even with the disclosure note added", () => {
      const summary = withDisclosureNote(buildOutcomeSummary(contact, outcome), 'missed');
      expect(summary.length).toBeLessThanOrEqual(Math.min(PUSHOVER_MAX_MESSAGE_CHARS, SMS_MAX_CHARS));
      expect(summary).toContain("didn't say it was an AI");
    });

    it('keeps every question, in order, under its own number, and says what was cut', () => {
      const lines = buildOutcomeSummary(contact, outcome).split('\n');
      expect(lines[0]).toBe('Asked Alex: 4 of 5 answered.');
      const items = lines.filter((l) => /^\d\. /.test(l));
      expect(items.map((l) => l.slice(0, 5))).toEqual(['1. Q1', '2. Q2', '3. Q3', '4. Q4', '5. Q5']);
      // Each clipped answer stays on its own question's line.
      for (const n of [1, 2, 3, 5]) expect(items[n - 1]).toContain(`A${n}`);
      expect(items[3]).toMatch(/ \(no answer\)$/);
      expect(items.every((l) => l.includes('…'))).toBe(true);
      expect(lines.at(-1)).toBe('(Shortened. Full answers: get_task_status.)');
    });

    it('clips the answers before giving up the summary, and drops the summary last', () => {
      // Short items: only the summary is too long, so it's clipped, not dropped.
      const summaryOnly = buildOutcomeSummary(contact, {
        kind: 'answered',
        answers: [{ question: 'Open Sunday?', answered: true, answer: 'No.' }],
        summary: long('S', 3000),
      });
      expect(summaryOnly).toContain('1. Open Sunday? No.\nS');
      expect(summaryOnly.length).toBeLessThanOrEqual(OWNER_SUMMARY_MAX_CHARS);
      // Long items and a long summary: the summary is clipped short so the
      // answers get the room.
      const summaryLine = buildOutcomeSummary(contact, outcome)
        .split('\n')
        .find((l) => l.startsWith('S '));
      expect(summaryLine!.length).toBeLessThanOrEqual(200);
      expect(summaryLine!.endsWith('…')).toBe(true);
    });

    it('fits a smaller budget when one is passed, dropping the summary but keeping every number', () => {
      const summary = buildOutcomeSummary(contact, outcome, 300);
      expect(summary.length).toBeLessThanOrEqual(300);
      expect(summary).not.toContain('\nS ');
      expect(summary.split('\n').filter((l) => /^\d\. /.test(l)).map((l) => l[0])).toEqual(['1', '2', '3', '4', '5']);
    });

    it('leaves a summary that already fits untouched', () => {
      const summary = buildOutcomeSummary(contact, {
        kind: 'answered',
        answers: [{ question: 'Open Sunday?', answered: true, answer: 'No.' }],
        summary: 'Busy.',
      });
      expect(summary).not.toContain('Shortened');
    });
  });

  it('still summarizes a confirmed outcome (existing behavior unchanged)', () => {
    const summary = buildOutcomeSummary(contact, {
      kind: 'confirmed',
      start: '2026-08-05T14:00:00Z',
      durationMinutes: 30,
    });
    expect(summary).toContain('Booked with Alex');
  });

  it("gives a booking's time in the calendar timezone, not the server's", () => {
    // The SMS for a real 4pm booking read "9/24/2026, 8:00:00 PM": the
    // container runs in UTC and the summary used toLocaleString().
    const summary = buildOutcomeSummary({ displayName: 'John Federico' } as Contact, {
      kind: 'confirmed',
      start: '2026-09-24T20:00:00.000Z',
      durationMinutes: 30,
    });
    expect(summary).toContain('Thursday, September 24 at 4:00 PM');
    expect(summary).not.toContain('8:00');
  });

  it('summarizes a transfer (#7)', () => {
    const summary = buildOutcomeSummary({ displayName: "Luigi's" } as Contact, { kind: 'transferred', reason: 'they need a card number' });
    expect(summary).toBe("Transferred Luigi's to you — they need a card number.");
  });
});

describe('withSavedAnswers (#148 review)', () => {
  const luigi = { displayName: "Luigi's" } as Contact;
  const long = (n: number) => `${'word '.repeat(60)}${n}`;

  it('stays within the limit after a long outcome, keeping the numbering', () => {
    const escalated = buildOutcomeSummary(luigi, { kind: 'escalated', reason: 'x'.repeat(500) });
    const saved: TaskAnswer[] = [1, 2, 3, 4, 5].map((n) =>
      n % 2 ? { question: long(n), answered: true, answer: long(n) } : { question: long(n), answered: false },
    );
    const out = withSavedAnswers(escalated, luigi, saved);
    expect(out.length).toBeLessThanOrEqual(OWNER_SUMMARY_MAX_CHARS);
    expect(out.startsWith(escalated)).toBe(true);
    expect(out).toMatch(/3 of 5/);
  });

  it('stays within the limit as room runs out, and adds nothing when there is none', () => {
    const saved: TaskAnswer[] = [{ question: 'q'.repeat(300), answered: true, answer: 'a'.repeat(300) }];
    for (const used of [OWNER_SUMMARY_MAX_CHARS - 200, OWNER_SUMMARY_MAX_CHARS - 70, OWNER_SUMMARY_MAX_CHARS - 20]) {
      const out = withSavedAnswers('y'.repeat(used), luigi, saved);
      expect(out.length).toBeLessThanOrEqual(OWNER_SUMMARY_MAX_CHARS);
      expect(out.startsWith('y'.repeat(used))).toBe(true);
    }
    expect(withSavedAnswers('y'.repeat(OWNER_SUMMARY_MAX_CHARS), luigi, saved)).toBe('y'.repeat(OWNER_SUMMARY_MAX_CHARS));
  });
});

describe('withFollowUps (#160)', () => {
  it('lists each request after the summary', () => {
    expect(withFollowUps('Banjo finished a call with Gemma.', ['A thing.', 'Another.'])).toBe(
      'Banjo finished a call with Gemma.\n\nThey asked you to follow up on:\n- A thing.\n- Another.',
    );
  });

  it('leaves the summary alone when there are none', () => {
    expect(withFollowUps('Summary.', [])).toBe('Summary.');
    expect(withFollowUps('Summary.', null)).toBe('Summary.');
  });

  it('falls back to a count when the list will not fit', () => {
    const result = withFollowUps('S'.repeat(80), ['x'.repeat(60), 'y'.repeat(60)], 150);
    expect(result).toBe(`${'S'.repeat(80)}\n\nThey asked you to follow up on 2 things: get_task_status has them.`);
    expect(result.length).toBeLessThanOrEqual(150);
  });
});
