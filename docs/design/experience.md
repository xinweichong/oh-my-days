# Oh My Days — experience brief

Status: Interview brief and connection-page layout approved. No interface implemented.

Date: 2026-09-25

## Job and boundaries

Help an allowlisted user capture a commitment, understand their day, and act on
reminders inside Telegram. Google Calendar remains the visual calendar interface.
Connection pages only handle authorization; calendar selection and settings stay
in Telegram. These are task-oriented surfaces (Operate mode), not marketing pages.

Follow the [product spec](../specs/oh-my-days.md), [backend plan](../plans/backend.md),
and [identity](../identity/oh-my-days.md). The interview confirms the interaction
choices below. Implementation details explicitly marked open remain proposals.

## Telegram entry and capture

Typing is the primary interaction. Commands and buttons provide guided input;
do not insert a menu after every exchange. Keep one instruction per message.

Ask only for missing details, using buttons when choices are known. Preserve the
rest of the request. Example: “Which Friday?” with fully dated choices. If natural
language processing is unavailable or unsafe, offer **Continue with guided input**.
Carry over only safely understood details; never guess targets or execute an
ambiguous partial instruction. Structured input uses the same backend operations.

## Creation confirmations

Show item type, title, complete interpreted date/time, calendar or list, reminder,
and **Undo** when valid. Example:

> Event added: Dinner
>
> Fri 25 Sep 2026, 7–8pm · Personal
>
> Reminder: 1 hour before
>
> [Undo]

Use the user's configured timezone and display it when ambiguity is possible.
Open-ended tasks explicitly say “No deadline.” For pending calendar changes, show
pending status instead of this success format. Undo remains subject to version and
notification confirmation rules in the spec.

## Daily agenda and task actions

Use a short introduction such as “Here's your day,” followed by the local date.
Order the content as follows and omit empty sections:

1. Today's events, in time order, with all-day events clearly labeled.
2. Tasks due today, with list and due time where applicable.
3. Overdue tasks, with list and deadline.
4. Count of tasks without deadlines.

Provide **View tasks** and **View week**. Large agendas remain compact and paginated;
the 8am message must not duplicate date-only reminders. Snoozed items follow the
backend's suppression rules. No name-based greeting or decorative emoji.

Select a task before showing **Done · Snooze · Edit**; do not repeat those controls
beneath every agenda entry. Individual task reminders show **Done · Snooze**
directly. The precise task-selection mechanism for a long agenda remains an
implementation detail; preserve an unambiguous occurrence-specific target.

Snooze choices: **In 1 hour · Tomorrow at 8am · Choose date/time**. Resolve shortcuts
in the user's timezone, then show the resulting date/time and unchanged deadline:

> I'll remind you on Sat 26 Sep at 8am.
>
> Deadline unchanged: Fri 25 Sep, 3pm.

## Pending changes and interruptions

During a temporary Calendar failure, send one pending notice and one eventual
result. Stay quiet during automatic retries. If input is required, explain the
problem and present the appropriate action. Outage/recovery alerts still follow
the spec's separate health rules; do not suppress authentication or safety notices.

> Pending: Dinner has not been added to Google Calendar. I'll retry automatically.

After verified success, send the normal event/task confirmation. A timeout with an
unknown outcome must use outcome-appropriate language; do not assert the operation
failed or that nothing was added. The backend's reconciliation rules control retries.

Deletion, whole-series edits, attendee notifications, external-edit conflicts,
expired buttons, and unavailable Undo follow the established specification. Do not
reopen those product policies merely to simplify the interface. Detailed copy and
visual states for these cases remain to be authored during implementation.

## Google connection pages

Use the application name and existing tagline with minimal page chrome. Show a
short access summary, a primary **Connect Google Calendar** action, and an
expandable **Access and data details** section. Approved content direction:

> Connect Google Calendar
>
> View events and create or update them in calendars you select. Task deadlines
> appear in “Tasks - Oh My Days.”
>
> [Connect Google Calendar]
>
> Access and data details

The summary describes application behavior. The details must explain that Google
may grant broader access than the calendars selected inside the bot. Final wording
must match the actual scopes, task calendar creation, token handling, and privacy
behavior established by the OAuth implementation. Do not claim scope restrictions
that Google does not enforce.

After verified authorization, show **✓ Google Calendar connected**, followed by
“Choose your calendars and finish setup in Telegram” and **Continue in Telegram**.
Wait for the button; do not return automatically. Use a narrow single-column layout
for both connection and result screens. Recovery states are specified in the
[connection-page implementation plan](../plans/connection-pages.md).

## Setup in Telegram

Guide the user through one choice at a time:

1. Select calendars to include.
2. Choose an existing writable default calendar, or create one as allowed by the spec.
3. Create or link **Tasks - Oh My Days**, verifying its identity.
4. Confirm **Asia/Singapore**, with an option to change the timezone.

Finish with a setup summary and **Add event · Add task · View today**. Respect
read-only permissions throughout. Connection pages do not contain these controls.

## Visual and implementation handoff

Confirmed web direction: plain light background, dark text, one restrained accent
for primary actions. No illustrations, gradients, or decorative animation. Native
Telegram styling remains intact. Logo design is deferred.

The user requested a written implementation plan instead of a prototype. Follow
the [connection-page plan](../plans/connection-pages.md) for layout, states, build
order, and acceptance checks. Exact visual tokens remain implementation details
within the approved minimal direction. No logo or separate calendar/task web app
is included. No image-first/code-first workflow preference was selected.
