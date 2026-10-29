import { describe, expect, it } from 'vitest';
import { buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance } from '../../src/voice/systemPrompt.js';
import { disclosureLine } from '../../src/config/index.js';

describe('buildBaseSystemPromptGuidance', () => {
  it('defaults to the outbound identity line', () => {
    const prompt = buildBaseSystemPromptGuidance();
    expect(prompt).toContain('placing an outbound phone call on behalf of Alex');
  });

  it("direction='outbound' produces the outbound identity line explicitly", () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toContain('placing an outbound phone call on behalf of Alex');
  });

  it("direction='inbound' produces the inbound identity line instead", () => {
    const prompt = buildBaseSystemPromptGuidance('inbound');
    expect(prompt).toContain("answering an inbound phone call on Alex's behalf");
    expect(prompt).not.toContain('placing an outbound phone call');
  });

  it('shares the direction-agnostic sections (turn-taking, timezone, ending the call) across both directions', () => {
    const outbound = buildBaseSystemPromptGuidance('outbound');
    const inbound = buildBaseSystemPromptGuidance('inbound');
    for (const shared of ['Turn-taking', 'Timezone', 'Ending the call', 'Handling tool calls']) {
      expect(outbound).toContain(shared);
      expect(inbound).toContain(shared);
    }
  });

  it("direction='outbound': the first sentence is the disclosure line, said on every call, not only when asked (#8)", () => {
    // Every demo call opened "I'm calling on behalf of Steve" and only said
    // "AI" when asked — what the old "identify yourself as calling on behalf
    // of" wording allowed.
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toContain(`first sentence must be: "${disclosureLine()}"`);
    expect(prompt).toMatch(/every call, even if they seem to know/i);
  });

  // #156: a sim transfer run said the disclosure opener again mid-call, as if
  // starting over. Once at the start; "who is this?" still gets an honest answer.
  it("direction='outbound': the disclosure is said once, and a later greeting gets a short honest answer, not a new opener (#156)", () => {
    for (const prompt of [buildBaseSystemPromptGuidance('outbound'), buildFrontendSystemPromptGuidance('outbound')]) {
      expect(prompt).toMatch(/say it once/i);
      // The hold flow (#151) opens again, disclosure first, to whoever picks up.
      expect(prompt).toMatch(/say it once[^\n]*unless you are told a new person has picked up after a hold/i);
      expect(prompt).toMatch(/greet you again or ask who is calling[^\n]*AI assistant/i);
    }
  });

  it("direction='inbound' opens by saying it's Alex's AI assistant, and doesn't say it is calling", () => {
    const prompt = buildBaseSystemPromptGuidance('inbound');
    expect(prompt).toMatch(/first words must say you are Alex's AI assistant/);
    expect(prompt).not.toContain(disclosureLine());
    expect(prompt.toLowerCase()).not.toMatch(/identify yourself as calling/);
  });

  it('the disclosure rule reaches the voice layer too', () => {
    expect(buildFrontendSystemPromptGuidance('outbound')).toContain(disclosureLine());
  });

  it('forbids promising a callback or that the assistant will follow up later — this system cannot deliver either', () => {
    const prompt = buildBaseSystemPromptGuidance('inbound');
    expect(prompt.toLowerCase()).toContain('never promise');
    expect(prompt.toLowerCase()).toContain('call you back');
  });

  it('requires an actual spoken goodbye before ending the call, not just delivering the informational content', () => {
    const prompt = buildBaseSystemPromptGuidance();
    const lower = prompt.toLowerCase();
    expect(lower).toContain('say goodbye');
    expect(lower).toContain('before calling any tool that ends the call');
  });
});

