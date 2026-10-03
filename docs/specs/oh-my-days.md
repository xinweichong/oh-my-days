# Oh My Days — Product and implementation specification

Status: Agreed product scope; implementation proposal ready for validation  
Date: 2026-09-16  
Working application name: **Oh My Days**

## 1. Purpose

Oh My Days is a personal scheduling and task assistant operated through Telegram. Users capture and manage commitments in an app they already open daily, while Google Calendar provides the visual calendar interface.

The first version serves the owner, with an architecture that can support a small number of independent users. Events and tasks are both core features. Every dependency must remain on a free tier; paid fallbacks and expiring trial credits are not acceptable.

This document records the completed design interview. Sections describing proposed implementation choices or validation work are explicitly identified; they do not represent completed engineering work.

## 2. Scope

### Included

- Private, one-to-one Telegram conversations.
- Text input, including forwarded text.
- **One instruction per message.**
- Natural-language interpretation through a free-eligible Gemini API model, subject to the data restrictions below.
- Structured slash commands and buttons that work without AI.
- One Google account per user, with multiple selected calendars.
- Reading and editing events regardless of whether Telegram or Google Calendar created them, subject to the user's calendar permissions.
- Event invitations, attendee updates, and cancellations with explicit confirmation before notifying others.
- Tasks with optional deadlines, task lists, completion, snoozing, and fixed recurrence.
- Bidirectional synchronization of supported calendar and task changes.
- Daily agendas, reminders, calendar views, sync health, manual polling, and reauthorization.

### Deferred or excluded

- iCloud integration, additional calendar providers, and multiple Google accounts per user.
- Telegram group chats, shared task lists, and collaborative scheduling features.
- Public signup and unrestricted access.
- Voice notes, screenshots, image interpretation, and multi-instruction messages.
- Completion-relative recurrence, such as three months after the previous completion.
- Gmail email integration and Google Contacts integration.
- A separate calendar or task-management frontend. Minimal Google authorization pages may be needed.
- Paid infrastructure, paid AI fallback, and automatic upgrades.

## 3. User setup and settings

1. A permitted user starts a private conversation with the bot.
2. The user connects one Google account through authorization.
3. The bot lists existing calendars and lets the user select calendars for views and synchronization.
4. The user chooses an existing writable calendar as the default for new events, or creates a new calendar through the bot and selects it.
5. The bot provisions or links the user's dedicated task calendar: **Tasks - Oh My Days**.
6. The user's initial timezone is **Asia/Singapore**. The user can change it explicitly when travelling or relocating.

New events use the selected default calendar unless the instruction names another writable calendar. Task deadlines always use the dedicated task calendar.

Permissions must be respected. Connecting an account does not grant organizer rights over someone else's meeting or write access to a read-only calendar. Explain unavailable actions instead of implying they succeeded.

Proposed implementation defaults:

- Restrict initial access using a Telegram user-ID allowlist.
- Treat calendars as provider IDs, not names, so renames do not break links.
- If a dedicated task calendar already exists, verify its identity before creating another.
- Timezone changes affect future date interpretation and local reminder schedules. They do not silently shift existing event instants or recurring series; use their stored timezones.

## 4. Conversation behavior

### One instruction per message

Each message requests one action. Attributes belonging to that action are allowed: title, date, duration, list, calendar, invitees, and reminder preferences.

- Supported: `Lunch Friday at noon for two hours on Personal`.
- Supported: `Add submit expenses to Work, due Friday`.
- Unsupported: `Lunch Friday at noon, submit expenses Monday, and buy milk`.

For a message containing multiple independent instructions, explain the limit and ask the user to send them separately. Do not partially execute it or silently discard instructions.

### Events versus tasks

- A timed activity normally represents an event: `Call Alex tomorrow at 3pm`.
- Explicit task language, such as `add a task`, `remind me`, or a deadline expressed with `by`, identifies a task.
- **A date attached to a task counts as its deadline** without requiring the word `due` or `by`. Explicitly snoozing a reminder or overriding its notification time does not move an established deadline.
- `Remind me to buy milk tomorrow` creates a task due tomorrow and places its deadline on the task calendar.
- `Buy milk` creates an open-ended task with no calendar entry.
- If intent, date, time, calendar, or target is materially ambiguous, ask a focused clarification.
- Confirmation messages clearly label the result as an event or task and show the interpreted date/time.

