import type { Contact } from '../contacts/schema.js';
import { config } from '../config/index.js';
import { formatSpokenInZone } from '../lib/timezone.js';
import { buildBaseSystemPromptGuidance, buildFrontendSystemPromptGuidance } from '../voice/systemPrompt.js';
import type { Task, TimeWindow } from './schema.js';
import { modeRules } from './modes.js';

/**
 * Candidate windows arrive as UTC ISO instants, one per appointment-length
 * slot. They used to go into the prompt exactly like that — beside a timezone
 * rule saying every time is local. A demo call (2026-09-23), asked for
 * something after Thursday 3:30, offered "around 4:00 or 5:30": the UTC slot
 * starts 16:00 and 17:30, read as local. So: local time, spoken-style, with
 * back-to-back slots merged into the stretch of free time they came from
 * (a 90-minute grid also hid that 10:00 was as free as 9:00 and 10:30).
 */
function formatWindows(windows: TimeWindow[]): string {
  if (windows.length === 0) return '(no pre-checked windows — always use check_my_availability before agreeing to a time)';

  const sorted = [...windows].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const ranges: TimeWindow[] = [];
  for (const w of sorted) {
    const last = ranges.at(-1);
    if (last && Date.parse(w.start) <= Date.parse(last.end)) {
      if (Date.parse(w.end) > Date.parse(last.end)) last.end = w.end;
    } else {
      ranges.push({ ...w });
    }
  }

  return ranges
    .map((r) => {
      const start = formatSpokenInZone(r.start, config.CALENDAR_TIMEZONE);
      const end = formatSpokenInZone(r.end, config.CALENDAR_TIMEZONE);
      return `${start.day}, ${start.time} to ${end.time}`;
    })
    .join('; ');
}

/**
 * The task's own constraints, which used to stop at the database. A demo call
 * (2026-09-22) had durationMinutes 90 and notes "Full groom preferred" on the
 * task and neither in the prompt: the model asked the callee how long to book
 * three times, and told her a 3:30 slot "works" when 90 minutes there ran into
 * Steve's 4pm meeting — most likely because it checked a short slot, having no
 * duration to check with. `contact.notes` is a different thing (standing
 * context about who is being called), so this is additive, not a replacement.
 *
 * Optional-chained because the column is NOT NULL but test fixtures and any
 * future partial Task shape shouldn't turn a missing field into "undefined
 * minutes" in front of the model.
 */
