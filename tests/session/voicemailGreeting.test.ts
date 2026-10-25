import { describe, expect, it } from 'vitest';
import { isCarrierPreamble, soundsLikeVoicemailGreeting } from '../../src/session/voicemailGreeting.js';

describe('soundsLikeVoicemailGreeting (#207)', () => {
  it.each([
    'Your call has been forwarded to voicemail.',
    "The person you're trying to reach is not available. At the tone, please record your message.",
    'Please leave a message after the beep.',
    "Hi, you've reached Dana. I can't come to the phone right now, leave your name and number.",
    'The mailbox of the number you have dialed is full.',
    'Your call has been forwarded to an automatic voice message system.',
  ])('hears a voicemail or carrier prompt: %s', (line) => {
    expect(soundsLikeVoicemailGreeting(line)).toBe(true);
  });

  it.each([
    'Hello?',
    'Paws and Claws, this is Robin, how can I help?',
    "Sorry, we're not available Saturday, how about Monday?",
    'Can you leave it with me and I will check?',
  ])('does not hear a person as voicemail: %s', (line) => {
    expect(soundsLikeVoicemailGreeting(line)).toBe(false);
  });
});

describe('isCarrierPreamble (#207)', () => {
  it('is a carrier line that has not yet asked for a message', () => {
    expect(isCarrierPreamble('Your call has been forwarded to voicemail.')).toBe(true);
    expect(isCarrierPreamble('Your call has been forwarded to an automatic voice message system.')).toBe(true);
  });

  it('is not a line that asks for the message, or a personal greeting', () => {
    expect(isCarrierPreamble('Your call has been forwarded to voicemail. At the tone, please record your message.')).toBe(false);
    expect(isCarrierPreamble("Hi, you've reached Dana. Leave a message.")).toBe(false);
    expect(isCarrierPreamble("Hi, it's Dana.")).toBe(false);
  });
});
