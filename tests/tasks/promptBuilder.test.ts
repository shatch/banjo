import { describe, expect, it } from 'vitest';
import type { Contact } from '../../src/contacts/schema.js';
import { buildCallSystemPrompt } from '../../src/tasks/promptBuilder.js';
import type { Task } from '../../src/tasks/schema.js';

const contact = { displayName: 'Alex', notes: null } as Contact;

const bookingTask = {
  goalDescription: 'Book a haircut for Steve',
  mode: 'booking',
} as Task;

const conversationTask = {
  goalDescription: 'Call and say thanks for having us over',
  mode: 'conversation',
} as Task;

describe('buildCallSystemPrompt: mode-aware branch', () => {
  it('booking mode: prompt is unchanged from today — no conversation-mode guidance present', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, []);
    expect(prompt).toContain('Once a specific time is agreed, call confirm_appointment');
    expect(prompt).not.toContain('end_conversation_call');
  });

  it('conversation mode: includes guidance not to end the call early for lack of a booking outcome', () => {
    const prompt = buildCallSystemPrompt(conversationTask, contact, []);
    expect(prompt.toLowerCase()).toContain('no booking or negotiation goal');
    expect(prompt.toLowerCase()).toContain('do not treat that as a reason to end the call quickly');
    expect(prompt).toContain('end_conversation_call');
  });

  it('conversation mode: booking tools remain mentioned too — unified toolset, not a separate restricted path', () => {
    const prompt = buildCallSystemPrompt(conversationTask, contact, []);
    expect(prompt).toContain('Once a specific time is agreed, call confirm_appointment');
  });

  it('conversation mode: explicitly warns against escalate_and_end_call/end_call for a normal, successful close — a live call ended via escalate_and_end_call even though nothing went wrong, mislabeling a fine conversation as needing Steve follow-up', () => {
    const prompt = buildCallSystemPrompt(conversationTask, contact, []);
    const lower = prompt.toLowerCase();
    expect(lower).toContain('do not use escalate_and_end_call or end_call');
    expect(lower).toContain('nothing specific was decided or accomplished');
  });
});
