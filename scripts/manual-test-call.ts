#!/usr/bin/env -S npx tsx
/**
 * Manual, ad-hoc script for exercising a real outbound call end-to-end
 * without going through the MCP layer — it seeds/reuses a contact, calls the
 * exact same placeCallHandler() the place_call MCP tool wraps, then polls
 * task status and prints it as the call progresses.
 *
 * Deliberately bypasses the MCP HTTP/SSE transport (mcp/server.ts) so this
 * script's correctness doesn't depend on that layer — it calls the
 * underlying handler function directly. To test the MCP transport itself,
 * point a real MCP client (e.g. Claude Code) at the running server's
 * /mcp/sse endpoint instead.
 *
 * This script STARTS THE SERVER ITSELF (same startServer()/startOrchestrationPoller()
 * as src/index.ts) in-process, because TwilioProvider keeps its per-call
 * state (the WebSocket for an in-progress media stream) in memory — the
 * process that originates the call must be the same process whose HTTP
 * server receives Twilio's media-stream WebSocket connection back. Do NOT
 * run this alongside a separately-running `npm run dev` on the same port.
 *
 * THIS PLACES A REAL PHONE CALL. Requires PUBLIC_HOSTNAME to point at a
 * publicly reachable tunnel (e.g. `ngrok http $PORT`) so Twilio can reach
 * this process for the TwiML webhook and media-stream WebSocket.
 *
 * Usage:
 *   npx tsx scripts/manual-test-call.ts --phone "+15551234567" [options]
 *
 * Options:
 *   --phone <e164>         Required (unless --contact-id given). Number to call.
 *   --name <string>        Contact display name. Default: "Manual Test Contact".
 *   --contact-id <uuid>    Reuse an existing contact instead of creating one.
 *   --category <string>    salon|medical|restaurant|home_services|other. Default: other.
 *   --goal <string>        Task description read into the call's system prompt.
 *   --notes <string>       Extra context injected into the call system prompt.
 *   --duration <minutes>   Appointment duration to negotiate. Default: 15.
 *   --window-days <n>      How many days out the offerable window extends. Default: 3.
 *   --yes                  Skip the interactive confirmation prompt.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { config } from '../src/config/index.js';
import { addContact, findContact } from '../src/contacts/service.js';
import { logger } from '../src/lib/logger.js';
import { startServer } from '../src/server.js';
import { getTask } from '../src/tasks/service.js';
import { startOrchestrationPoller } from '../src/tasks/orchestrator.js';
import { placeCallHandler } from '../src/mcp/tools/placeCall.js';

const TERMINAL_STATUSES = new Set(['confirmed', 'voicemail_left', 'negotiation_failed', 'escalated', 'failed', 'cancelled']);

async function main() {
  const { values } = parseArgs({
    options: {
      phone: { type: 'string' },
      name: { type: 'string', default: 'Manual Test Contact' },
      'contact-id': { type: 'string' },
      category: { type: 'string', default: 'other' },
      goal: {
        type: 'string',
        // end_call is the correct fit for "just a connectivity test,
        // nothing to book" — it ends the call without mislabeling the task
        // as an escalation (which needlessly flags it for Steve's
        // attention). Only a tool handler can call TelephonyProvider.
        // hangUp() — the model itself has no way to end a call unprompted —
        // so the goal must explicitly name a tool for the model to reach a
        // clean ending at all.
        default:
          "This is a manual scaffold test call — please mention it's a test, confirm you can hear the caller, then call end_call to end the call. Do not attempt a real booking.",
      },
      notes: { type: 'string', default: '' },
      duration: { type: 'string', default: '15' },
      'window-days': { type: 'string', default: '3' },
      yes: { type: 'boolean', default: false },
    },
  });

  if (!values['contact-id'] && !values.phone) {
    console.error('Error: --phone is required unless --contact-id is given.\n');
    console.error('Usage: npx tsx scripts/manual-test-call.ts --phone "+15551234567" [--goal "..."] [--yes]');
    process.exit(1);
  }

  console.log('\n--- ea manual test call ---');
  console.log(`Telephony provider: twilio`);
  console.log(`Voice AI provider:  ${config.VOICE_AI_PROVIDER}`);
  console.log(`Public hostname:    ${config.PUBLIC_HOSTNAME ?? '(not set — Twilio will not be able to reach this process!)'}`);
  console.log(`Target:             ${values['contact-id'] ? `existing contact ${values['contact-id']}` : `${values.name} <${values.phone}>`}`);
  console.log(`Goal:                ${values.goal}`);
  console.log('----------------------------\n');

  if (!values.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('This will place a REAL outbound phone call. Continue? [y/N] ');
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // Same startup sequence as src/index.ts — must run in this process so the
  // TwilioProvider instance that originates the call is the same one that
  // receives the media-stream WebSocket connection back from Twilio.
  startServer();
  startOrchestrationPoller();

  const contactId = await resolveContactId(values);

  const durationMinutes = Number.parseInt(values.duration ?? '15', 10);
  const windowDays = Number.parseInt(values['window-days'] ?? '3', 10);
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  const { taskId, ackMessage } = await placeCallHandler({
    contactId,
    taskDescription: values.goal ?? '',
    constraints: {
      durationMinutes,
      dateWindows: [{ start: now.toISOString(), end: windowEnd.toISOString() }],
      notes: values.notes || undefined,
    },
  });

  console.log(`\nTask created: ${taskId}`);
  console.log(`${ackMessage}\n`);
  console.log('Watching task status (server logs above/below are the structured pino logs from the live call)...\n');

  await pollUntilTerminal(taskId);
}

async function resolveContactId(values: Record<string, string | boolean | undefined>): Promise<string> {
  if (values['contact-id']) return values['contact-id'] as string;

  const name = values.name as string;
  const { bestMatch } = await findContact(name);
  if (bestMatch && bestMatch.phoneNumber === values.phone) {
    console.log(`Reusing existing contact "${bestMatch.displayName}" (${bestMatch.id})`);
    return bestMatch.id;
  }

  const contact = await addContact({
    displayName: name,
    phoneNumber: values.phone as string,
    category: values.category as never, // validated against the DB enum on insert
    notes: (values.notes as string) || undefined,
  });
  console.log(`Created contact "${contact.displayName}" (${contact.id})`);
  return contact.id;
}

async function pollUntilTerminal(taskId: string): Promise<void> {
  let lastStatus: string | null = null;

  // No hard timeout by default — a live call can take a few minutes, and
  // exiting this process would kill the server (and the in-progress call)
  // out from under it. Ctrl+C when you're done watching; that's the
  // deliberate way to end this script (and the underlying call, if still live).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const task = await getTask(taskId);
    if (!task) {
      console.log('Task disappeared — exiting.');
      return;
    }
    if (task.status !== lastStatus) {
      console.log(`[${new Date().toISOString()}] status -> ${task.status}`);
      lastStatus = task.status;
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      console.log('\n--- final outcome ---');
      console.log(JSON.stringify({ status: task.status, outcome: task.outcome, calendarEventId: task.calendarEventId }, null, 2));
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

main().catch((err) => {
  logger.error({ err }, 'manual-test-call failed');
  process.exit(1);
});