### Follow-ups

Support corrections such as `Move it to 4pm` and `Actually, make that Friday`.

Use the item in the message being replied to first. Otherwise use the single item most recently discussed. If more than one item could match, ask which one. Do not use ambiguous context to make changes.

### Execution and confirmation

| Action | Behavior |
|---|---|
| Clear create or edit without attendee notifications | Execute immediately, then show the exact result and an Undo action |
| Ambiguous instruction or target | Clarify before acting |
| Delete or cancel through Telegram | Confirm before acting |
| Change an entire recurring series | Confirm scope before acting |
| Send invitations, attendee updates, or cancellations | Preview the change and affected recipients; confirm before sending |
| Overlapping event | Create it and flag conflicting appointments in the reply |

Undo must restore the prior state only when it remains valid. It must not overwrite subsequent edits. A notification already sent cannot be unsent; a reversal that notifies attendees requires confirmation too.

## 5. Events and invitations

- Default event duration: **one hour** when no end time or duration is given.
- Explicit end times and durations override that default.
- Show the complete interpreted range in the result, such as Friday, 7–8pm.
- Default Telegram reminder: **one hour before the event**.
- Apply this reminder to all timed events in selected calendars, including events created outside the bot.
- Exclude cancelled events and invitations the user has declined.
- Permit per-event reminder overrides in natural language or structured input.
- Detect overlaps against selected calendars. Task deadline markers do not reserve time and must not generate scheduling conflicts.
- Fixed recurring events are supported. Distinguish editing one occurrence from editing a series.

For invitees, accept explicit email addresses. If the user names someone without a known address, ask for the email and offer to save a per-user contact shortcut. Show the full address in the invitation confirmation. Do not require Google Contacts access or guess an address.

All-day events appear in date-based views and agendas. Proposed default: no one-hour-before alert for all-day events, since the agreed one-hour rule applies to timed events.

## 6. Tasks and lists

### Deadlines and calendar representation

| Task | Calendar behavior | Default Telegram reminder |
|---|---|---|
| No deadline | Stored as an open-ended task; no calendar entry | No automatic deadline reminder |
| Date-only deadline | All-day deadline marker on that date | 8am on the due date |
| Exact date and time | Deadline marker preserving the exact due time | Included in the 8am agenda and reminded one hour before the deadline |

Deadlines show when work is due; they do not reserve work time. A separate explicit scheduling instruction can create a work-time event for a task.

Use ordinary calendar entries in **Tasks - Oh My Days** as the task deadline projection. The application owns task state, including open-ended tasks, lists, snoozes, and recurrence occurrence status. This is not a Google Tasks integration.

Entries created directly in the dedicated task calendar become tasks. Ordinary entries in other selected calendars remain events.

Proposed date semantics: a date-only task becomes overdue after the end of its due date in its applicable timezone; an exact-time task becomes overdue after that instant. The 8am reminder is not itself a deadline.

### Lists

- Each task belongs to **exactly one list**.
- Default list: **Inbox** when none is specified.
- Users can create lists and move tasks between them through Telegram.
- Show the list name in the calendar title: `[Work] Submit expenses`.
- Completing the task changes the title to `✓ [Work] Submit expenses`.
- Moving a task updates its title annotation without changing its identity or deadline.
- Lists are personal to each user.

Proposed import rule: a task created directly in the task calendar without a recognized list annotation goes to Inbox. A recognized annotation maps to that list. An unknown or ambiguous annotation must not silently create duplicate lists.

### Completion, cancellation, and synchronization

- Marking a task complete stops its reminders and keeps its calendar entry visible with a leading `✓`.
- Adding a leading `✓` directly in the calendar completes the corresponding task in Telegram.
- Removing that marker reopens the task and makes it eligible for reminders again.
- Deleting a task's calendar entry cancels the corresponding task and stops reminders in Telegram.
- Cancellation is distinct from completion. Keep cancelled tasks recoverable in application history.
- Editing a task's deadline or title in either interface updates the other interface.
- Explicitly removing a deadline through Telegram makes the task open-ended and removes its calendar projection. This application-initiated removal must not be misinterpreted as a user cancellation.