describe('buildFrontendSystemPromptGuidance (voice layer of a split provider, e.g. openai-live)', () => {
  it('keeps identity, tone, ending the call, turn-taking, stalling, and call conduct, in both directions', () => {
    for (const direction of ['outbound', 'inbound'] as const) {
      const prompt = buildFrontendSystemPromptGuidance(direction);
      for (const section of ['Identity and tone', 'Ending the call', 'Turn-taking', 'Handling tool calls', 'General call conduct']) {
        expect(prompt).toContain(section);
      }
    }
  });

  it('uses the direction-specific identity line', () => {
    expect(buildFrontendSystemPromptGuidance('outbound')).toContain('placing an outbound phone call on behalf of Alex');
    expect(buildFrontendSystemPromptGuidance('inbound')).toContain("answering an inbound phone call on Alex's behalf");
  });

  it('leaves the timezone contract to the backend, which receives the full prompt', () => {
    expect(buildFrontendSystemPromptGuidance()).not.toContain('Timezone');
  });

  it('adds delegation guidance that the shared base guidance does not have', () => {
    expect(buildFrontendSystemPromptGuidance()).toContain('Delegating to your backend');
    expect(buildBaseSystemPromptGuidance()).not.toContain('Delegating to your backend');
  });

  it('tells the voice layer that saying goodbye does not hang up, and to delegate ending the call right after its goodbye — live calls stayed open through repeated goodbyes', () => {
    const prompt = buildFrontendSystemPromptGuidance();
    expect(prompt).toContain('saying goodbye does NOT hang up the phone');
    expect(prompt).toContain('immediately delegate ending the call to your backend');
    expect(buildBaseSystemPromptGuidance()).not.toContain('saying goodbye does NOT hang up the phone');
  });

  it('forbids saying its own reasoning out loud — a live voicemail recorded the model announcing its decision', () => {
    expect(buildFrontendSystemPromptGuidance('outbound')).toContain('Never say your own reasoning, decisions, or plans out loud');
    expect(buildFrontendSystemPromptGuidance('inbound')).toContain('Never say your own reasoning, decisions, or plans out loud');
  });

  it('reuses the base guidance wording verbatim — every voice-layer section except delegation appears in the base guidance as-is', () => {
    const base = buildBaseSystemPromptGuidance('outbound');
    const sections = buildFrontendSystemPromptGuidance('outbound').split('\n\n');
    for (const section of sections.slice(0, -1)) {
      expect(base).toContain(section);
    }
  });
});describe('keeping internal mechanics off the call', () => {
  // On a live call (2026-09-22) the model narrated its own plumbing at the
  // callee: "since six o'clock might not match the pre-approved windows, I'll
  // quickly check Steve's availability" — she has no idea Banjo has windows,
  // and six o'clock was inside the window anyway.
  it('tells the model not to expose its own scheduling machinery, in both directions', () => {
    for (const direction of ['outbound', 'inbound'] as const) {
      const prompt = buildBaseSystemPromptGuidance(direction);
      expect(prompt).toContain('Never describe your own mechanics');
    }
  });

  it('carries that guidance into the voice layer, where the talking happens', () => {
    // A split provider runs the frontend prompt for speech — guidance that
    // only lands in the backend prompt would not reach the words spoken.
    expect(buildFrontendSystemPromptGuidance('outbound')).toContain('Never describe your own mechanics');
  });
});

describe('confirming only on explicit agreement', () => {
  // A live call (2026-09-22) fired confirm_appointment while the other party
  // was still negotiating, off the back of its own read-back rather than
  // anything they had actually said.
  it('tells the model not to confirm until the other party has actually agreed', () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toContain('Do not confirm anything the other party has not explicitly agreed to');
  });

  it('carries that guidance into the voice layer', () => {
    expect(buildFrontendSystemPromptGuidance('outbound')).toContain(
      'Do not confirm anything the other party has not explicitly agreed to',
    );
  });
});