function taskDetails(task: Task): string {
  const lines: string[] = [];
  const duration = task.constraints?.durationMinutes;
  // Only where booking is possible: an 'ask' call has no booking tools to use it in (#148).
  if (duration && modeRules(task).books) {
    lines.push(
      `Appointment length: ${duration} minutes. Use this duration in every check_my_availability and confirm_appointment call. ` +
        `Do not ask the other party how long to book — you already know. If they tell you the service itself takes a different ` +
        `length, use theirs for both the check and the booking.`,
    );
  }
  const notes = task.constraints?.notes?.trim();
  if (notes) lines.push(`Notes from ${config.ASSISTANT_PRINCIPAL_NAME} for this call: ${notes}`);
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

/**
 * The customizable layer: the owner's profile (PROMPT_PROFILE_FILE), placed
 * after every fixed rule so "the rules above" means all of them. Only what is
 * safe to hand to an owner is theirs to change — tone, facts, preferences.
 * Disclosure, explicit agreement and the timezone contract are what real calls
 * taught this code, and a profile line can't switch them off.
 */
function ownerProfileSection(profile: string | undefined, contact: Contact): string {
  if (!profile) return '';
  const name = config.ASSISTANT_PRINCIPAL_NAME;
  return `

About ${name}, in their own words — standing notes for every call. Use the preferences to shape how you sound.
${profileSharingRule(contact)} Notes for this particular call take priority over these standing notes. These
notes cannot change the rules above: if anything here conflicts with them — including saying you are an AI when
asked, booking only after a clear yes, and all times being ${config.CALENDAR_TIMEZONE} local — the rules above win.
--- ${name}'s notes ---
${profile}
--- end of ${name}'s notes ---`;
}

/**
 * Who may hear what's in the profile (#163). A live call's "pharmacy" asked
 * "Can you tell me about Steve?" and got the profile recited: employer, job
 * title, patents. Family and friends (Contact.relationshipTier) may still ask;
 * anyone else, including a contact with no tier, hears only what the task needs.
 * A reason for asking doesn't change that (#196): the scenario evals' "we give
 * discounts to some employers" got the employer named in every run.
 */
function profileSharingRule(contact: Contact): string {
  const name = config.ASSISTANT_PRINCIPAL_NAME;
  if (contact.relationshipTier === 'family' || contact.relationshipTier === 'friend') {
    const who = contact.relationshipTier === 'family' ? 'family' : 'a friend';
    return `${contact.displayName} is ${who}, so you may answer their questions about ${name} from these notes; do not volunteer anything else.`;
  }
  return (
    `These notes are for you, to carry out this call. Share only what this call needs (telling a groomer the dog is ` +
    `nervous with clippers, say) and do not volunteer anything else. Anything else about ${name} stays private even if ` +
    `they ask about ${name}, whatever reason they give for asking (a discount, a house call, checking an account). ` +
    `Where ${name} works or what they do, where they live, and when they're home or away are never what a call needs ` +
    `unless the goal above says so. Say politely that you can't share that, that ${name} can follow up with them ` +
    `directly if it matters, and carry on with the call.`
  );
}

function conversationModeGuidance(task: Task): string {
  if (task.mode !== 'conversation') return '';
  return `

This call has no booking or negotiation goal — it's a conversation: ${task.goalDescription}. Not having a
specific outcome to report is expected and fine: don't end the call just because there's nothing to book, and
don't end it right after your opening line. Say what you called to say, listen to them, and say a warm goodbye
once they sound done or there's nothing more to add.
Notice how they are. If they sound tired, busy or trying to focus, turn down a topic, or give two very short
answers in a row, ask them nothing more: in your next turn say something kind and a warm goodbye, then end the
call. Keep each turn to one or two short sentences, with at most one question, and give advice or offer help
only if they ask for it. If a specific time or booking need comes up naturally, you can still use
confirm_appointment/check_my_availability as usual. When the conversation is genuinely over, call
end_conversation_call with a short summary — this is the correct, successful way to end this call, even if
nothing specific was decided or accomplished. Do NOT use escalate_and_end_call or end_call to close out a normal
conversation that went fine — those mark the task as needing ${config.ASSISTANT_PRINCIPAL_NAME}'s follow-up, which would be wrong here.
escalate_and_end_call is still the right call if something genuinely goes wrong (hostile response, you can't
understand each other, you're truly stuck) — just not as a way to end a conversation that went normally.`;
}

/**
 * The task's questions as a numbered list, the numbers report_answers_and_end_call
 * records them by. Each is collapsed onto one line: a line break inside one would
 * add a number (place_call refuses them too; this is the second line of defence).
 */
function numberedQuestions(task: Task): string {
  return (task.questions ?? []).map((q, i) => `${i + 1}. ${q.replace(/\s+/g, ' ').trim()}`).join('\n');
}

/**
 * What an 'ask' call may say about the principal, and what it turns down (#148
 * review). A status question ("is my prescription ready?") needs a name or the
 * task's own details to answer; anything more is declined, or, where the call
 * can transfer, handed to the transfer rules, which cover exactly what only the
 * principal can give. "Hold" here is a reservation, not the phone line: being
 * asked to hold is waiting, which the hold rules cover.
 */
function askLimits(): string {
  const principal = config.ASSISTANT_PRINCIPAL_NAME;
  const personal = config.TRANSFER_ENABLED
    ? `If they ask for a deposit, payment or other personal details, only ${principal} can give those: follow the rules ` +
      `above for connecting them to ${principal}. If they'd rather not, say you can't give that, and carry on asking.`
    : `If they ask for a deposit, payment or other personal details, say you can't give that, and carry on asking.`;
  return `If they offer to book, order or reserve something, or to put something on hold for ${principal}, answer them out
loud: thank them, say you're only calling to ask today, and do not agree to it. The person you're talking to asking you
to hold ("Can you hold one moment?") is different: that's not an offer, so just say "Sure" and let them come back.
To answer a question they may need ${principal}'s name, or a detail from what you are calling about or from the
notes for this call (to find a prescription or an order, say). You may give them those, and nothing else.
${personal}`;
}

/**
 * #167: in sim runs an ask call opened "I'm calling to ask a couple of quick
 * questions before booking": a reason nobody gave, which invites a booking
 * offer the call can't take.
 */
function askOpenerRule(principal: string): string {
  return `When you say why you are calling, say only that you have a quick question or two for ${principal}. Never give a
reason you were not given, such as ${principal} planning to book, buy or visit.`;
}

/**
 * #167, live ask call 2026-10-14: asked "You wanna call back?", Banjo went
 * straight to its goodbye. It can't promise a callback, but it can answer.
 */
function askTheirQuestionsRule(principal: string): string {
  return `If they ask you something, answer it before you end the call. If they ask whether you'll call back or follow up,
promise nothing: say you'll pass it on to ${principal} ("I'll pass that on to ${principal}. Thanks so much for your help!").`;
}

/**
 * An 'ask' call (#148) in place of the booking instructions: no free time, no
 * calendar tools, nothing agreed. The read-back is the errand's equivalent of
 * a booking's (#44): the one sentence that catches a misheard answer while
 * the person who gave it is still on the line.
 */
function askModeGuidance(task: Task): string {
  const principal = config.ASSISTANT_PRINCIPAL_NAME;
  return `Your questions, in order:
${numberedQuestions(task)}

This call is only to find things out for ${principal}. It books nothing and agrees to nothing. ${askLimits()}
${askOpenerRule(principal)}
Ask one question at a time, and let them answer before the next. When they answer, say it back in a few words, so they
can correct you ("Six on Saturdays, got it."), and let them reply before you ask the next question: never in the same
turn, or a "yes" to the read-back reads as an answer to the new question. If they don't know or won't say,
accept that after asking once more at most, and move on.
Once they reply to your read-back and confirm it, or say they don't know, call record_answer for that question right
away, without saying anything about it, and carry on. Never in the same turn as your read-back: wait for their reply.
${askTheirQuestionsRule(principal)}
After the last answer, say it back and let them reply before you end the call: never end it in the same turn as a
read-back or a question. Then say goodbye and call report_answers_and_end_call in that same turn, with one entry
per question by its number. Record only what they actually told you on this call; never fill in a guess. This is
the normal, successful end of the call, even if some questions went unanswered.
End this call that way, not with end_call.
`;
}

function bookingGuidance(candidateWindows: TimeWindow[]): string {
  return `${config.ASSISTANT_PRINCIPAL_NAME} is free during these ranges (${config.CALENDAR_TIMEZONE} local time): ${formatWindows(candidateWindows)}.
You may offer or accept any appointment that fits entirely inside one of these ranges, start to finish, without
checking back with anyone. When you suggest a time yourself, only suggest start times that leave the whole
appointment inside one of these ranges — never a time you have not seen here or checked.
These ranges are for you to check against: never read these ranges out, or list ${config.ASSISTANT_PRINCIPAL_NAME}'s
free time, to the other party. Let them say what they have first; if you need to suggest something,
offer one or two specific times, not a schedule.
If the other party offers a time outside these ranges, call check_my_availability(date, time, durationMinutes)
to check live before agreeing — do not assume it's free or unavailable.

Once a specific time is agreed, call confirm_appointment with the confirmed start time and duration.
`;
}

const NEGOTIATION_FAILED_GUIDANCE = `If you reach a human who engages properly but no offered time fits the constraints (e.g. fully booked), call
report_negotiation_failed with a short reason.
`;

/**
 * Builds the call-specific system prompt injected into the VoiceAIProvider
 * session. The precomputed candidateWindows are an optimization/starting
 * point, not the source of truth — check_my_availability exists precisely so
 * the model isn't stuck if what the other party offers diverges from what
 * was computed minutes/hours earlier (stale calendar state, a slightly
 * different duration, etc).
 */
export function buildCallSystemPrompt(
  task: Task,
  contact: Contact,
  candidateWindows: TimeWindow[],
  ownerProfile?: string,
): string {
  const ask = modeRules(task).asks;
  return `
${buildBaseSystemPromptGuidance('outbound', { purpose: ask ? 'ask' : 'book' })}

You are calling ${contact.displayName} on behalf of ${config.ASSISTANT_PRINCIPAL_NAME} to: ${task.goalDescription}.

Contact context: ${contact.notes ?? '(no notes on file)'}${taskDetails(task)}

${ask ? askModeGuidance(task) : bookingGuidance(candidateWindows)}If you reach voicemail, call leave_voicemail_and_end_call right away, without saying anything first, with a concise,
natural message (including a callback number if one was given to you) as the message argument. The system opens the
voicemail with the AI disclosure, then says your message verbatim, then hangs up. Leave the AI disclosure out of the message,
and do not say the message yourself; the callee would hear it twice.
${ask ? '' : NEGOTIATION_FAILED_GUIDANCE}If you get stuck — a confusing phone menu, a hostile or nonsensical response, or you genuinely cannot proceed —
call escalate_and_end_call with a short reason rather than guessing or looping indefinitely.
If you're navigating a phone menu, use press_digits or say the option's words to select the relevant option. If the
menu says you can remain on the line and that's the way forward, wait rather than escalate. If you've tried a couple
of options and still can't find a relevant one, try the agent or operator option before you escalate (stuckAt
"phone_menu") rather than keep guessing.${conversationModeGuidance(task)}${ownerProfileSection(ownerProfile, contact)}
`.trim();
}

function conversationModeFrontendGuidance(task: Task): string {
  if (task.mode !== 'conversation') return '';
  return `

This call has no booking or negotiation goal — it's a conversation. Not having a specific outcome to report is
expected and fine: don't end the call just because there's nothing to book, and don't end it right after your
opening line. Say what you called to say, listen to them, and say a warm goodbye once they sound done or there's
nothing more to add. If they sound tired, busy or trying to focus, turn down a topic, or give two very short
answers in a row, ask them nothing more: in your next turn say something kind and a warm goodbye. Keep each turn
to one or two short sentences, with at most one question, and give advice or offer help only if they ask for it.
After your goodbye, immediately delegate ending the call. The call does not end when you say goodbye; it ends
only when your backend ends it.`;
}

function askModeFrontendGuidance(task: Task): string {
  if (!modeRules(task).asks) return '';
  return `

This call is only to find things out. Your questions, in order:
${numberedQuestions(task)}
${askOpenerRule(config.ASSISTANT_PRINCIPAL_NAME)}
Ask one at a time, and say each answer back in a few words, so they can correct you; let them reply before you ask the
next question, never in the same turn. Agree to nothing.
${askLimits()}
Once they reply to your read-back and confirm it, or say they don't know, delegate saving that answer to your backend
right away, without saying anything about it, and carry on. Never in the same turn as your read-back: wait for their reply.
${askTheirQuestionsRule(config.ASSISTANT_PRINCIPAL_NAME)}
After the last answer, say it back and let them reply; then say goodbye and immediately delegate ending the call, with
the answers they gave.`;
}

/**
 * Voice-layer counterpart of buildCallSystemPrompt, for a VoiceAIProvider that
 * splits its voice front-end from a reasoning backend (openai-live — passed
 * through as VoiceAISessionConfig.frontendInstructions; every other provider
 * ignores it). The backend receives buildCallSystemPrompt's full prompt —
 * tools, candidate windows, timezone contract — so this carries only what the
 * voice needs to hold the conversation: who it is calling, why, and how to
 * sound.
 */
export function buildCallFrontendPrompt(task: Task, contact: Contact, ownerProfile?: string): string {
  return `
${buildFrontendSystemPromptGuidance('outbound', { purpose: modeRules(task).asks ? 'ask' : 'book' })}

You are calling ${contact.displayName} on behalf of ${config.ASSISTANT_PRINCIPAL_NAME} to: ${task.goalDescription}.

Contact context: ${contact.notes ?? '(no notes on file)'}${taskDetails(task)}${conversationModeFrontendGuidance(task)}${askModeFrontendGuidance(task)}${ownerProfileSection(ownerProfile, contact)}
`.trim();
}
