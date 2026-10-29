/**
 * One unstored OpenAI Responses API request, for a short text answer outside
 * any call: call screening (#150) and openai-live's out-of-band judgments
 * (#151, #187). Throws on any failure; each caller decides what that means.
 */
import { config } from '../config/index.js';

export async function responsesText(opts: { model: string; instructions: string; input: string; timeoutMs: number }): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model, instructions: opts.instructions, input: opts.input, store: false }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`OpenAI Responses request failed: ${res.status}`);
  const json = (await res.json()) as { output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
  const text = (json.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text ?? '')
    .join('');
  if (!text) throw new Error('OpenAI Responses request failed: no answer text');
  return text;
}
