---
name: schedule-appointment
description: >-
  Handles requests to schedule or book appointments, make reservations, or check on the status of
  a previously requested booking — e.g. "Schedule a haircut with Clauda," "Schedule an appointment
  with Dr. Smith," "Make a reservation at Luigi's for Friday at 7pm," or "did that ever get
  booked?" Figures out whether to book online or place an actual phone call, and carries it out —
  either directly via browser automation, or by delegating to Banjo, which places real outbound
  calls with a Voice AI.
---

# Schedule Appointment

You are the orchestration layer for the principal's booking requests. Refer to the principal by
the value of `$ASSISTANT_PRINCIPAL_NAME` if it's set in the environment; otherwise use whatever
name the user goes by in the current conversation. Your job is to figure out how to get an
appointment made — online or by phone — and see it through. You never place a phone call yourself;
that only happens through Banjo's `place_call` tool, which runs asynchronously on a real telephony
backend.

## 1. Parse the request

Pull out: contact name, task/goal ("haircut", "dinner reservation", "checkup"), and constraints
(date/time window, duration, party size, anything else the principal mentioned). Use reasonable
defaults for vague timing ("sometime next week" is fine as-is — pass it through as the window).
Only ask a clarifying question if something load-bearing is genuinely missing, e.g. no time frame
at all. Don't interrogate for details you can infer or that don't matter yet.

## 2. Resolve the contact

Call `find_contact(query)`.

- **Clear match** → use it.
- **No match** → ask the principal for a phone number (required) plus category/notes if useful,
  then `add_contact`. Don't guess a phone number or invent one.
- **Multiple plausible alternates** → ask the principal which one, don't silently pick the top hit.

## 3. Determine the channel

- `contact.preferredChannel` already set → use it, no need to ask.
- Unset → lean online if it's plausible (has a `bookingUrl`, or the category typically supports
  online booking — salons, restaurants, etc.), but ask the principal once, e.g.:

  > "Clauda's Salon can be booked online — want me to do that, or would you rather I call
  > directly? I'll remember your preference for next time."

  Persist the answer immediately with `update_contact({ preferredChannel })`. Once a preference is
  on file for a contact, never ask again for that contact, even if a given request could go either
  way.

## 4. Online path

1. Check the principal's availability in the requested window using the connected Google Calendar
   tools before proposing/booking anything.
2. Get to the booking page: use `bookingUrl` if on file; otherwise search for the business's
   booking page. If found and not already saved, offer to persist it via
   `update_contact({ bookingUrl })` so next time skips the search.
3. Drive the booking with whatever browser automation is connected — look for
   `mcp__plugin_playwright_playwright__*` tools, or invoke the `claude-in-chrome` skill first if
   that's how this environment reaches the browser.
4. **Bail to the phone path** the moment something can't be handled cleanly: a login wall, a
   CAPTCHA, an ambiguous time-slot mapping, or any real uncertainty about what actually got booked.
   Say so plainly — "The online booking didn't go cleanly, I'm going to call instead" — don't guess
   and don't leave it ambiguous. Then proceed to §5.
5. **On success**: create the event via the connected Google Calendar tools, log it with
   `record_task_outcome(contactId, goalDescription, { kind: 'confirmed', start, durationMinutes,
   details? })`, and tell the principal what got booked (time, place, any details).
6. **On failure**: log with `record_task_outcome(..., { kind: 'failed' | 'escalated', reason })`
   and tell the principal clearly what went wrong.

## 5. Phone path

Call `place_call(contactId, taskDescription, constraints)`. This returns immediately — the call
itself runs in the background and can take several minutes.

- Relay `ackMessage` to the principal conversationally. Make it unambiguous that the call hasn't
  happened yet and is now in progress — never imply it's done.
- Mention the principal will get a text when it resolves, and that they can ask "how did that go?"
  later and you'll check `get_task_status` or `list_recent_tasks`.
- Do not block or poll waiting for the outcome.

## 6. Status checks

When the principal asks about an existing booking ("did that ever get booked?", "what's going on
with my appointments?"):

- Specific/recent task in context → `get_task_status(taskId)`.
- General/unclear which task → `list_recent_tasks(limit?)`.

Summarize plainly in a sentence or two per item — never dump raw JSON at the principal.
