import type { TimeWindow } from '../tasks/schema.js';

export interface CheckAvailabilityInput {
  dateWindows: TimeWindow[];
  durationMinutes: number;
}

export interface IsFreeInput {
  start: string; // ISO 8601
  durationMinutes: number;
}

export interface CreateEventInput {
  /** Server-generated (e.g. `confirm:${callAttemptId}`), never trusted from model output. */
  idempotencyKey: string;
  start: string; // ISO 8601
  durationMinutes: number;
  summary: string;
  description?: string;
}

export interface CreateEventResult {
  eventId: string;
  confirmedStart: string;
  confirmedEnd: string;
}

/**
 * Thrown by `createEventIdempotent` when the requested slot is no longer
 * free (something else — another call attempt, a manual edit, an unrelated
 * event — occupies it) and this isn't a retry of an already-confirmed
 * booking. Callers (e.g. confirm_appointment's handler) catch this
 * specifically so the model can be told to offer a different time, rather
 * than it surfacing as an opaque upstream_error.
 */
export class SlotUnavailableError extends Error {
  constructor(message = 'The requested time slot is no longer available.') {
    super(message);
    this.name = 'SlotUnavailableError';
  }
}

/**
 * Steve's own personal Google Calendar — used to compute when he's free to
 * offer, and to write the final confirmed appointment. NOT a business's
 * booking calendar. ea's phone-call path uses its own direct client
 * (googleCalendarProvider.ts, OAuth2 user-consent) because it must act
 * autonomously during a live call, outside any Claude conversation; the
 * schedule-appointment skill's online-booking path uses the Google Calendar
 * MCP tools already connected in Steve's environment instead of this
 * interface — the two paths deliberately don't share one client.
 */
export interface CalendarProvider {
  computeCandidateWindows(input: CheckAvailabilityInput): Promise<TimeWindow[]>;
  isFree(input: IsFreeInput): Promise<boolean>;
  createEventIdempotent(input: CreateEventInput): Promise<CreateEventResult>;
  /** Deletes a calendar event outright. Used by inbound's reschedule_booking (delete-then-recreate) — see src/inbound/tools.ts. */
  deleteEvent(eventId: string): Promise<void>;
}