describe('the stalling phrase before a tool call gives nothing away', () => {
  // #24, second round. #26 added "never describe your own mechanics", but the
  // Handling-tool-calls section still told the model to say "One moment while I
  // check the calendar..." and to "always narrate that you are checking
  // something". On the next live call it said, near verbatim: "One moment while
  // I confirm that time on Steve's calendar." The more specific instruction,
  // with a worked example, won. These pin that the two can't disagree again.
  for (const direction of ['outbound', 'inbound'] as const) {
    it(`${direction}: offers no stalling example that mentions a calendar or a check`, () => {
      const prompt = buildBaseSystemPromptGuidance(direction);
      expect(prompt).not.toMatch(/check the calendar/i);
      expect(prompt).not.toMatch(/double-check that time/i);
      expect(prompt).not.toMatch(/narrate that you are checking/i);
    });
  }

  it('still guards against dead air, with a phrase that says nothing about why', () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toContain('"One moment."');
    expect(prompt).toMatch(/never say what you are doing or why/i);
  });

  it('reaches the voice layer, where the stalling phrase is actually spoken', () => {
    const prompt = buildFrontendSystemPromptGuidance('outbound');
    expect(prompt).not.toMatch(/check the calendar/i);
    expect(prompt).toContain('"One moment."');
  });
});

describe('the goodbye is said, not announced', () => {
  // Same call: "I'll say a quick goodbye and then wrap up the call." — then it
  // hung up. The callee never heard a goodbye, only a description of one.
  it('tells the model the goodbye must be the goodbye itself', () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toMatch(/The goodbye must BE the goodbye/);
    expect(prompt).toMatch(/never talk about the goodbye/i);
  });

  it('carries that into the voice layer', () => {
    expect(buildFrontendSystemPromptGuidance('outbound')).toMatch(/never talk about the goodbye/i);
  });

  // #144: "Tell him thank you." got two narrating lines, and the callee hung up first.
  it('makes the reply to a done signal one short goodbye, with nothing before it', () => {
    for (const prompt of [buildBaseSystemPromptGuidance('outbound'), buildFrontendSystemPromptGuidance('outbound')]) {
      expect(prompt).toContain('When the other party is done');
      expect(prompt).toContain("You're welcome — take care, bye!");
      expect(prompt).toMatch(/nothing before it/i);
    }
  });

  // #154: after v0.1.8 a live call still narrated ("Let me wrap up with a quick
  // note.", "let me say a quick goodbye and close things out"), in the words
  // the prompt quoted as what not to say. It quotes none now.
  for (const build of [buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance]) {
    for (const [label, direction, options] of [
      ['booking', 'outbound', {}],
      ['ask', 'outbound', { purpose: 'ask' }],
      ['inbound', 'inbound', {}],
    ] as const) {
      it(`${build.name} (${label}): quotes no narrated ending for the model to copy`, () => {
        expect(build(direction, options)).not.toMatch(/wrap(ping)? up|quick goodbye|keep this brief|let me respond|end the call now/i);
      });
    }

    // #130: "Bye, Gemma! One moment." was the last thing the callee heard.
    it(`${build.name}: no filler before ending the call or after the goodbye, on a booking call too`, () => {
      const prompt = build('outbound');
      expect(prompt).toMatch(/no filler[^\n]*before ending the call/i);
      expect(prompt).toMatch(/goodbye is the last thing you say/i);
    });

    // #130: Banjo asked "Anything else…?" and hung up without an answer.
    it(`${build.name}: never ends the call in the same turn as a question to them`, () => {
      expect(build('outbound')).toMatch(/never end the call in the same turn as a question/i);
    });
  }
});

describe('the call stays open while the other party is redirecting it (#133)', () => {
  // Live call, 2026-10-09: the callee started to tell Banjo something new and
  // Banjo answered "Okay, I'll keep it short and light." and hung up.
  for (const build of [buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance]) {
    it(`${build.name}: never ends the call in reply to them starting to say something`, () => {
      const prompt = build('outbound');
      expect(prompt).toMatch(/never end the call in reply to the other party starting to tell you something/i);
      expect(prompt).toContain('"go ahead"');
    });

    it(`${build.name}: still ends it when what they want is to end the call`, () => {
      expect(build('outbound')).toMatch(/if what they want is to end the call .*say goodbye and end it/i);
    });
  }
});