### Snoozing

- Snooze changes **only the next reminder**, never the task deadline.
- Snoozed tasks stay out of the automatic daily agenda and overdue summary until their snooze expires. On-demand task and reminder views may still display them with their snooze status.
- Changing the deadline is a separate action that also updates the calendar.
- Done and Snooze actions are available from task reminders and relevant task views.

### Recurring tasks

- Support fixed daily, weekly, monthly, and yearly schedules.
- Each occurrence has independent completion, cancellation, deadline, and reminder state.
- An unfinished older occurrence remains open when the next one becomes due.
- Completing one occurrence never clears another.
- Group multiple overdue occurrences of the same task in summaries while preserving occurrence-specific actions.
- Editing or deleting one calendar occurrence affects only the matching task occurrence. Whole-series changes require the correct scope.

Example: September's overdue rent task remains open when October's rent task is generated. Completing October's task does not complete September's.

## 7. Daily agenda, reminders, and views

### Daily agenda

Send one combined message at **8am in the user's configured timezone** containing:

- Today's events.
- Tasks due today.
- Overdue tasks eligible for reminders.
- A count of open-ended tasks, such as `6 tasks without deadlines`, with a View tasks action.

Date-only due reminders and the overdue summary are combined into this message. Do not send duplicate 8am task messages for the same items. Overdue tasks continue to appear daily until completed, cancelled, snoozed, or rescheduled.

Event reminders and exact-time task reminders remain separate one-hour-before notifications. Reminder overrides must be shown in `/reminders`.

### Slash commands

These views and controls must work without AI:

| Command | Behavior |
|---|---|
| `/daily` | Today's events, due tasks, overdue tasks, and an open-ended task count |
| `/weekly` | Current calendar week, Monday–Sunday, grouped by day |
| `/monthly` | Current calendar month, presented compactly |
| `/tasks` | Open tasks with task-list filters and item actions |
| `/reminders` | Upcoming reminders, including snoozed reminders |
| `/calendars` | Calendar picker and a view filtered to one calendar |
| `/overdue` | Unfinished tasks past their deadline |
| `/health` | Google Calendar connection and synchronization health |
| `/help` | Available commands and examples |

Weekly and monthly views use actual calendar periods, not rolling 7/30-day windows. Provide Previous/Next navigation and appropriate filtering. Natural language may request other ranges, such as the next seven days.

Structured fallback must also support creating and editing events and tasks, completion, snoozing, cancellation, and settings changes. Proposed command entry points are `/event`, `/task`, and `/settings`, backed by guided prompts and buttons. Exact fallback syntax is an implementation choice, not an additional product decision.

Use pagination and compact grouping for large views. Views should provide quick insights inside Telegram; the calendar app remains the visual scheduling interface.

## 8. Calendar synchronization and recovery

### Synchronization

- Read and edit supported items across the user's selected calendars, regardless of origin.
- Carry changes in both directions, including task completion markers and calendar deletions.
- Maintain stable links between application records, Google calendar IDs, event IDs, series IDs, and occurrence identities.
- Detect external edits before applying pending writes.
- If the same field changed while a Telegram edit was pending, ask the user which value to keep.
- Changes to unrelated fields may proceed without overwriting external edits.
- A successful read or write is required before reporting the relevant Google operation as complete.

Example conflict: `This meeting moved to 5pm in Calendar while your request to move it to 4pm was pending. Which time should I keep?`

### Temporary failure and pending operations

If Google Calendar is temporarily unavailable, persist the request as pending, tell the user it has not synced, and retry automatically. Confirm eventual success.

Before retrying, revalidate the target and current state. Ask the user if the scheduled time has passed or a conflicting edit occurred. Do not blindly replay stale actions or send attendee notifications that no longer match the confirmed preview.

Proposed implementation safeguards:

- Use bounded retries with backoff and durable pending-operation state.
- Make handling of repeated Telegram updates and retried calendar writes idempotent.
- Preserve unrelated calendar fields when applying patches.
- Treat provider content and forwarded text as data, never as instructions that bypass the user's intent or confirmation rules.
- Distinguish user deletion from temporary absence, loss of access, or an incomplete sync.

