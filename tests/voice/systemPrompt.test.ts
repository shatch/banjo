import { describe, expect, it } from 'vitest';
import { buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance } from '../../src/voice/systemPrompt.js';

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

  it("direction='outbound' tells the model to identify itself as calling on Alex's behalf", () => {
    const prompt = buildBaseSystemPromptGuidance('outbound');
    expect(prompt).toContain('identify yourself as calling on behalf of Alex');
  });

  it("direction='inbound' does not tell the model it is calling — it answered, the caller called it", () => {
    const prompt = buildBaseSystemPromptGuidance('inbound');
    expect(prompt).not.toContain('identify yourself as calling on behalf of Alex');
    expect(prompt.toLowerCase()).not.toMatch(/identify yourself as calling/);
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
});
