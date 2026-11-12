import { eq } from 'drizzle-orm';
import { overrideCalendarProvider } from '../calendar/factory.js';
import { config } from '../config/index.js';
import { addContact } from '../contacts/service.js';
import type { NewContact } from '../contacts/schema.js';
import { db } from '../db/index.js';
import { placeCallHandler, placeCallInputSchema } from '../mcp/tools/placeCall.js';
import { overrideTelephonyProvider } from '../telephony/factory.js';
import type { LoopInResult } from '../telephony/providers/types.js';
import { callAttempts, type Task } from '../tasks/schema.js';
import { getTask, isTerminalStatus } from '../tasks/service.js';
import { overrideVoiceAIProvider } from '../voice/factory.js';
import type { VoiceAIProvider } from '../voice/types.js';
import { SIM_BUSINESS_NUMBER } from './env.js';
import { describeToolCall, describeToolResult } from './plain.js';
import { SimCalendarProvider } from './simCalendar.js';
import { SimTelephonyProvider } from './simTelephony.js';
import { modeRules } from '../tasks/modes.js';
import { overrideOwnerMessages } from '../notifications/owner.js';
import { answerQuestion } from '../ownerQuestions/service.js';

/** A voice session the other party types into: OpenAIRealtimeProvider in text-only mode, or a test's fake. */
export interface TextVoiceAIProvider extends VoiceAIProvider {
  sendUserText(text: string): void;
  /** The other party has started typing: they count as speaking, so Banjo doesn't take the pause for silence. */
  userIsTyping?(): void;
}

export interface SimCallOptions {
  business: string;
  category: NonNullable<NewContact['category']>;
  goal: string;
  mode: 'booking' | 'conversation' | 'ask';
  /** mode 'ask' only (#148): what Banjo should find out. */
  questions?: string[];
  /** Booking and conversation only: an 'ask' call books nothing, so it gets neither. */
  durationMinutes: number;
  windowDays: number;
  /** When the booking window starts. Defaults to now; an eval replay passes the recording's (#188). */
  windowStart?: Date;
  /** The business contact's relationship tier, which decides how much of the owner profile Banjo may share (#163). */
  relationshipTier?: 'family' | 'friend';
  createVoiceAI: () => TextVoiceAIProvider;
  /** What the owner does if Banjo tries a warm transfer (#149). Defaults to accepting. */
  owner?: LoopInResult;
  /**
   * With --ask-owner: what the owner types for any ask_owner question, a few
   * seconds after it's sent, or null for never answering. Unset: ask_owner is off.
   */
  ownerAnswer?: string | null;
  /**
   * Show tool calls in plain words (sim/plain.ts), with a result only when it
   * adds something. Unset: the raw name, arguments and result, as JSON.
   */
  plainTools?: boolean;
  /** Everything the sim shows, other than what the person types. */
  print: (line: string) => void;
}

export interface SimCall {
  taskId: string;
  telephony: SimTelephonyProvider;
  calendar: SimCalendarProvider;
  /** Resolves with the session once the call is connected and Banjo is listening; with null if the task ended without one (e.g. refused by the call cap). */
  ready: Promise<TextVoiceAIProvider | null>;
  /** Resolves once the task is terminal and its call attempt has ended. */
  finished: Promise<Task>;
}

const POLL_MS = 250;

/** The sim's options don't make a call place_call would accept. Its message is the schema's. */
export class SimInputError extends Error {
  override name = 'SimInputError';
}

/**
 * Places one simulated outbound call (ROADMAP 4.5) through the same path a
 * real one takes: the place_call MCP handler, the orchestrator, the outbound
 * CallSession adapter, the real prompt and tools, real rows in the sim
 * database. Only the phone line, the calendar and the voice transport are
 * swapped, through the factories' override seams.
 */