describe('a tentative answer is not treated as a yes, even in words', () => {
  // Demo call, 2026-09-23: to "Yeah, that could probably work" the model said
  // "Okay, thanks for confirming—let me lock that in", then in the next breath
  // asked whether it was a definite yes. It didn't book early, but the callee
  // heard it acknowledge a confirmation she hadn't given.
  for (const build of [buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance]) {
    it(`${build.name}: tells the model to ask for a firm yes, never thank them for confirming`, () => {
      const prompt = build('outbound');
      expect(prompt).toContain('that could probably work');
      expect(prompt).toMatch(/do not thank them for confirming/i);
    });
  }
});

describe('the stalling phrase is a closed list, with nothing after it (#43)', () => {
  // Demo re-run, 2026-09-23, after #24 was closed: "One moment. I'll just sort
  // out the timing before we go further." and "One moment. I'll take care of
  // the booking details and then confirm everything for you." The rule banned
  // naming the mechanics; the model complied with the words and still
  // appended a reason. A fixed list leaves nowhere to put one.
  for (const build of [buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance]) {
    it(`${build.name}: gives the exact phrases and forbids anything after them`, () => {
      const prompt = build('outbound');
      expect(prompt).toContain('say exactly one of these and nothing more: "One moment." / "Sure — just a second." / "Bear with me a second."');
      expect(prompt).toMatch(/no second sentence/i);
    });
  }
});

describe('after a booking goes through, say what was booked (#44)', () => {
  for (const build of [buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance]) {
    it(`${build.name}: tells the model to restate day, time and service before the goodbye`, () => {
      const prompt = build('outbound');
      expect(prompt).toMatch(/once a booking has gone through/i);
      expect(prompt).toMatch(/day, time, and what is booked/i);
    });

    it(`${build.name}: tells the model not to invent ways for the other party to record things`, () => {
      // "If you want, you can note whatever you'd like on his profile" —
      // said to a groomer, about a profile nobody mentioned.
      const prompt = build('outbound');
      expect(prompt).toMatch(/do not invent a system, profile, or form/i);
    });
  }
});