### Health and manual controls

`/health` displays:

- Google Calendar connection status and whether reauthorization is required.
- Last successful synchronization time.
- Consecutive failed checks and a useful, non-sensitive error summary.
- Pending calendar changes.
- **Force poll** and **Reauthorize** buttons.

Force poll requests an immediate synchronization. Use a cooldown and coalesce repeated requests to conserve quotas. Report whether the request was accepted, already running, or deferred.

Reauthorize starts Google account reconnection. Include this button in authentication-failure alerts. These controls are for **Google Calendar**, not Gmail email.

### Health notifications

- Alert through Telegram after **three consecutive failed checks**.
- Alert immediately when access is revoked or the user must reconnect.
- Send one recovery notification when synchronization resumes.
- Avoid repeating the same outage notification on every failed check.

Proposed implementation definition: count failures of completed sync attempts, not every internal retry within one attempt. A successful check resets the consecutive-failure count.

### Missed reminders

After bot downtime, send one catch-up summary for overdue tasks and still-upcoming events whose reminders were missed. Do not send a burst of stale alerts. Skip old one-hour-before event warnings once the events have started.

Do not imply that a Google sync outage, an AI outage, and a full hosting/database outage have identical effects. AI loss should not stop deterministic features. When hosting or storage is unavailable, reminders or health messages can themselves be delayed until recovery.

## 9. Language interpretation and data boundaries

Use the **Gemini API free tier** for language interpretation. Keep the model configurable and select a free-eligible model only after checking the project's active quotas and testing representative instructions.

The model interprets intent. Application code owns authorization, validation, target selection, confirmations, calendar mutations, conflict checks, scheduling, and execution results.

### Data handling

Gemini's unpaid-service terms allow inputs and outputs to be used for product improvement and human review, and instruct users not to submit sensitive, confidential, or personal information. This motivates the restricted input design. See the [Gemini API terms](https://ai.google.dev/gemini-api/terms).

The user agreed to restrict Gemini input to sanitized scheduling instructions. Do not send raw calendar contents, names, email addresses, locations, private appointment details, tokens, or credentials to Gemini.

Proposed approach:

1. Identify and retain private content in the application.
2. Where safe, substitute opaque references and send only the action/timing information required for interpretation.
3. Resolve references and validate the proposed action inside the backend.
4. If the request cannot be safely sanitized, use structured input instead of sending it to Gemini.

Removing names alone is insufficient: task wording and appointment descriptions can reveal private information. Sanitization is a mandatory validation item, not an assumed solved problem. No external AI should be used to sanitize the raw message, since that would already disclose it.

### Free-tier fallback

If Gemini is unavailable, rate-limited, or out of free quota, explain that natural-language processing is temporarily unavailable and offer structured commands/buttons. Do not switch to a paid model or silently queue ambiguous natural-language mutations for later execution.

Daily agendas, reminders, task actions, views, health controls, and synchronization operate without AI. User-visible success messages must reflect actual execution, not merely a model prediction.

## 10. Proposed architecture and free-tier budgets

### Components

| Component | Proposed service | Responsibility |
|---|---|---|
| Telegram bot backend | Cloudflare Workers Free, served at `ohmydays.xinweichong.com` | Webhooks, commands, validation, authorization callbacks, provider calls |
| Durable application state | Cloudflare D1 Free | Users, tasks, lists, contacts, sync state, pending operations, reminder state |
| Scheduled work | Cloudflare Cron Triggers | Due reminders, agendas, retries, synchronization maintenance |
| Language interpretation | Gemini API Free | Sanitized text-to-intent interpretation only |
| Calendar provider | Google Calendar API | Calendar events, task deadline projections, attendee notifications |

This is a deployment proposal. No infrastructure has been provisioned and no model accuracy or Worker CPU measurements have been completed.

### Cloudflare account capacity

The Cloudflare account also holds DNS for `xinweichong.com`. The owner confirmed on 2026-10-02 that the other application runs on Oracle Cloud and uses no Workers, D1, or Cron Triggers in this account, so the earlier even split is unnecessary. Keep the half-allowance figures as **operating targets** to leave headroom for retries, recovery, and later features:

