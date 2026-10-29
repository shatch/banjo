import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/index.js', () => ({ config: { OPENAI_API_KEY: 'test-key' } }));
const { responsesText } = await import('../../src/lib/openaiResponses.js');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function replyWith(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

afterEach(() => fetchMock.mockReset());

describe('responsesText', () => {
  it('sends one unstored Responses request and returns the answer text', async () => {
    replyWith({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'PER' }, { type: 'output_text', text: 'SON' }] },
      ],
    });
    await expect(responsesText({ model: 'gpt-5.6-terra', instructions: 'Classify.', input: 'Line: "hi"', timeoutMs: 5000 })).resolves.toBe('PERSON');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toEqual({ model: 'gpt-5.6-terra', instructions: 'Classify.', input: 'Line: "hi"', store: false });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on an error status, saying which', async () => {
    replyWith({ error: { message: 'nope' } }, 500);
    await expect(responsesText({ model: 'm', instructions: 'i', input: 'x', timeoutMs: 5000 })).rejects.toThrow(/500/);
  });

  it('throws when the answer has no text', async () => {
    replyWith({ output: [{ type: 'reasoning', summary: [] }] });
    await expect(responsesText({ model: 'm', instructions: 'i', input: 'x', timeoutMs: 5000 })).rejects.toThrow(/no answer text/);
  });
});