describe('transfer guidance (#7)', () => {
  it('is absent when TRANSFER_ENABLED is off, and present in every prompt when on', async () => {
    const { config } = await import('../../src/config/index.js');
    try {
      config.TRANSFER_ENABLED = false;
      for (const direction of ['outbound', 'inbound'] as const) {
        expect(buildBaseSystemPromptGuidance(direction)).not.toContain('transfer_to_owner');
        expect(buildFrontendSystemPromptGuidance(direction)).not.toContain('transfer_to_owner');
      }
      config.TRANSFER_ENABLED = true;
      for (const direction of ['outbound', 'inbound'] as const) {
        expect(buildBaseSystemPromptGuidance(direction)).toContain('transfer_to_owner');
        expect(buildFrontendSystemPromptGuidance(direction)).toContain('transfer_to_owner');
      }
    } finally {
      config.TRANSFER_ENABLED = false;
    }
  });

  it('tells a voice layer to delegate the transfer to its backend only when enabled, leaving the flag-off prompt untouched', async () => {
    // openai-live's voice layer has no tools; the generic delegation list
    // ("cannot check a calendar, book..., end the call yourself") never said
    // connecting the caller was also the backend's job.
    const { config } = await import('../../src/config/index.js');
    try {
      for (const direction of ['outbound', 'inbound'] as const) {
        config.TRANSFER_ENABLED = false;
        const off = buildFrontendSystemPromptGuidance(direction);
        config.TRANSFER_ENABLED = true;
        const on = buildFrontendSystemPromptGuidance(direction);

        expect(off).not.toMatch(/delegate the transfer/i);
        const delegation = on.split('\n\n').at(-1)!;
        const transferLine = delegation.split('\n').find((line) => /delegate the transfer/i.test(line));
        expect(transferLine).toBeDefined();
        expect(transferLine).toContain('Alex');
        expect(buildBaseSystemPromptGuidance(direction)).not.toMatch(/delegate the transfer/i);

        // Removing what the flag adds gives back the flag-off prompt byte for byte.
        const stripped = on
          .split('\n\n')
          .filter((section) => !section.startsWith('Transferring to'))
          .join('\n\n')
          .replace(`\n${transferLine}`, '')
          // The outbound conduct rules' own line about handing the call over.
          .replace(/\n- Hand the call to Alex only for what needs them personally[^\n]*/, '');
        expect(stripped).toBe(off);
      }
    } finally {
      config.TRANSFER_ENABLED = false;
    }
  });

  it("asks before transferring, and falls back to the direction's own escalation tool", async () => {
    const { config } = await import('../../src/config/index.js');
    try {
      config.TRANSFER_ENABLED = true;
      const outbound = buildBaseSystemPromptGuidance('outbound');
      const inbound = buildBaseSystemPromptGuidance('inbound');
      expect(outbound).toMatch(/ask .*whether they'd like to be connected/i);
      expect(outbound).toContain('escalate_and_end_call');
      expect(inbound).toContain('flag_for_owner_and_end_call');
      expect(inbound).not.toContain('escalate_and_end_call');
    } finally {
      config.TRANSFER_ENABLED = false;
    }
  });
});

describe('voicemail (#71)', () => {
  // Live, 2026-09-25: both voicemails opened with a preamble before the AI
  // disclosure, and one told the machine "the message is being delivered by
  // the system, and the call will end once it's finished."
  it('says nothing before the voicemail tool, since the system opens the voicemail with the disclosure', () => {
    for (const guidance of [buildBaseSystemPromptGuidance('outbound'), buildFrontendSystemPromptGuidance('outbound')]) {
      expect(guidance).toContain('call your voicemail-leaving tool right away, without saying anything first');
      expect(guidance).toContain('Never tell the callee how the message is delivered');
    }
  });
});

describe('warm transfer guidance (#149)', () => {
  it('says Banjo is trying to reach the principal, may come back, and must not promise them', async () => {
    const { config } = await import('../../src/config/index.js');
    try {
      config.TRANSFER_ENABLED = true;
      config.TRANSFER_MODE = 'warm';
      for (const direction of ['outbound', 'inbound'] as const) {
        const prompt = buildBaseSystemPromptGuidance(direction);
        expect(prompt).toContain('Bringing in Alex:');
        expect(prompt).not.toContain('Transferring to Alex:');
        expect(prompt).toContain('It may take a minute, so please hold.');
        expect(prompt).toContain("Never say Alex is coming before the result says so.");
        expect(prompt).toContain(direction === 'outbound' ? 'escalate_and_end_call' : 'flag_for_owner_and_end_call');
        const frontend = buildFrontendSystemPromptGuidance(direction);
        expect(frontend).toContain("Reaching Alex is also your backend's job");
        expect(frontend).not.toMatch(/delegate the transfer/i);
      }
    } finally {
      config.TRANSFER_ENABLED = false;
      config.TRANSFER_MODE = 'cold';
    }
  });
});

describe('phone menu and hold guidance (#151)', () => {
  it('is in outbound prompts on OpenAI Realtime, and never in inbound ones', () => {
    expect(buildBaseSystemPromptGuidance('outbound')).toContain('Phone menus and holding:');
    expect(buildBaseSystemPromptGuidance('outbound')).toContain('use wait_on_hold, saying nothing');
    expect(buildBaseSystemPromptGuidance('inbound')).not.toContain('wait_on_hold');
  });

  // A live Xfinity call: Banjo went on hold at "...otherwise, please remain on
  // the line" and never answered the menu's spoken questions after that, and
  // spoke filler ("One moment") into a menu that listens for speech.
  it('treats a menu as something that may listen for speech, and waiting at "remain on the line" as a hold', () => {
    const guidance = buildBaseSystemPromptGuidance('outbound');
    expect(guidance).toContain('listen for speech');
    expect(guidance).toContain('remain on the line');
    expect(guidance).toMatch(/agent or operator option[^.]*before/);
    expect(guidance).not.toContain('A recording never hears you');
    expect(guidance).toContain('An automated phone menu is not a person waiting on you: say none of those phrases to it');
    // Sim runs of the same menu pressed 2 at its Spanish option.
    expect(guidance).toContain('Never choose a menu option for a different language');
  });

  // Eval hold-then-person, 1/9: to "Riverside Auto, can you hold please?" Banjo
  // said "Sure, I'll hold." with no AI disclosure, to a real receptionist (#197).
  it('has Banjo disclose before agreeing to hold when a person asks it to', () => {
    const guidance = buildBaseSystemPromptGuidance('outbound');
    expect(guidance).toMatch(/a person who answers and asks you to hold[^\n]*is not a queue/i);
    expect(guidance).toMatch(/AI disclosure first[^\n]*then agree to hold/i);
  });

  it('is left out where the voice provider cannot hold', async () => {
    const { config } = await import('../../src/config/index.js');
    try {
      config.VOICE_AI_PROVIDER = 'gemini';
      expect(buildBaseSystemPromptGuidance('outbound')).not.toContain('wait_on_hold');
    } finally {
      config.VOICE_AI_PROVIDER = 'openai';
    }
  });

  it("reaches openai-live's voice layer, which delegates wait_on_hold to its backend", async () => {
    const { config } = await import('../../src/config/index.js');
    try {
      config.VOICE_AI_PROVIDER = 'openai-live';
      expect(buildBaseSystemPromptGuidance('outbound')).toContain('wait_on_hold');
      expect(buildFrontendSystemPromptGuidance('outbound')).toContain('wait_on_hold');
    } finally {
      config.VOICE_AI_PROVIDER = 'openai';
    }
  });
});

describe("purpose 'ask' (#148 review, finding 3)", () => {
  // The shared sections used to give ask calls booking instructions that
  // contradict the ask guidance: "So shall I book Friday at 10?", "Wait for a
  // clear yes to a specific time", "say ... what is booked", and a filler
  // before every action, record_answer included, which is meant to be silent.
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
  ];
  const ask = { purpose: 'ask' } as const;

  for (const build of [buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance]) {
    it(`${build.name}: leaves out every booking-only line, with transfer off and on`, () => {
      for (const transfer of [false, true]) {
        const prompt = build('outbound', { ...ask, transfer });
        for (const line of BOOKING_ONLY) expect(prompt).not.toContain(line);
      }
    });

    it(`${build.name}: still has the shared rules that fit an ask call`, () => {
      const prompt = build('outbound', ask);
      for (const kept of [
        `"${disclosureLine()}"`,
        'Never describe your own mechanics',
        'say exactly one of these and nothing more: "One moment." / "Sure — just a second." / "Bear with me a second."',
        'Never promise a callback, follow-up',
        'When you do not know something, say so plainly and move on.',
        'If you reach voicemail',
        'ALWAYS say goodbye out loud',
      ]) {
        expect(prompt).toContain(kept);
      }
    });

    it(`${build.name}: says saving an answer is silent, with no filler before it`, () => {
      const prompt = build('outbound', ask);
      expect(prompt).toMatch(/Saving an answer[^\n]* is silent: never announce it/);
      expect(prompt).toMatch(/no filler/i);
    });

    // #167: "One moment." before a read-back, and before the closing tool.
    it(`${build.name}: no filler before a read-back or before ending the call`, () => {
      expect(build('outbound', ask)).toMatch(/no filler[^\n]*before a read-back[^\n]*before ending the call/i);
    });

    it(`${build.name}: a hedged answer is said back as hedged, not firmed up`, () => {
      expect(build('outbound', ask)).toMatch(/hedged answer[^\n]*say it back as they said it/i);
    });

    it(`${build.name}: booking prompts get none of the ask-only lines`, () => {
      for (const prompt of [build('outbound'), build('outbound', { purpose: 'book' }), build('inbound')]) {
        expect(prompt).not.toMatch(/Saving an answer/);
        expect(prompt).not.toMatch(/say it back as they said it/);
      }
    });
  }

  it('names record_answer in the backend prompt only: the voice layer gets no tool names for it', () => {
    expect(buildBaseSystemPromptGuidance('outbound', ask)).toContain('record_answer');
    expect(buildFrontendSystemPromptGuidance('outbound', ask)).not.toContain('record_answer');
  });

  it('booking guidance is the default, and keeps every booking line', () => {
    for (const build of [buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance]) {
      expect(build('outbound', { purpose: 'book' })).toBe(build('outbound'));
      const prompt = build('outbound');
      for (const line of BOOKING_ONLY) expect(prompt).toContain(line);
    }
  });
});