| Resource | Documented account allowance | Operating target |
|---|---:|---:|
| Worker requests | 100,000/day | 50,000/day |
| D1 rows read | 5 million/day | 2.5 million/day |
| D1 rows written | 100,000/day | 50,000/day |
| D1 total storage | 5 GB | 2.5 GB aggregate |

Additional constraints:

- D1 Free has a **500 MB limit per database**. The aggregate storage figure does not increase this limit.
- Workers Free has a **10ms CPU limit per invocation**. Benchmark parsing, validation, recurrence processing, and scheduled batches against it.
- The documented account Cron Trigger limit is five; this application uses one scheduled handler.
- Operate below the targets and account for retries, synchronization, reminder processing, indexes, and operational telemetry. Recheck account usage if another application is added to the account.
- Gemini replaces Workers AI in the proposed design, so this application's language interpretation does not consume the Cloudflare Workers AI allowance.
- Stay on free plans; do not enable automatic paid overflow. If a dependency no longer offers a suitable free option, suspend the affected capability and explain the limitation.

### Synchronization mechanism

Proposed approach: Google incremental synchronization, with change notifications where practical and scheduled reconciliation as a fallback. The visible Force poll action always requests a read from Google.

The exact polling interval, notification-channel renewal strategy, and freshness target remain engineering validation items. Avoid promising instant synchronization before measuring the design within the shared budget.

## 11. Proposed data model and integrity requirements

| Record | Essential information |
|---|---|
| User | Telegram user ID, timezone, access status, settings |
| Google connection | Account identity, protected tokens, authorization state |
| Calendar selection | Provider calendar ID, permissions, selected/default/task-calendar roles |
| Task list | User, stable ID, name; one Inbox per user |
| Task / occurrence | User, list, title, optional due date/time and timezone, status, recurrence identity, calendar mapping |
| Event link | Calendar/event IDs, series/occurrence identity, relevant provider version and reminder settings |
| Reminder | Target occurrence, trigger time, snooze state, delivery/attempt state |
| Contact shortcut | User-scoped name or alias and email address |
| Pending operation | Intended change, target/version, confirmation snapshot, state, retry metadata |
| Sync state | Calendar cursor, last success, failures, outage/recovery notification state |
| Interaction context | Replied-to item references, last discussed item, pending clarification or confirmation |

All records and lookups must be scoped to the owning user. Calendar titles and list annotations are display conventions, not stable identifiers. Secrets must not appear in logs or AI prompts. Keep operational logging and retained conversation context minimal.

Use stable occurrence identities so completion, snoozing, cancellation, and reminders remain independent across a recurring series. Avoid creating an unbounded number of future task occurrences; choose a bounded expansion strategy during implementation.

## 12. Acceptance scenarios

| Scenario | Required result |
|---|---|
| `Dinner Friday at 7pm` | One event in the default calendar, 7–8pm; explicit result and Undo; one-hour reminder |
| `Call Alex tomorrow at 3pm` | Event by default |
| `Remind me to buy milk tomorrow` | Task due tomorrow, deadline on the task calendar, included in the 8am agenda |
| `Buy milk` | Open-ended Inbox task; no calendar entry |
| Task due tomorrow at 3pm | Calendar deadline preserving 3pm, 8am agenda inclusion, and a 2pm reminder |
| Snooze an overdue task until Monday | Deadline unchanged; excluded from overdue summaries until snooze expires |
| Complete a task through Telegram | Calendar entry remains with `✓`; reminders stop |
| Add/remove `✓` in Calendar | Matching task completes/reopens in Telegram |
| Delete one task occurrence in Calendar | Only that occurrence is cancelled; its reminders stop |
| Prior recurring task still unfinished | Next occurrence is independent; prior one remains overdue |
| Create an overlapping event | Event created and overlap clearly flagged; task markers excluded from conflicts |
| Invite a saved contact | Full email and invitation preview shown before any attendee notification |
| Reply `Move it to 4pm` to an item | Correct item targeted; normal confirmation rules still apply |
| Multiple instructions in one message | No partial execution; request separate messages |
| `/weekly` or `/monthly` | Current calendar period with navigation; no AI dependency |
| Gemini quota exhausted or request unsafe to sanitize | Structured fallback offered; no private content sent and no paid fallback |
| Google temporarily unavailable | Request visibly pending, retried, and later confirmed or flagged for resolution |
| Three consecutive failed sync checks | One outage alert; one recovery alert after success |
| Revoked Google access | Immediate reconnect alert with Reauthorize action |
| Force poll pressed repeatedly | Work coalesced or cooldown shown; no uncontrolled polling burst |
| Pending edit conflicts with an external edit | User chooses conflicting value; no silent overwrite |
| Duplicate Telegram delivery or calendar-write retry | No duplicate task/event creation or repeated mutation |
| Bot recovers after missed reminders | One relevant catch-up summary; stale event alerts skipped |
| Two users use the bot | No shared context, task data, contacts, tokens, or calendar results |

