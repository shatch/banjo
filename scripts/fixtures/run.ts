/**
 * Runs one phone-line fixture (#205) end to end: points our fixture number at
 * the fixture, has a running Banjo call it over MCP, waits for the outcome,
 * then checks what the fixture side recorded. No call reaches anyone's phone.
 *
 *   npm run fixtures:call -- voicemail|ivr|hold
 *
 * Needs, in .env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, OPENAI_API_KEY,
 * FIXTURE_PHONE_NUMBER, FIXTURE_PHONE_NUMBER_SID, FIXTURE_FUNCTIONS_DOMAIN
 * (npm run fixtures:deploy prints it), BANJO_MCP_URL (the Banjo to test,
 * e.g. https://banjo.example.com/mcp) and BANJO_MCP_KEY (its MCP_API_KEY).
 * Each run is a real call: it counts against Banjo's per-number cap.
 */
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import twilio from 'twilio';

type Fixture = 'voicemail' | 'ivr' | 'hold';

const CALLS: Record<Fixture, Record<string, unknown>> = {
  voicemail: { taskDescription: 'Book a full groom for Banjo, a golden retriever, any weekday next week.' },
  ivr: { taskDescription: 'Book a checkup for Banjo, a golden retriever, any weekday next week.' },
  hold: { taskDescription: 'Find out whether they have front brake pads for a 2019 Honda Civic in stock.', mode: 'ask', questions: ['Do you have front brake pads for a 2019 Honda Civic in stock?'] },
};

const TERMINAL = new Set(['confirmed', 'voicemail_left', 'negotiation_failed', 'escalated', 'conversation_completed', 'answered', 'transferred', 'failed', 'cancelled']);
const DISCLOSURE = /\bAI\b/;

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in .env (see scripts/fixtures/run.ts)`);
  return value;
}

async function transcribe(audio: ArrayBuffer): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'fixture.wav');
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('OPENAI_API_KEY')}` },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription failed: ${res.status}`);
  return ((await res.json()) as { text: string }).text;
}

function parse(result: unknown): Record<string, unknown> {
  const { content = [], isError } = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = content.find((c) => c.type === 'text')?.text ?? '{}';
  if (isError) throw new Error(`Banjo refused: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const fixture = process.argv[2] as Fixture;
  if (!(fixture in CALLS)) throw new Error('usage: npm run fixtures:call -- voicemail|ivr|hold');
  const accountSid = need('TWILIO_ACCOUNT_SID');
  const authToken = need('TWILIO_AUTH_TOKEN');
  const tw = twilio(accountSid, authToken);
  const number = need('FIXTURE_PHONE_NUMBER');

  await tw.incomingPhoneNumbers(need('FIXTURE_PHONE_NUMBER_SID')).update({ voiceUrl: `https://${need('FIXTURE_FUNCTIONS_DOMAIN')}/${fixture}`, voiceMethod: 'POST' });

  const mcp = new Client({ name: 'banjo-fixtures', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(need('BANJO_MCP_URL')), { requestInit: { headers: { Authorization: `Bearer ${need('BANJO_MCP_KEY')}` } } }));
  const found = parse(await mcp.callTool({ name: 'find_contact', arguments: { query: 'Banjo test line' } }));
  const contact = (found.bestMatch as { id: string } | undefined) ?? (parse(await mcp.callTool({ name: 'add_contact', arguments: { displayName: 'Banjo test line', phoneNumber: number } })) as { id: string });

  const startedAt = new Date();
  const placed = parse(await mcp.callTool({ name: 'place_call', arguments: { contactId: contact.id, ...CALLS[fixture] } }));
  const taskId = placed.taskId as string;
  console.log(`${fixture}: placed task ${taskId}`);

  let status = '';
  for (let i = 0; i < 72 && !TERMINAL.has(status); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    status = parse(await mcp.callTool({ name: 'get_task_status', arguments: { taskId } })).status as string;
  }
  await mcp.close();
  console.log(`${fixture}: task ended ${status || 'still running after 6 minutes'}`);

  // The fixture's side of the call: what it recorded, and for the menu, what was pressed.
  await new Promise((resolve) => setTimeout(resolve, 10_000)); // recordings finish processing
  const [leg] = await tw.calls.list({ to: number, startTimeAfter: startedAt, limit: 1 });
  const recordings = leg ? await tw.recordings.list({ callSid: leg.sid }) : [];
  let heard = '';
  for (const rec of recordings) {
    const audio = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${rec.sid}.wav`, {
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
    });
    heard += ` ${await transcribe(await audio.arrayBuffer())}`;
    await tw.recordings(rec.sid).remove(); // only the text is needed
  }
  heard = heard.trim();

  const checks: [string, boolean][] = [['the fixture answered', Boolean(leg)]];
  if (fixture === 'voicemail') {
    checks.push(['recorded voicemail_left', status === 'voicemail_left']);
    checks.push(['the message opens with the AI disclosure', DISCLOSURE.test(heard.split(/\s+/).slice(0, 15).join(' '))]);
    checks.push(['the disclosure is said once', (heard.match(/\bAI assistant\b/gi) ?? []).length === 1]);
  } else if (fixture === 'ivr') {
    const svc = (await tw.serverless.v1.services.list()).find((s) => s.uniqueName === 'banjo-fixtures');
    const env = svc && (await tw.serverless.v1.services(svc.sid).environments.list()).find((e) => e.uniqueName === 'production');
    const logs = svc && env ? await tw.serverless.v1.services(svc.sid).environments(env.sid).logs.list({ startDate: startedAt }) : [];
    const choices = logs.map((l) => /ivr pressed (\S) by (\w+)/.exec(l.message)).filter((m): m is RegExpExecArray => Boolean(m));
    const pressed = choices.map((m) => m[1]!);
    console.log(`${fixture}: chose ${choices.map((m) => `${m[1]} by ${m[2]}`).join(', ') || 'nothing'}`);
    checks.push(['chose 1 for appointments', pressed.includes('1')]);
    checks.push(['chose it with a key press (DTMF), not by voice', choices.some((m) => m[1] === '1' && m[2] === 'dtmf')]);
    checks.push(['never chose 2 for Spanish', !pressed.includes('2')]);
    checks.push(['opened to the person with the AI disclosure', DISCLOSURE.test(heard)]);
  } else {
    checks.push(['opened to the person with the AI disclosure', DISCLOSURE.test(heard)]);
    checks.push(['recorded answered', status === 'answered']);
  }
  console.log(`${fixture}: heard after the fixture's last line: ${JSON.stringify(heard.slice(0, 300))}`);
  for (const [name, pass] of checks) console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}`);
  process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
