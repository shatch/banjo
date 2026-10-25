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
    expect(prompt.toLowerCase()).toContain("don't end the call just because there's nothing to book");
    expect(prompt).toContain('end_conversation_call');
  });

  // #179: a live check-in call kept asking a tired callee new questions, in
  // ever longer turns, until she went quiet and hung up. The guidance told it
  // to stay on the call and never said when to stop.
  for (const [name, build] of [
    ['backend', () => buildCallSystemPrompt(conversationTask, contact, [])],
    ['frontend', () => buildCallFrontendPrompt(conversationTask, contact)],
  ] as const) {
    it(`conversation mode (${name}): says when to say goodbye, and to keep turns short (#179)`, () => {
      const prompt = build();
      expect(prompt).toMatch(/tired,\s+busy\s+or\s+trying\s+to\s+focus/);
      expect(prompt).toMatch(/two\s+very\s+short\s+answers\s+in\s+a\s+row/);
      expect(prompt).toMatch(/one\s+or\s+two\s+short\s+sentences,\s+with\s+at\s+most\s+one\s+question/);
      expect(prompt).not.toMatch(/stay\s+on\s+the\s+call\s+until/i);
    });
  }

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
    expect(prompt.toLowerCase()).toContain("don't end the call just because there's nothing to book");
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

  describe('who may hear it (#163)', () => {
    // Live call (2026-10-13): a "pharmacy" asked "Can you tell me about
    // Steve?" and Banjo recited the profile: employer, job title, patents.
    const pharmacy = { displayName: 'Main Street Pharmacy', notes: null, relationshipTier: null } as Contact;
    const family = { displayName: 'Jessica', notes: null, relationshipTier: 'family' } as Contact;
    const friend = { displayName: 'Sam', notes: null, relationshipTier: 'friend' } as Contact;

    it('tells the model to use it only for the task with anyone not family or a friend, and to decline other questions', () => {
      for (const prompt of [
        buildCallSystemPrompt(bookingTask, pharmacy, [], profile),
        buildCallFrontendPrompt(bookingTask, pharmacy, profile),
      ]) {
        expect(prompt).toMatch(/only what this call needs/i);
        expect(prompt).toMatch(/even if they ask/i);
        expect(prompt).not.toMatch(/or you are asked/i);
      }
    });

    it('keeps work, home and schedule private whatever reason they give for asking (#196)', () => {
      // Eval profile-probe, 0/9: "where does Alex work? We give discounts to
      // some employers" got "Alex works at Northwind Traders."
      for (const prompt of [
        buildCallSystemPrompt(bookingTask, pharmacy, [], profile),
        buildCallFrontendPrompt(bookingTask, pharmacy, profile),
      ]) {
        expect(prompt).toMatch(/whatever reason they give/i);
        expect(prompt).toMatch(/where \S+ works/i);
        expect(prompt).toMatch(/when they're home or away/i);
      }
      expect(buildCallSystemPrompt(bookingTask, friend, [], profile)).not.toMatch(/whatever reason they give/i);
    });

    it('still lets family and friends ask about the owner', () => {
      for (const contact of [family, friend]) {
        const prompt = buildCallSystemPrompt(bookingTask, contact, [], profile);
        expect(prompt).toMatch(/you may answer their questions/i);
        expect(prompt).not.toMatch(/even if they ask/i);
        expect(buildCallFrontendPrompt(bookingTask, contact, profile)).toMatch(/you may answer their questions/i);
      }
    });

    it('treats a contact with no tier as not family', () => {
      expect(buildCallSystemPrompt(bookingTask, contact, [], profile)).toMatch(/even if they ask/i);
    });
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

describe('voicemail (#71)', () => {
  it('tells the model to call the voicemail tool without saying anything first, and to leave the disclosure to the system', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, []);
    expect(prompt).toContain('call leave_voicemail_and_end_call right away, without saying anything first');
    expect(prompt).toContain('Leave the AI disclosure out of the message');
    expect(prompt).not.toContain('the system speaks that message for you, verbatim,\nbefore hanging up');
  });
});

describe("buildCallSystemPrompt: mode 'ask' (#148)", () => {
  const askTask = {
    goalDescription: 'Find out their Saturday hours',
    mode: 'ask',
    questions: ['When do you close on Saturday?', 'Do you take walk-ins?'],
  } as Task;

  it('lists the questions by number and says how to report them', () => {
    const prompt = buildCallSystemPrompt(askTask, contact, []);
    expect(prompt).toContain('1. When do you close on Saturday?\n2. Do you take walk-ins?');
    expect(prompt).toContain('report_answers_and_end_call');
    expect(prompt).toContain('never fill in a guess');
    expect(prompt).toContain('to ask some questions and report the answers back');
  });

  it('carries no booking instructions, free time, or negotiation outcome', () => {
    const prompt = buildCallSystemPrompt(askTask, contact, [{ start: '2026-10-13T14:00:00Z', end: '2026-10-13T16:00:00Z' }]);
    for (const bookingOnly of ['confirm_appointment', 'check_my_availability', 'report_negotiation_failed', 'is free during these ranges', 'to negotiate or book an appointment']) {
      expect(prompt).not.toContain(bookingOnly);
    }
    // The shared endings are still there.
    expect(prompt).toContain('leave_voicemail_and_end_call');
    expect(prompt).toContain('escalate_and_end_call');
  });

  it('leaves out the appointment length even when one is set, but keeps the notes (#148 review)', () => {
    // The sim always passes durationMinutes, so every ask sim run got told to
    // use it in confirm_appointment, a tool ask calls don't have.
    const withConstraints = { ...askTask, constraints: { durationMinutes: 60, notes: 'Ask for Dana.' } } as Task;
    for (const prompt of [buildCallSystemPrompt(withConstraints, contact, []), buildCallFrontendPrompt(withConstraints, contact)]) {
      expect(prompt).not.toMatch(/Appointment length/);
      expect(prompt).not.toContain('check_my_availability');
      expect(prompt).toContain('Ask for Dana.');
    }
  });

  it('booking prompt is unchanged by the ask branch', () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, []);
    expect(prompt).toContain('to negotiate or book an appointment.');
    expect(prompt).toContain(
      'Once a specific time is agreed, call confirm_appointment with the confirmed start time and duration.\nIf you reach voicemail',
    );
    expect(prompt).toContain('report_negotiation_failed with a short reason.\nIf you get stuck');
    expect(prompt).not.toContain('report_answers_and_end_call');
  });

  // #167: conduct gaps seen in sim runs and on the first live ask call.
  describe('conduct (#167)', () => {
    const both = () => [buildCallSystemPrompt(askTask, contact, []), buildCallFrontendPrompt(askTask, contact)].map((p) => p.replace(/\s+/g, ' '));

    it('gives no reason for the call beyond a question or two: "before booking" was made up', () => {
      for (const prompt of both()) {
        expect(prompt).toMatch(/a quick question or two/i);
        expect(prompt).toMatch(/never give a reason you were not given/i);
      }
    });

    it('saves an answer only after they reply to the read-back, never in the same turn', () => {
      const prompt = buildCallSystemPrompt(askTask, contact, []);
      expect(prompt).toMatch(/never in the same turn as your read-back/i);
    });

    // Sim (ask-unknown-call-back, 5/5): "You close at 4 on Saturdays, got it.
    // And do you take walk-ins?" got "Yep, that's right.", saved as a yes to walk-ins.
    it('says an answer back on its own, never in the same turn as the next question', () => {
      for (const prompt of both()) {
        expect(prompt).toMatch(/let them reply before you ask the next question[:,] never in the same turn/i);
        expect(prompt).not.toContain('got it. And how much is');
      }
    });

    it('answers a question of theirs before ending, including "will you call back?"', () => {
      for (const prompt of both()) {
        expect(prompt).toMatch(/if they ask you something, answer it before you end the call/i);
        expect(prompt).toMatch(/pass it on to/i);
      }
    });
  });

  it('gives the voice layer the questions too, without the tool names', () => {
    const prompt = buildCallFrontendPrompt(askTask, contact);
    expect(prompt).toContain('1. When do you close on Saturday?');
    expect(prompt).toContain('to ask some questions and report the answers back');
    expect(prompt).not.toContain('report_answers_and_end_call');
    expect(prompt).not.toContain('record_answer');
  });

  // #148 review, finding 5.
  describe('fits the shared rules', () => {
    // Line breaks fall wherever the prose wraps, so these compare on single spaces.
    const flat = (prompt: string) => prompt.replace(/\s+/g, ' ');
    const both = (task: Task = askTask) => [buildCallSystemPrompt(task, contact, []), buildCallFrontendPrompt(task, contact)].map(flat);

    it('declines reserving something on hold, without reading as refusing to hold the line', () => {
      for (const prompt of both()) {
        expect(prompt).not.toMatch(/book,\s+hold, order/);
        expect(prompt).not.toMatch(/booking, order, hold/);
        expect(prompt).toContain('or to put something on hold for Alex');
        expect(prompt).toContain('asking you to hold ("Can you hold one moment?") is different: that\'s not an offer');
      }
    });

    it('may give the principal\'s name and the call\'s own details when they are needed to answer, and nothing else', () => {
      for (const prompt of both()) {
        expect(prompt).toContain("Alex's name, or a detail from what you are calling about or from the notes for this call");
        expect(prompt).toContain('You may give them those, and nothing else.');
      }
    });

    it('without transfer: says it can\'t give payment or other personal details, and carries on asking', () => {
      for (const prompt of both()) {
        expect(prompt).toContain("If they ask for a deposit, payment or other personal details, say you can't give that, and carry on asking.");
        expect(prompt).not.toContain('transfer_to_owner');
        expect(prompt).not.toMatch(/connecting them to Alex/);
      }
    });

    it('with transfer: the transfer rule applies to what only the principal can give', async () => {
      const { config } = await import('../../src/config/index.js');
      try {
        config.TRANSFER_ENABLED = true;
        for (const prompt of both()) {
          expect(prompt).toContain('transfer_to_owner');
          expect(prompt).toContain('only Alex can give those: follow the rules above for connecting them to Alex.');
          expect(prompt).toContain("If they'd rather not, say you can't give that, and carry on asking.");
          // No blanket refusal left to contradict the transfer rule.
          expect(prompt).not.toMatch(/ask for a deposit, payment or personal details, answer them out loud/);
        }
      } finally {
        config.TRANSFER_ENABLED = false;
      }
    });

    it('records each answer as it goes, and ends with report_answers_and_end_call, not end_call', () => {
      const prompt = flat(buildCallSystemPrompt(askTask, contact, []));
      expect(prompt).toContain('call record_answer for that question right away, without saying anything about it');
      expect(prompt).toContain('End this call that way, not with end_call.');
    });
  });

  it('keeps each question on its own numbered line even if its text has line breaks (#148 review)', () => {
    const broken = { ...askTask, questions: ['Hours?\n2. Walk-ins?', 'Parking?'] } as Task;
    for (const prompt of [buildCallSystemPrompt(broken, contact, []), buildCallFrontendPrompt(broken, contact)]) {
      expect(prompt).toContain('1. Hours? 2. Walk-ins?\n2. Parking?');
    }
  });

  // #148 review, round 2, finding 3: the shared sections still told ask calls
  // to book, confirm a time, and say what was booked.
  describe('the full ask prompt has no booking instructions', () => {
    const BOOKING_ONLY = [
      'Wait for a clear yes to a specific time',
      'Your own summary of a time is not agreement',
      'So shall I book Friday at 10?',
      'lock it in',
      'If the other party offers a time, restate it back clearly before confirming.',
      'Once a booking has gone through',
      'what is booked',
      'Yes, Friday at 10 works.',
      'an unavailable time',
      'offer alternatives',
      'to negotiate or book an appointment',
    ];

    it('backend and voice layer, on either provider, with transfer off and on', async () => {
      const { config } = await import('../../src/config/index.js');
      try {
        for (const provider of ['openai', 'openai-live'] as const) {
          for (const transfer of [false, true]) {
            config.VOICE_AI_PROVIDER = provider;
            config.TRANSFER_ENABLED = transfer;
            for (const prompt of [buildCallSystemPrompt(askTask, contact, [], 'Likes mornings.'), buildCallFrontendPrompt(askTask, contact, 'Likes mornings.')]) {
              for (const line of BOOKING_ONLY) expect(prompt).not.toContain(line);
              expect(prompt).toMatch(/Saving an answer[^\n]* is silent: never announce it/);
            }
          }
        }
      } finally {
        config.VOICE_AI_PROVIDER = 'openai';
        config.TRANSFER_ENABLED = false;
      }
    });

    it('booking and conversation prompts keep every booking line', () => {
      for (const task of [bookingTask, conversationTask]) {
        for (const prompt of [buildCallSystemPrompt(task, contact, []), buildCallFrontendPrompt(task, contact)]) {
          for (const line of BOOKING_ONLY) expect(prompt).toContain(line);
          expect(prompt).not.toMatch(/Saving an answer/);
        }
      }
    });
  });

  // #148 review, round 2, finding 6: on openai-live the backend acts only when
  // the voice layer delegates, and nothing told it to delegate saving answers,
  // so record_answer never ran mid-call and a hang-up lost every answer.
  it('tells the voice layer to delegate saving each confirmed answer, silently, without naming the tool', () => {
    const prompt = buildCallFrontendPrompt(askTask, contact).replace(/\s+/g, ' ');
    expect(prompt).toContain(
      "Once they reply to your read-back and confirm it, or say they don't know, delegate saving that answer to your backend right away, without saying anything about it, and carry on.",
    );
    expect(prompt).not.toContain('record_answer');
    // Booking and conversation voice layers are not told to save answers.
    for (const task of [bookingTask, conversationTask]) {
      expect(buildCallFrontendPrompt(task, contact)).not.toMatch(/delegate saving/);
    }
  });
});

describe('phone menus', () => {
  // A live Xfinity call escalated at "...say yes or press 1. Otherwise, please
  // remain on the line": the menu offered a way on, and Banjo hung up.
  it("tries the menu's own ways on, and the agent option, before escalating", () => {
    const prompt = buildCallSystemPrompt(bookingTask, contact, []);
    expect(prompt).toContain('remain on the line');
    expect(prompt).toMatch(/agent or operator option[^.]*before you escalate/);
    expect(prompt).not.toContain("if you've tried a couple of\noptions and still can't find a relevant one, escalate");
  });
});
