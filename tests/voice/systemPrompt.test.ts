import { describe, expect, it } from 'vitest';
import { buildBaseSystemPromptGuidance } from '../../src/voice/systemPrompt.js';

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