## 13. Validation required before release

These are implementation tasks, not requests to reopen the agreed product scope:

1. **Gemini feasibility:** verify free-model availability, account quota, sanitized-intent accuracy, and structured fallback. Review data terms before transmitting any real content.
2. **Shared Cloudflare capacity:** inspect the other application's configuration/usage, validate budgets, and measure CPU and database consumption with representative recurrence and reminder workloads.
3. **Calendar deadline display:** validate all-day and exact-time task markers in Google Calendar and the user's calendar viewer. Ensure deadline entries do not mark the user busy. If a provider requires a display duration, preserve the true deadline independently and verify the display does not imply reserved work time.
4. **OAuth:** choose the least privileges needed for agreed features, implement safe account linking/token storage, and configure ongoing access. An external Google OAuth application left in Testing can receive seven-day refresh tokens for Calendar scopes.
5. **Recurrence:** validate occurrence IDs, exceptions, series changes, and date behavior for month-end dates and leap years. Follow documented calendar recurrence semantics and display the interpreted schedule rather than silently clamping invalid dates.
6. **Synchronization:** validate deletion detection, reconnects, invalid cursors, simultaneous edits, task-marker parsing, and prevention of update loops. Loss of calendar access must not be treated as deletion of every task.
7. **Delivery:** validate retry and deduplication behavior, late-created events/deadlines, coincident reminders, and recovery after interrupted sends. Proposed default for an item created inside its one-hour reminder window: show it is approaching without duplicating the creation confirmation.
8. **Telegram usability:** validate compact/paginated agendas, callback limits, stale buttons, confirmation expiration, task-list controls, and structured command flows.
9. **Recovery and retention:** choose bounded history/context retention, a practical restore path, and task-list deletion behavior. Proposed list deletion behavior is to preserve tasks by moving them to Inbox after confirmation.
10. **Naming and deployment identity:** verify an available Telegram bot username and service identifiers. The agreed display name remains Oh My Days; name availability has not been checked.

## 14. Suggested implementation sequence

This sequence organizes delivery of the agreed scope; it does not remove later items from the first-version specification.

1. Private bot access, Google connection, calendar picker, timezone setting, D1 records, and `/health`.
2. Structured event/task creation and management, list support, deadline projections, and bidirectional sync.
3. Reminder scheduler, daily agenda, snoozing, command views, recurrence, and recovery handling.
4. Invitations, confirmation/Undo rules, conflicts, pending operations, and failure alerts.
5. Gemini sanitization and intent interpretation using the same validated operations as structured commands.
6. End-to-end acceptance scenarios, quota/CPU verification, and private release.

## 15. Research references

Consulted during the design session on 2026-09-16. Provider limits, model availability, and policies must be verified again when implementing and deploying.

- [Google Calendar: creating events](https://developers.google.com/workspace/calendar/api/guides/create-events)
- [Google Calendar: incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)
- [Google Calendar: change notifications](https://developers.google.com/workspace/calendar/api/guides/push)
- [Google Calendar: usage limits](https://developers.google.com/workspace/calendar/api/guides/quota)
- [Google OAuth token behavior](https://developers.google.com/identity/protocols/oauth2)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini API data and service terms](https://ai.google.dev/gemini-api/terms)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
