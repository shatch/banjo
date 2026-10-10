import { describe, expect, it } from 'vitest';
import { isCuttingIn, saidGoodbye } from '../../src/session/goodbye.js';

describe('saidGoodbye (#102)', () => {
  it.each([
    'Okay, take care—bye, Sam!',
    'Great, thanks — talk soon!',
    'Thanks so much — have a great day!',
    'Have a good one!',
    'Goodbye!',
    'Thank you, have a lovely evening.',
    'See you Friday!',
    'Good night!',
    'Thanks again for your help!',
    "I'll say goodbye now. Bye!",
    'Okay, goodbye then!',
    'Thanks so much, and goodbye!',
  ])('accepts a real goodbye: %s', (line) => {
    expect(saidGoodbye(line)).toBe(true);
  });

  it.each([
    // The live call in #102.
    "Okay, sounds like we're about ready to close this out together.",
    // The demo call before #47: thanks, but then it describes wrapping up instead of saying goodbye.
    'Great, thanks for confirming. Let me wrap this up.',
    "Perfect, that's all set. I'll say a quick goodbye and end the call.",
    'Got it. Is there anything else I can help with?',
    'Sure, Friday at 10 works.',
    // The live call in #139: the retry after a refusal talked about a goodbye.
    "Thanks for hanging on a second—I'll just finish this up with a proper goodbye.",
    'Let me just say goodbye properly.',
    'I wanted to end with a real goodbye.',
  ])('rejects a line with no goodbye: %s', (line) => {
    expect(saidGoodbye(line)).toBe(false);
  });
});

describe('isCuttingIn (#133)', () => {
  it.each([
    'Now let me tell you something.',
    'Hold on.',
    'Wait, one more thing.',
    'Actually, can you also ask about Saturday?',
    'Before you go, I wanted to ask you about the bill for last month.',
  ])('treats a redirect or a real sentence as cutting in: %s', (line) => {
    expect(isCuttingIn(line)).toBe(true);
  });

  it.each(['Bye!', 'Thanks, you too!', 'Okay, sounds good.', 'Mhm.', 'You too.', 'Take care.'])(
    "doesn't treat a goodbye or a short acknowledgement as cutting in: %s",
    (line) => {
      expect(isCuttingIn(line)).toBe(false);
    },
  );
});
