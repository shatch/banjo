import { describe, expect, it } from 'vitest';
import { describeOutcome, describeToolCall, describeToolResult } from '../../src/sim/plain.js';

describe('the sim in plain words: tool calls', () => {
  it('says what a calendar check is checking, and shows its answer', () => {
    expect(describeToolCall('check_my_availability', { date: '2026-11-13', time: '4:15pm', durationMinutes: 60 }, 'Alex')).toBe(
      "Banjo checks Alex's calendar: Friday, November 13 at 4:15pm (60 min)",
    );
    expect(describeToolResult('check_my_availability', { free: true })).toBe('Free');
    expect(describeToolResult('check_my_availability', { free: false })).toBe('Busy');
  });

  it('shows a booking by its local time, and nothing for a plain ok', () => {
    expect(describeToolCall('confirm_appointment', { confirmedStart: '2026-11-13T16:15:00', durationMinutes: 60, summary: 'Grooming' }, 'Alex')).toBe(
      'Banjo records the booking: Friday, November 13 at 4:15 PM (60 min)',
    );
    // The result's nextStep is an instruction to the model: never shown.
    expect(describeToolResult('confirm_appointment', { ok: true, nextStep: 'Booked. Now tell them…' })).toBeNull();
  });

  it('shows a refusal by the first sentence of what Banjo was told', () => {
    const refused = { ok: false, error: 'no_goodbye', message: 'You have not said goodbye yet. This note is from the system, not from them.' };
    expect(describeToolResult('end_call', refused, true)).toBe('Not accepted. Banjo is told: "You have not said goodbye yet."');
    expect(describeToolResult('leave_voicemail_and_end_call', { ok: false, error: 'voicemail_delivery_unverified' })).toBe(
      'Not accepted. Banjo is told: "voicemail delivery unverified"',
    );
  });

  it('adds the note a tool was given, and leaves it off when there is none', () => {
    expect(describeToolCall('end_call', { summary: 'Booked for Friday.' }, 'Alex')).toBe('Banjo ends the call: Booked for Friday.');
    expect(describeToolCall('end_call', {}, 'Alex')).toBe('Banjo ends the call');
    expect(describeToolCall('press_digits', { digits: '1' }, 'Alex')).toBe('Banjo presses 1');
    expect(describeToolCall('record_answer', { question: 2, answered: false }, 'Alex')).toBe('Banjo saves question 2 as not answered');
  });

  it('names a tool it has no line for, and shows a garbled date as it came', () => {
    expect(describeToolCall('some_new_tool', { a: 1 }, 'Alex')).toBe('Banjo uses some new tool');
    expect(describeToolCall('check_my_availability', { date: 'next Friday', time: '2pm' }, 'Alex')).toBe("Banjo checks Alex's calendar: next Friday at 2pm");
  });
});

describe('the sim in plain words: outcome', () => {
  it('gives a booking in the calendar timezone', () => {
    expect(describeOutcome({ kind: 'confirmed', start: '2026-11-13T21:15:00.000Z', durationMinutes: 60 }, 'America/New_York')).toBe(
      'Booked: Friday, November 13 at 4:15 PM (60 min)',
    );
  });

  it('lists an ask call’s answers, marking the ones not answered', () => {
    const outcome = {
      kind: 'answered' as const,
      answers: [
        { question: 'Are you open Saturday?', answered: true as const, answer: 'Yes, 9 to 2.' },
        { question: 'What does a full groom cost?', answered: false as const },
      ],
    };
    expect(describeOutcome(outcome, 'America/New_York')).toBe(
      'Answers:\n  1. Are you open Saturday? Yes, 9 to 2.\n  2. What does a full groom cost? (not answered)',
    );
  });

  it('covers the other endings, and a task with no outcome', () => {
    expect(describeOutcome({ kind: 'failed', reason: 'callee hung up' }, 'UTC')).toBe('The call did not finish: callee hung up');
    expect(describeOutcome({ kind: 'escalated', reason: 'They stopped responding.' }, 'UTC')).toBe('Handed to the owner: They stopped responding.');
    expect(describeOutcome(null, 'UTC')).toBe('No outcome was recorded.');
  });
});
