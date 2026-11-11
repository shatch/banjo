import { describe, expect, it } from 'vitest';
import { isCuttingIn, isLeaving, isSigningOff, narratesEnding, narrationStart, saidGoodbye } from '../../src/session/goodbye.js';

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
    // #167, live ask call 2026-10-14: the retry after a refusal thanked them
    // and talked about a goodbye, and passed on the "thanks".
    "Okay, thanks for that—I'll close with a quick goodbye now.",
    'Thanks so much, I just need to say a proper goodbye.',
    // #167, sim: a closing line with thanks but no sign-off.
    "Thanks, that's helpful. I just have what I need for today.",
    "Great, thanks. That's all I needed.",
    "Thanks, I've got everything I need.",
  ])('rejects a line with no goodbye: %s', (line) => {
    expect(saidGoodbye(line)).toBe(false);
  });

  it('gives the same answer when asked twice (no state carried between calls)', () => {
    const line = "Okay, thanks for that—I'll close with a quick goodbye now.";
    expect(saidGoodbye(line)).toBe(saidGoodbye(line));
    expect(saidGoodbye('Thanks again for your help!')).toBe(true);
    expect(saidGoodbye('Thanks again for your help!')).toBe(true);
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

describe('isSigningOff (#144)', () => {
  it.each([
    // Live calls (2026-10-13): each was followed by a narrated goodbye.
    "Okay, thanks. Thanks. That's all.",
    "That's everything, thanks.",
    "I think we're good.",
    "Okay, thanks, that's all I needed.",
    'Bye now!',
    'Thank you so much.',
    "No, we're all set.",
    "That's it for me.",
  ])('treats a done signal as signing off: %s', (line) => {
    expect(isSigningOff(line)).toBe(true);
  });

  it.each([
    'Mhm.',
    'Okay.',
    'Yes, I wanna watch it right now.',
    'Thanks, but can you also ask about Saturday?',
    'Thank you. What time was that again?',
    "That's all fine, but hold on a second.",
    'Before you go, one more thing.',
  ])("doesn't treat an acknowledgement, a question or a redirect as signing off: %s", (line) => {
    expect(isSigningOff(line)).toBe(false);
  });
});

describe('narratesEnding (#154)', () => {
  it.each([
    // Live calls, 2026-10-12 to 2026-11-02: each was heard before the fixed goodbye.
    'Okay, I\'m glad that helped. Let me wrap up with a quick note.',
    'Okay, got it—let\'s wrap this up quickly so you can get back to your show.',
    'Sounds good—let me just wrap this up with a polite sign-off and a quick summary.',
    "Got it, I'll wrap this up warmly.",
    "You're welcome — let me say a quick goodbye and close things out.",
    "Understood. I'll go ahead and end the call. Take care!",
  ])('catches a line that describes the ending: %s', (line) => {
    expect(narratesEnding(line)).toBe(true);
  });

  it.each([
    "You're welcome — take care, bye!",
    "That's all I need, thanks so much — bye!",
    'First, what time do you close on Saturdays?',
    'Great, see you Thursday at 3!',
    'Okay, take care. Bye!',
  ])("doesn't catch a real goodbye or an ordinary line: %s", (line) => {
    expect(narratesEnding(line)).toBe(false);
  });
});

describe('narrationStart (#154)', () => {
  it('points at where the narration begins, so what comes before is what was meant to be heard', () => {
    const line = "Got it, I'll wrap this up warmly.";
    expect(line.slice(0, narrationStart(line))).toBe("Got it, I'll ");
    expect(narrationStart('Okay, take care. Bye!')).toBe(-1);
  });
});

describe('isLeaving (#154)', () => {
  it.each(["Sorry, I have to go, I'm watching my show.", 'I gotta run.', 'I need to get back to work.', "I'm in the middle of dinner."])(
    'catches them saying they have to go: %s',
    (line) => {
      expect(isLeaving(line)).toBe(true);
    },
  );

  it.each(['Can we do Thursday instead?', 'Go ahead.', "I'll go with the 3 o'clock."])("doesn't catch an ordinary line: %s", (line) => {
    expect(isLeaving(line)).toBe(false);
  });
});
