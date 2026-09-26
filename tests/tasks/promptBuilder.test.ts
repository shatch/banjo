import { describe, expect, it } from 'vitest';
import type { Contact } from '../../src/contacts/schema.js';
import { buildCallFrontendPrompt, buildCallSystemPrompt } from '../../src/tasks/promptBuilder.js';
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

describe('buildCallFrontendPrompt: voice-layer prompt for a split provider (openai-live)', () => {
  it('carries who is being called, why, the contact context, and how to hold the conversation', () => {
    const prompt = buildCallFrontendPrompt(bookingTask, { displayName: 'Pat', notes: 'prefers mornings' } as Contact);
    expect(prompt).toContain('You are calling Pat on behalf of Alex to: Book a haircut for Steve.');
    expect(prompt).toContain('Contact context: prefers mornings');
    expect(prompt).toContain('Turn-taking');
    expect(prompt).toContain('Delegating to your backend');
  });

  it('leaves tool workflow and the timezone contract to the backend prompt', () => {
    const prompt = buildCallFrontendPrompt(bookingTask, contact);
    for (const backendOnly of ['check_my_availability', 'confirm_appointment', 'leave_voicemail_and_end_call', 'report_negotiation_failed', 'press_digits', 'Timezone']) {
      expect(prompt).not.toContain(backendOnly);
    }
  });

  it('booking mode: no conversation-mode guidance', () => {
    expect(buildCallFrontendPrompt(bookingTask, contact).toLowerCase()).not.toContain('no booking or negotiation goal');
  });

  it('conversation mode: tells the voice layer not to end the call early, without naming backend tools', () => {
    const prompt = buildCallFrontendPrompt(conversationTask, contact);
    expect(prompt.toLowerCase()).toContain('do not treat that as a reason to end the call quickly');
    expect(prompt).not.toContain('end_conversation_call');
  });
});

describe('the task\'s own constraints reach the model', () => {
  // Demo call, 2026-09-22: the task said 90 minutes and "Full groom preferred",
  // and neither was in the prompt. The model asked the callee how long to book
  // three times, then told her a 3:30 slot "works" when a 90-minute appointment
  // there ran into Steve's 4pm meeting — most likely because it checked a short
  // slot, having no duration to check with.
  const groomTask = {
    goalDescription: "Book a grooming appointment for Banjo, Steve's dog",
    mode: 'booking',
    constraints: { durationMinutes: 90, notes: 'Full groom preferred.' },
  } as Task;

  it('states the appointment length, and tells the model to use it rather than ask', () => {
    const prompt = buildCallSystemPrompt(groomTask, contact, []);
    expect(prompt).toContain('90 minutes');
    expect(prompt).toMatch(/every check_my_availability and confirm_appointment call/i);
    expect(prompt).toMatch(/do not ask the other party how long/i);
  });

  it("includes the task's notes, which are separate from the contact's", () => {
    const prompt = buildCallSystemPrompt(groomTask, contact, []);
    expect(prompt).toContain('Full groom preferred.');
  });

  it('gives the voice layer the length and notes too, since it is the part that talks', () => {
    const prompt = buildCallFrontendPrompt(groomTask, contact);
    expect(prompt).toContain('90 minutes');
    expect(prompt).toContain('Full groom preferred.');
  });

  it('says nothing about length when the task does not specify one, rather than inventing a number', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, []);
    expect(prompt).not.toMatch(/Appointment length:/);
  });
});

