import { Hono, type Context } from 'hono';
import { config } from '../config/index.js';
import { getContact } from '../contacts/service.js';
import { triggerOrchestration } from '../tasks/orchestrator.js';
import type { Task } from '../tasks/schema.js';
import { approveTask, getTask } from '../tasks/service.js';
import { isValidApprovalSignature } from './link.js';
import { escapeHtml, page } from './page.js';
import { addressBookNameFor } from '../googleContacts/lookup.js';
import { contactNames, formatLocal, tierNote } from './request.js';

/**
 * The owner's page for approving a call an agent asked for. GET only shows
 * it, so a link preview or prefetch can't approve anything; the button
 * POSTs. Every failure (a bad sig, an unknown task, one that never needed
 * approval) gets the same page, so it can't be used to find task ids.
 */
export const approvalRoutes = new Hono();

export const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(c: Context) {
  return c.html(page('Banjo', '<h1>This link isn’t valid</h1><p>Ask for the call again if you still want it.</p>'), 404, HEADERS);
}

async function signedTask(taskId: string, sig: string | undefined): Promise<Task | undefined> {
  if (!sig || !UUID.test(taskId)) return undefined;
  const task = await getTask(taskId);
  if (!task?.approvalExpiresAt) return undefined;
  return isValidApprovalSignature(task.id, task.approvalExpiresAt, sig) ? task : undefined;
}

function whenHtml(task: Task, now: number): string {
  if (!task.scheduledFor) return 'Now';
  if (task.scheduledFor.getTime() > now) return escapeHtml(formatLocal(task.scheduledFor));
  const minutes = Math.round((now - task.scheduledFor.getTime()) / 60_000);
  return `<span class="warn">Scheduled for ${escapeHtml(formatLocal(task.scheduledFor))}, ${minutes} minutes ago: approving calls now</span>`;
}

/** Everything else from the task that reaches the call: what the owner approves has to include it. */
function constraintRows(task: Task): Array<[string, string]> {
  const { notes, durationMinutes, maxHoldMinutes, dateWindows } = task.constraints ?? {};
  const rows: Array<[string, string]> = [];
  if (notes?.trim()) rows.push(['Notes for the call', escapeHtml(notes.trim())]);
  if (dateWindows?.length) {
    const windows = dateWindows.map((w) => `${formatLocal(new Date(w.start))} to ${formatLocal(new Date(w.end))}`);
    rows.push(['Acceptable times', escapeHtml(windows.join('\n'))]);
  }
  if (durationMinutes) rows.push(['Appointment length', `${durationMinutes} minutes`]);
  if (maxHoldMinutes) rows.push(['Longest wait on hold', `${maxHoldMinutes} minutes`]);
  return rows;
}

const PAGE_NAME_LABELS = {
  address_book: 'Who (from your address book)',
  typed_in: 'Who (name typed in, not from your address book)',
  typed_in_differs: 'Name saved in Banjo, typed in (used on the call)',
} as const;

approvalRoutes.get('/approve/:taskId', async (c) => {
  const sig = c.req.query('sig');
  const task = await signedTask(c.req.param('taskId'), sig);
  if (!task) return invalid(c);
  const found = await getContact(task.contactId);
  const contact = found && { ...found, addressBookName: await addressBookNameFor(found) };
  const now = Date.now();
  const expiresAt = task.approvalExpiresAt!;
  const rows: Array<[string, string]> = [
    // Banjo's labels, in the <dt>: after an agent-written name they could be imitated.
    ...(contact
      ? contactNames(contact).map(([label, name], i): [string, string] =>
          i === 0 ? [PAGE_NAME_LABELS[label], escapeHtml(`${name} (${contact.phoneNumber})`)] : [PAGE_NAME_LABELS[label], escapeHtml(name)],
        )
      : ([['Who', 'Unknown contact']] as Array<[string, string]>)),
    ...(contact && tierNote(contact) ? ([['Your profile', escapeHtml(tierNote(contact)!)]] as Array<[string, string]>) : []),
    ['When', whenHtml(task, now)],
    ['Kind of call', escapeHtml(task.mode)],
    // Partly the screening model's words (#150): escaped, under Banjo's label.
    ...(task.screenFlag ? ([['Held by call screening', escapeHtml(task.screenFlag)]] as Array<[string, string]>) : []),
    [task.requestedByAgent ? 'What the agent asked for' : 'What was asked for', escapeHtml(task.goalDescription)],
    ...(task.questions?.length
      ? ([['Questions', escapeHtml(task.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'))]] as Array<[string, string]>)
      : []),
    ...constraintRows(task),
    ...(contact?.notes?.trim() ? ([['Notes on this contact (used on every call to them)', escapeHtml(contact.notes.trim())]] as Array<[string, string]>) : []),
    ['Approve by', escapeHtml(`${formatLocal(expiresAt)} (${config.CALENDAR_TIMEZONE})`)],
  ];
  const action = task.approvedAt
    ? '<p>Already approved.</p>'
    : task.status !== 'pending'
      ? '<p>This request was cancelled, so the call won’t be placed.</p>'
      : expiresAt.getTime() <= now
        ? '<p>This request expired, so the call won’t be placed.</p>'
        : `<form method="post" action="/approve/${task.id}"><input type="hidden" name="sig" value="${escapeHtml(sig!)}"><button type="submit">Approve this call</button></form>`;
  const list = rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('');
  return c.html(page('Approve a call?', `<h1>An agent wants Banjo to make a call</h1><dl>${list}</dl>${action}`), 200, HEADERS);
});

const RESULTS = {
  approved: 'Approved. Banjo will place the call.',
  already_approved: 'This call was already approved.',
  expired: 'This request expired, so the call won’t be placed.',
  not_waiting: 'This request was cancelled, so nothing changed.',
  not_found: 'This link isn’t valid',
} as const;

approvalRoutes.post('/approve/:taskId', async (c) => {
  const body = await c.req.parseBody();
  const sig = typeof body.sig === 'string' ? body.sig : undefined;
  const task = await signedTask(c.req.param('taskId'), sig);
  if (!task) return invalid(c);
  const result = await approveTask(task.id);
  if (result === 'approved') triggerOrchestration(task.id);
  return c.html(page('Banjo', `<h1>${escapeHtml(RESULTS[result])}</h1>`), 200, HEADERS);
});

/** For the request log: an approval link's signature is a credential. */
export function redactQuery(query: Record<string, string>): Record<string, string> {
  return 'sig' in query ? { ...query, sig: '[redacted]' } : query;
}
