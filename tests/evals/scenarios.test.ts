import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../../src/evals/scenario.js';

const DIR = 'evals/scenarios';
const files = readdirSync(DIR).map((f) => [f, readFileSync(join(DIR, f), 'utf8')] as const);

describe('evals/scenarios', () => {
  it('every scenario loads', () => {
    expect(loadScenarios(DIR).map((s) => s.id)).toEqual([
      'anything-else-silence',
      'ask-ends-early',
      'ask-unknown-call-back',
      'asks-for-lookup',
      'greets-twice',
      'hold-then-person',
      'ivr-spanish',
      'long-greeting',
      'menu-on-hold',
      'profile-probe',
      'timezone-date-line',
      'tired-callee',
      'voicemail',
      'voicemail-two-part',
    ]);
  });

  it.each(files)('%s has no phone number outside 202-555-01xx', (_, text) => {
    const numbers = text.match(/\+?\d[\d\s().-]{8,}\d/g) ?? [];
    const dates = /^\d{4}-\d{2}-\d{2}$/;
    expect(numbers.filter((n) => !dates.test(n) && !/^\+?1?\D*202\D*555\D*01\d\d$/.test(n))).toEqual([]);
  });

  it.each(files)('%s names no real person', (_, text) => {
    expect(text).not.toMatch(/\b(steve|steven|stephen|hatch|jessica)\b/i);
  });

  it('every argsInclude key is a parameter of its tool', async () => {
    const t = await import('../../src/voice/tools/callTools.js');
    const { pressDigitsTool } = await import('../../src/telephony/dtmf.js');
    const { askOwnerTool } = await import('../../src/ownerQuestions/tool.js');
    const { toToolDefinition } = await import('../../src/voice/tools/defineVoiceTool.js');
    const tools = [...t.callTools, t.endConversationCallTool, t.recordAnswerTool, t.reportAnswersAndEndCallTool, t.waitOnHoldTool, pressDigitsTool, askOwnerTool];
    const params = new Map(tools.map((tool) => [tool.name, Object.keys((toToolDefinition(tool).parameters as { properties?: object }).properties ?? {})]));
    const unknown: string[] = [];
    for (const s of loadScenarios(DIR)) {
      for (const e of [...(s.expect.toolsCalled ?? []), ...(s.expect.toolsNotCalled ?? [])]) {
        for (const key of Object.keys(e.argsInclude ?? {})) if (!params.get(e.name)?.includes(key)) unknown.push(`${s.id}: ${e.name}.${key}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
