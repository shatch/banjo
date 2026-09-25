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
    expect(prompt).toMatch(/never describe it/i);
    expect(prompt).toContain("I'll say a quick goodbye");
  });

  it('carries that into the voice layer', () => {
    expect(buildFrontendSystemPromptGuidance('outbound')).toMatch(/never describe it/i);
  });
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
