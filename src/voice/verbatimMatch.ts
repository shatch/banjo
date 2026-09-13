/**
 * Pure normalize-and-compare helper behind speak-then-verify verbatim
 * delivery (VoiceAIProvider.verbatimDeliveryReport in ./types.ts). A provider
 * with no verbatim-playback mechanism (openai-live) asks the model to say a
 * message word for word, then checks the transcript of what it actually said
 * against the intended text with this.
 *
 * Deliberately strict. A false "not matched" routes a voicemail to escalation
 * (the owner follows up — annoying, but honest); a false "matched" records a
 * message as delivered that the callee never heard, which is exactly the bug
 * docs/ARCHITECTURE.md's Open Risks #13 exists for. So normalization only
 * erases differences that cannot change what the callee heard — case,
 * punctuation, spacing, apostrophe style, and how a digit string is grouped or
 * spelled ("555-1234" vs "five five five, one two three four") — and extra
 * words are tolerated only AROUND the message (a lead-in like "Hi there."),
 * never inside it. Known false negatives, accepted on purpose: contractions
 * ("we'll" vs "we will") and spelled-out non-digit numbers ("twenty").
 */

const DIGIT_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

const ALL_DIGITS = /^\p{N}+$/u;

/** Exported for tests only — see verbatimMatches. */
export function normalizeForVerbatimMatch(text: string): string[] {
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['‘’]/g, '') // "we’ll" and "we'll" both -> "well", never "we ll" on one side only
    .replace(/(\p{N})(\p{L})/gu, '$1 $2') // "2:30pm" and "2:30 pm" tokenize the same
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => DIGIT_WORDS[word] ?? word);

  // Collapse runs of digit tokens so a number's grouping doesn't matter:
  // "555-1234", "555 1234", and "5 5 5 1 2 3 4" all become "5551234".
  const tokens: string[] = [];
  for (const word of words) {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && ALL_DIGITS.test(word) && ALL_DIGITS.test(last)) {
      tokens[tokens.length - 1] = last + word;
    } else {
      tokens.push(word);
    }
  }
  return tokens;
}

/**
 * True when `spoken`, normalized, contains `intended`, normalized, as one
 * contiguous run of words. An empty `intended` has nothing to verify and
 * always matches.
 */
export function verbatimMatches(intended: string, spoken: string): boolean {
  const want = normalizeForVerbatimMatch(intended);
  if (want.length === 0) return true;
  const got = normalizeForVerbatimMatch(spoken);
  for (let start = 0; start + want.length <= got.length; start++) {
    if (want.every((token, offset) => got[start + offset] === token)) return true;
  }
  return false;
}