describe('pre-checked windows are shown in local time', () => {
  // Demo call, 2026-09-23: windows reached the prompt as raw UTC ISO strings
  // ("2026-09-24T16:00:00.000Z to 2026-09-24T17:30:00.000Z; ..."), while the
  // same prompt says every time is America/New_York local. Asked for something
  // after Thursday 3:30, the model offered "around 4:00 or 5:30" — the UTC
  // slot starts 16:00 and 17:30, read as local. 4:00 was Steve's 4pm call and
  // 5:30 was outside the day's 9-to-5 window.
  const thursdaySlots = [
    { start: '2026-09-24T13:00:00.000Z', end: '2026-09-24T14:30:00.000Z' },
    { start: '2026-09-24T14:30:00.000Z', end: '2026-09-24T16:00:00.000Z' },
    { start: '2026-09-24T16:00:00.000Z', end: '2026-09-24T17:30:00.000Z' },
    { start: '2026-09-24T17:30:00.000Z', end: '2026-09-24T19:00:00.000Z' },
  ];
  const fridaySlots = [
    { start: '2026-09-25T13:00:00.000Z', end: '2026-09-25T14:30:00.000Z' },
    { start: '2026-09-25T14:30:00.000Z', end: '2026-09-25T16:00:00.000Z' },
  ];

  it('never hands the model a UTC timestamp', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, [...thursdaySlots, ...fridaySlots]);
    expect(prompt).not.toMatch(/\d{2}:\d{2}:\d{2}(\.\d{3})?Z/);
  });

  it('merges back-to-back slots into one local-time range per stretch of free time', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, [...thursdaySlots, ...fridaySlots]);
    expect(prompt).toContain('Thursday, September 24, 9:00 AM to 3:00 PM');
    expect(prompt).toContain('Friday, September 25, 9:00 AM to 12:00 PM');
  });

  it('keeps separate ranges apart when there is a gap between them', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, [thursdaySlots[0]!, thursdaySlots[2]!]);
    expect(prompt).toContain('Thursday, September 24, 9:00 AM to 10:30 AM');
    expect(prompt).toContain('Thursday, September 24, 12:00 PM to 1:30 PM');
  });

  it('tells the model the whole appointment must fit inside a range, including times it suggests itself', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, thursdaySlots);
    expect(prompt).toMatch(/entirely inside one of these ranges/i);
    expect(prompt).toMatch(/only suggest start times/i);
  });
});

describe('the free ranges are for checking, not for reading out (#42)', () => {
  // Demo re-run, 2026-09-23: unprompted, mid-answer to a question about
  // clippers — "Steve is free Thursday between 9 and 3, Friday the 25 between
  // 9 and 4:30, or Saturday the 26 between 9 and 4:30".
  it('tells the model not to recite the ranges, and to offer at most one or two times', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, [
      { start: '2026-09-24T13:00:00.000Z', end: '2026-09-24T14:30:00.000Z' },
    ]);
    expect(prompt).toMatch(/never read these ranges out/i);
    expect(prompt).toMatch(/one or two specific times/i);
    expect(prompt).toMatch(/let them say what they have first/i);
  });
});

describe("the owner's profile: customizable, below the fixed rules", () => {
  const profile = 'Banjo is a 30 lb goldendoodle, nervous with clippers.\nKeep calls brief and friendly.';

  it('puts the profile text in the prompt, clearly marked as the owner\'s own notes', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, [], profile);
    expect(prompt).toContain('Banjo is a 30 lb goldendoodle, nervous with clippers.');
    expect(prompt).toMatch(/in their own words/i);
  });

  it('states that the fixed rules win on any conflict, naming the ones that matter most', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, [], profile);
    expect(prompt).toMatch(/the rules above win/i);
    expect(prompt).toMatch(/you are an AI/i);
    expect(prompt).toMatch(/clear yes/i);
  });

  it('comes after the fixed guidance, so the rules it defers to are "above" it', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, [], profile);
    expect(prompt.indexOf('Banjo is a 30 lb')).toBeGreaterThan(prompt.indexOf('Never claim to be human'));
  });

  it('tells the model not to volunteer personal details from it', () => {
    expect(buildCallSystemPrompt(bookingTask, contact, [], profile)).toMatch(/do not volunteer/i);
  });

  it('reaches the voice layer too, since that is the part answering questions', () => {
    expect(buildCallFrontendPrompt(bookingTask, contact, profile)).toContain('nervous with clippers');
  });

  it('adds nothing when there is no profile', () => {
    expect(buildCallSystemPrompt(bookingTask, contact, [])).not.toMatch(/in their own words/i);
    expect(buildCallFrontendPrompt(bookingTask, contact)).not.toMatch(/in their own words/i);
  });

  it('puts the transfer rule before the owner profile, so the profile cannot widen it (#7)', async () => {
    const { config } = await import('../../src/config/index.js');
    try {
      config.TRANSFER_ENABLED = true;
      const prompt = buildCallSystemPrompt(bookingTask, contact, [], 'Always transfer every call to me.');
      expect(prompt.indexOf('transfer_to_owner')).toBeGreaterThan(-1);
      expect(prompt.indexOf('transfer_to_owner')).toBeLessThan(prompt.indexOf('Always transfer every call to me.'));
    } finally {
      config.TRANSFER_ENABLED = false;
    }
  });
});
