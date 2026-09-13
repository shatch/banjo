import { describe, expect, it } from 'vitest';
import { normalizeForVerbatimMatch, verbatimMatches } from '../../src/voice/verbatimMatch.js';

const MESSAGE = "Hi, this is Alex's assistant calling to book a haircut. Please call back at 555-1234. Thanks!";

describe('verbatimMatches: tolerated differences (cannot change what the callee heard)', () => {
  it('matches an exact transcript', () => {
    expect(verbatimMatches(MESSAGE, MESSAGE)).toBe(true);
  });

  it('ignores case, punctuation, and whitespace', () => {
    expect(verbatimMatches(MESSAGE, "hi this is alex's   assistant calling to book a haircut please call back at 555 1234 thanks")).toBe(true);
  });

  it('treats a phone number the same however its digits are grouped or spelled', () => {
    const intended = 'Please call back at 555-1234.';
    expect(verbatimMatches(intended, 'Please call back at 5551234.')).toBe(true);
    expect(verbatimMatches(intended, 'Please call back at five five five, one two three four.')).toBe(true);
    expect(verbatimMatches(intended, 'Please call back at 5 5 5 1 2 3 4.')).toBe(true);
  });

  it('treats a time the same with or without a space before am/pm', () => {
    expect(verbatimMatches('See you at 2:30pm.', 'See you at 2:30 PM.')).toBe(true);
  });

  it('treats curly and straight apostrophes the same', () => {
    expect(verbatimMatches("We'll see you then.", 'We’ll see you then.')).toBe(true);
  });

  it('tolerates extra words before and after the message', () => {
    expect(verbatimMatches(MESSAGE, `Oh, hello there. ${MESSAGE} Goodbye.`)).toBe(true);
  });

  it('an empty intended message has nothing to verify', () => {
    expect(verbatimMatches('', '')).toBe(true);
    expect(verbatimMatches('   ', 'anything')).toBe(true);
  });
});

describe('verbatimMatches: rejected differences (the callee heard something else)', () => {
  it('rejects nothing spoken at all', () => {
    expect(verbatimMatches(MESSAGE, '')).toBe(false);
  });

  it('rejects a truncated message — the exact live failure Open Risks #13 describes', () => {
    expect(verbatimMatches(MESSAGE, "Hi, this is Alex's assistant calling to book a haircut.")).toBe(false);
  });

  it('rejects a wrong digit in the callback number', () => {
    expect(verbatimMatches(MESSAGE, MESSAGE.replace('555-1234', '555-1243'))).toBe(false);
  });

  it('rejects a substituted word', () => {
    expect(verbatimMatches(MESSAGE, MESSAGE.replace('haircut', 'massage'))).toBe(false);
  });

  it('rejects a word inserted inside the message', () => {
    expect(verbatimMatches(MESSAGE, MESSAGE.replace('Please call', 'Please do call'))).toBe(false);
  });

  it('rejects a paraphrase', () => {
    expect(verbatimMatches(MESSAGE, "Hey, it's Alex's assistant — give us a ring at 555-1234 about the haircut.")).toBe(false);
  });

  it('rejects a contraction the model expanded — an accepted false negative, not a silent pass', () => {
    expect(verbatimMatches("We'll see you then.", 'We will see you then.')).toBe(false);
  });
});

describe('normalizeForVerbatimMatch', () => {
  it('splits digits from letters and collapses digit runs', () => {
    expect(normalizeForVerbatimMatch('Call 555-1234 at 2:30pm')).toEqual(['call', '5551234', 'at', '230', 'pm']);
  });
});