describe('working with the person helping you (2026-10-18 support call)', () => {
  it('outbound only: ticket numbers on record, a specialist when the steps miss, the process not the person', () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toContain('Working with the person helping you:');
    expect(prompt).toMatch(/As soon as they say they have opened a ticket, case or order, ask for its number before anything else, and ask them to note the details you gave them/);
    expect(prompt).toMatch(/someone more specialized/);
    expect(prompt).toMatch(/keep it about the process, never them/);
    expect(buildBaseSystemPromptGuidance('inbound')).not.toContain('Working with the person helping you:');
  });

  it('names ask_owner only when ASK_OWNER_ENABLED is on, on OpenAI Realtime', async () => {
    const { config } = await import('../../src/config/index.js');
    expect(buildBaseSystemPromptGuidance('outbound')).not.toContain('ask_owner');
    expect(buildBaseSystemPromptGuidance('outbound')).toMatch(/say plainly that you don't have it rather than guess/);
    try {
      config.ASK_OWNER_ENABLED = true;
      const prompt = buildBaseSystemPromptGuidance('outbound');
      expect(prompt).toMatch(/don't guess: tell them you'll check with Alex, which may take a minute or two, and use ask_owner/);
      expect(buildBaseSystemPromptGuidance('inbound')).not.toContain('ask_owner');
    } finally {
      config.ASK_OWNER_ENABLED = false;
    }
  });

  it('with transfers on, hands the call over only for what needs the principal, after the ticket is settled', async () => {
    const { config } = await import('../../src/config/index.js');
    try {
      config.TRANSFER_ENABLED = true;
      expect(buildBaseSystemPromptGuidance('outbound')).toMatch(/never because the conversation is long or difficult/);
    } finally {
      config.TRANSFER_ENABLED = false;
    }
  });
});

