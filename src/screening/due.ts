import { APPROVAL_WINDOW_MS, buildApprovalMessage } from '../approvals/request.js';
import type { Contact } from '../contacts/schema.js';
import { addressBookNameFor } from '../googleContacts/lookup.js';
import { logger } from '../lib/logger.js';
import { sendOwnerMessage } from '../notifications/owner.js';
import type { Task } from '../tasks/schema.js';
import { cancelPendingTask, holdForScreening } from '../tasks/service.js';
import { screenCall } from './request.js';

/**
 * A scheduled call is screened again when it comes due (#150): by then the
 * contact may have asked not to be called again. Skipped once the owner has
 * approved it, unless that ask came after the approval.
 */
export function needsScreeningWhenDue(task: Pick<Task, 'scheduledFor' | 'approvedAt'>, contact: Pick<Contact, 'doNotCallAt'>): boolean {
  if (!task.scheduledFor) return false;
  if (!task.approvedAt) return true;
  return contact.doNotCallAt !== null && contact.doNotCallAt > task.approvedAt;
}

/**
 * Screens a due call; resolves true if it must not be dialed now. A held one
 * waits for the owner's approval like any other (the poller cancels it if
 * the window passes), and one whose owner can't be reached is cancelled.
 */
export async function screenWhenDue(task: Task, contact: Contact): Promise<boolean> {
  const screen = await screenCall(contact, { mode: task.mode, goal: task.goalDescription, questions: task.questions, notes: task.constraints.notes });
  if (!screen.held) return false;
  const held = await holdForScreening(task.id, screen.reason, new Date(Date.now() + APPROVAL_WINDOW_MS));
  if (!held) return true;
  const addressBookName = await addressBookNameFor(contact);
  const delivered = await sendOwnerMessage(buildApprovalMessage({ contact: { ...contact, addressBookName }, task: held }));
  if (!delivered) {
    logger.warn({ taskId: task.id }, "call screening held a due call and couldn't reach the owner; cancelling it");
    await cancelPendingTask(task.id);
  }
  return true;
}