export async function startSimCall(opts: SimCallOptions): Promise<SimCall> {
  // Through place_call's own schema, as the MCP server does before calling the
  // handler, so the sim can't start a call place_call would refuse (#148
  // review). First, so a refusal leaves nothing behind: no contact, no overrides.
  const windowStart = opts.windowStart ?? new Date();
  const windowEnd = new Date(windowStart.getTime() + opts.windowDays * 24 * 60 * 60 * 1000);
  const input = placeCallInputSchema.omit({ contactId: true }).safeParse({
    taskDescription: opts.goal,
    mode: opts.mode,
    questions: opts.questions,
    constraints:
      !modeRules({ mode: opts.mode }).books
        ? undefined
        : {
            durationMinutes: opts.durationMinutes,
            dateWindows: [{ start: windowStart.toISOString(), end: windowEnd.toISOString() }],
          },
  });
  if (!input.success) {
    throw new SimInputError(input.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
  }

  const telephony = new SimTelephonyProvider(opts.print, opts.owner);
  const calendar = new SimCalendarProvider(config.CALENDAR_TIMEZONE, opts.print);
  overrideTelephonyProvider(telephony);
  overrideCalendarProvider(calendar);
  overrideOwnerMessages((body) => showOwnerMessage(body, opts));

  let resolveReady!: (voice: TextVoiceAIProvider | null) => void;
  const ready = new Promise<TextVoiceAIProvider | null>((resolve) => (resolveReady = resolve));
  overrideVoiceAIProvider(() => {
    const voice = opts.createVoiceAI();
    showBanjo(voice, opts.print, opts.plainTools ?? false);
    voice.on('event', (event) => {
      if (event.type === 'connected') resolveReady(voice);
    });
    return voice;
  });

  const contact = await addContact({
    displayName: opts.business,
    phoneNumber: SIM_BUSINESS_NUMBER,
    category: opts.category,
    ...(opts.relationshipTier && { relationshipTier: opts.relationshipTier }),
  });
  const { taskId } = await placeCallHandler({ ...input.data, contactId: contact.id }, { role: 'owner' });

  const finished = waitUntilFinished(taskId);
  // A task that ends before Banjo ever connects (refused, failed to start) has no call to wait for.
  void finished.then(() => resolveReady(null));
  return { taskId, telephony, calendar, ready, finished };
}

/** How long the sim's owner takes to answer an ask_owner question. */
const OWNER_ANSWER_DELAY_MS = 4000;

/** A message to the owner, shown rather than sent; an ask_owner question is answered as --ask-owner says. */
function showOwnerMessage(body: string, opts: Pick<SimCallOptions, 'ownerAnswer' | 'print'>): void {
  const question = /\/answer\/([0-9a-f-]{36})\?sig=/.exec(body);
  if (!question) {
    opts.print(`[Message to the owner: ${body.replace(/\n+/g, ' ')}]`);
    return;
  }
  opts.print(`[Banjo asks the owner: ${body.split('\n').at(-1)!.replace(/^The question: /, '')}]`);
  const answer = opts.ownerAnswer;
  if (answer === null || answer === undefined) {
    opts.print("[The owner doesn't answer.]");
    return;
  }
  setTimeout(() => {
    opts.print(`[The owner answers: ${answer}]`);
    void answerQuestion(question[1]!, answer);
  }, OWNER_ANSWER_DELAY_MS).unref();
}

/** Clears the overrides startSimCall set, so nothing after it gets the sim's providers. */
export function endSimOverrides(): void {
  overrideOwnerMessages(null);
  overrideTelephonyProvider(null);
  overrideCalendarProvider(null);
  overrideVoiceAIProvider(null);
}

/** Prints Banjo's lines, and each tool call with its result, as they happen. */
function showBanjo(voice: TextVoiceAIProvider, print: (line: string) => void, plain: boolean): void {
  const principal = config.ASSISTANT_PRINCIPAL_NAME;
  const names = new Map<string, string>();
  voice.on('event', (event) => {
    if (event.type === 'transcript' && event.role === 'assistant' && event.isFinal && event.text.trim()) {
      print(`Banjo: ${event.text.trim().replace(/\s+/g, ' ')}`);
    } else if (event.type === 'tool_call') {
      names.set(event.call.id, event.call.name);
      print(plain ? `  · ${describeToolCall(event.call.name, event.call.arguments as Record<string, unknown>, principal)}` : `  → ${event.call.name} ${JSON.stringify(event.call.arguments)}`);
    }
  });
  const sendToolResult = voice.sendToolResult.bind(voice);
  voice.sendToolResult = (toolCallId, result, isError, options) => {
    if (plain) {
      const line = describeToolResult(names.get(toolCallId) ?? '', result, isError);
      if (line) print(`    ${line}`);
    } else {
      print(`  ← ${isError ? 'error ' : ''}${JSON.stringify(result)}`);
    }
    sendToolResult(toolCallId, result, isError, options);
  };
}

async function waitUntilFinished(taskId: string): Promise<Task> {
  for (;;) {
    const task = await getTask(taskId);
    if (!task) throw new Error(`sim: task ${taskId} disappeared`);
    if (isTerminalStatus(task.status)) {
      const attempts = await db.select({ endedAt: callAttempts.endedAt }).from(callAttempts).where(eq(callAttempts.taskId, taskId));
      if (attempts.every((attempt) => attempt.endedAt)) return task;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
