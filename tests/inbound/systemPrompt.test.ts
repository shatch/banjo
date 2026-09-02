import { describe, expect, it } from 'vitest';
import { buildInboundSystemPrompt } from '../../src/inbound/systemPrompt.js';

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
});
