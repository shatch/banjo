import { describe, expect, it } from 'vitest';
import { buildInboundFrontendPrompt, buildInboundSystemPrompt } from '../../src/inbound/systemPrompt.js';

describe('buildInboundSystemPrompt', () => {
  it('states the configured business-hours bound in human-readable form', () => {
    const prompt = buildInboundSystemPrompt();
    expect(prompt).toContain('Monday, Tuesday, Wednesday, Thursday, Friday');
    expect(prompt).toContain('9:00am');
    expect(prompt).toContain('5:00pm');
  });

  it('includes the security instruction never to describe another booking', () => {
    const prompt = buildInboundSystemPrompt();
    expect(prompt).toContain('can never see or act on any');
    expect(prompt.toLowerCase()).toContain('never describe, confirm, or hint at any other event');
  });

  it('names every inbound tool', () => {
    const prompt = buildInboundSystemPrompt();
    for (const tool of [
      'check_availability',
      'suggest_times',
      'book_appointment',
      'find_my_booking',
      'reschedule_booking',
      'flag_for_owner_and_end_call',
    ]) {
      expect(prompt).toContain(tool);
    }
  });

  it('includes the shared inbound identity line from buildBaseSystemPromptGuidance', () => {
    expect(buildInboundSystemPrompt()).toContain("answering an inbound phone call on Alex's behalf");
  });

  it('does not promise the model a cancel capability that no tool provides', () => {
    const prompt = buildInboundSystemPrompt();
    expect(prompt).not.toMatch(/check, change, or cancel/i);
    expect(prompt.toLowerCase()).toContain('not cancelling');
    expect(prompt).toContain('flag_for_owner_and_end_call');
  });

  it('instructs the model to ask for and confirm the caller\'s name before booking', () => {
    const prompt = buildInboundSystemPrompt();
    expect(prompt).toContain("ask for and confirm the caller's name");
  });

  it('tells the model the reschedule name carries over automatically, and not to re-ask for it', () => {
    const prompt = buildInboundSystemPrompt();
    expect(prompt).not.toContain("confirm the caller's name again");
    expect(prompt.toLowerCase()).toContain('do not ask');
    expect(prompt.toLowerCase()).toContain('restate their name to reschedule');
    expect(prompt).toContain('reschedule_booking with just the new date and time');
  });

  it('tells the model to read back the name already on file from find_my_booking', () => {
    const prompt = buildInboundSystemPrompt();
    expect(prompt.toLowerCase()).toContain("caller's name already on file");
  });

  it('instructs the model to state the new confirmed time and say goodbye before ending the call after a successful reschedule', () => {
    const prompt = buildInboundSystemPrompt();
    expect(prompt).toContain('If reschedule_booking succeeds, restate the new confirmed date and time');
    expect(prompt.toLowerCase()).toContain('goodbye');
  });

  it('proactively offers to flag an out-of-hours request for the assistant\'s owner, instead of only repeating in-hours alternatives', () => {
    const prompt = buildInboundSystemPrompt();
    expect(prompt).toContain('outside_business_hours');
    expect(prompt.toLowerCase()).toContain("can't be moved");
    expect(prompt.toLowerCase()).toContain('proactively offer to flag it for alex');
  });

  it('produces byte-for-byte the same prompt with no caller context as with an explicit undefined', () => {
    expect(buildInboundSystemPrompt()).toBe(buildInboundSystemPrompt(undefined));
  });

  it('adds a warm, name-based greeting instruction for a family-tier caller, without changing capability', () => {
    const withFamily = buildInboundSystemPrompt({ displayName: 'Mom', relationshipTier: 'family', isFrequent: false });
    expect(withFamily).toContain('Mom');
    expect(withFamily.toLowerCase()).toContain('family member');
    expect(withFamily.toLowerCase()).toContain('warmly');
    // Capability is unchanged — the same booking tools/instructions still appear.
    expect(withFamily).toContain('book_appointment');
    expect(withFamily).toContain('find_my_booking');
  });

  it('adds a "welcome back" instruction for a frequent, untiered caller', () => {
    const withFrequent = buildInboundSystemPrompt({ displayName: 'Regular Client', relationshipTier: null, isFrequent: true });
    expect(withFrequent).toContain('Regular Client');
    expect(withFrequent.toLowerCase()).toContain('welcome back');
  });

  it('does not personalize for a recognized-but-ordinary, infrequent caller', () => {
    // No relationshipTier and not frequent — greetingContext itself
    // shouldn't be constructed for this case (see callerContext.test.ts),
    // but the prompt builder must also produce the generic prompt if it
    // somehow were passed one with both signals false.
    const result = buildInboundSystemPrompt({ displayName: 'Anyone', relationshipTier: null, isFrequent: false });
    expect(result).toBe(buildInboundSystemPrompt());
  });
});

describe('buildInboundFrontendPrompt: voice-layer prompt for a split provider (openai-live)', () => {
  it('keeps the inbound identity line', () => {
    expect(buildInboundFrontendPrompt()).toContain("answering an inbound phone call on Alex's behalf");
  });

  it('repeats the never-describe-another-booking security instruction — the voice layer is what talks about the calendar out loud', () => {
    expect(buildInboundFrontendPrompt().toLowerCase()).toContain('never describe, confirm, or hint at any other event');
  });

  it('does not promise a cancel capability', () => {
    const prompt = buildInboundFrontendPrompt();
    expect(prompt).toContain('Cancelling a booking is not supported');
    expect(prompt).toContain('do not tell them it has');
  });

  it('names no backend tool', () => {
    const prompt = buildInboundFrontendPrompt();
    for (const tool of ['check_availability', 'suggest_times', 'book_appointment', 'find_my_booking', 'reschedule_booking', 'flag_for_owner_and_end_call']) {
      expect(prompt).not.toContain(tool);
    }
  });

  it('carries the same warm greeting guidance as the full prompt for a family-tier caller', () => {
    const prompt = buildInboundFrontendPrompt({ displayName: 'Mom', relationshipTier: 'family', isFrequent: false });
    expect(prompt).toContain('Mom');
    expect(prompt.toLowerCase()).toContain('family member');
  });
});