describe('arrival windows (2026-10-19 sim)', () => {
  it('outbound booking calls book an arrival window as its start and length; ask and inbound calls get no such line', () => {
    expect(buildBaseSystemPromptGuidance('outbound')).toMatch(/arrival window[^\n]*the window's start is the start time, and the whole window is the length/);
    expect(buildBaseSystemPromptGuidance('outbound', { purpose: 'ask' })).not.toContain('arrival window');
    expect(buildBaseSystemPromptGuidance('inbound')).not.toContain('arrival window');
  });
});

// #160: an outbound call can pass a request on with note_follow_up, so its
// prompt says how, and still forbids promising when or how they'll hear back.
// The inbound line has no such tool, so its rule is unchanged.
describe('passing a request on (#160)', () => {
  for (const build of [buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance]) {
    it(`${build.name}: outbound calls, booking and ask, are told to note it and promise nothing more`, () => {
      for (const options of [{}, { purpose: 'ask' as const }]) {
        const prompt = build('outbound', options);
        expect(prompt).toContain('Never promise a callback, follow-up');
        expect(prompt).toMatch(/save it with note_follow_up and say you'll pass it on to Alex/);
        expect(prompt).toMatch(/never when or how they will hear back/);
        expect(prompt).not.toContain('this call ends with nothing carried forward');
      }
    });

    it(`${build.name}: the inbound line keeps its rule, with no note_follow_up`, () => {
      const prompt = build('inbound');
      expect(prompt).not.toContain('note_follow_up');
      expect(prompt).toContain('this call ends with nothing carried forward');
    });
  }
});
