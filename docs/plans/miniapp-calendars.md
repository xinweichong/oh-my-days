# Mini App: calendar management

Status: **approved by the owner 2026-11-16 (both slices, plus "Make it the
default" on creation in Telegram); released in 2.5.0 (2026-11-16). The
screen was checked in headless Chromium (light and dark), and then by the owner
inside Telegram after the deploy.** The spec's Mini App
exception now covers calendar management (see the spec's Out of scope list). The
[improvement plan](improvements.md) listed settings as "a later decision"; this
is that decision.

## Problem

Calendars are managed only in Telegram (`/settings`, `/calendars`): which
calendars appear in views and reminders, the default for new events, and the
task calendar. A person who lives in the Mini App must leave it to change any of
these, and cannot see which calendar an event is going to. Telegram's pickers
also stop at 24 calendars.

## Proposed scope

One **Calendars** screen, reached from Home, in two slices.

**Slice 1: view and choose (local writes only)**

| Element | Behaviour |
|---|---|
| List | Every listed calendar: name, access (owner, can edit, view only), and badges for Default and Task calendar |
| Show in views and reminders | A toggle per event calendar; at least one must stay on. Same rule as Telegram's `calendars_done` |
| Default for new events | Pick one writable event calendar. View-only calendars and the task calendar are not offered |
| Task calendar | Shown, read-only. Changing or recreating it stays in Telegram |
| Sync state | Last synced time per calendar, and a **Sync now** that reuses the coalesced force-poll (cooldown unchanged) |

These change only the application's own records (`calendars.selected`,
`users.default_calendar_id`). There is no Google write, so no outbox operation,
confirmation or unknown-outcome handling is needed.

**Slice 2: create a calendar (Google write)**

A **New calendar** button asks for a name and creates it through the existing
`CreateCalendarIntent` operation, with the same durable outcome and reconcile
rules as Telegram. Result is shown only once Google confirms. Offer "Make it the
default" as a choice rather than forcing it, which also fixes Telegram's
create-only-as-default limit if the same option is added there.

## Out of scope

- Renaming, deleting, hiding, or changing sharing of calendars; these belong to
  Google Calendar and carry attendee and data-loss risks. Link out to Google.
- Creating events in the Mini App; the screen only shows where events will go.
- Connecting, switching or disconnecting the Google account (stays in Telegram).
- Per-calendar reminder defaults and colours.

## Design

- **API.** `GET /app/api/calendars` returns the list above. `POST` writes under
  the existing sign-in (`initData`) and per-user scoping:
  `calendars/select` (`{calendarId, selected}`), `calendars/default`
  (`{calendarId}`), and, in slice 2, `calendars/create` (`{name, makeDefault}`).
  Every lookup is by `user_id`; add a cross-user test for each.
- **One set of operations.** Selection, default choice and creation move out of
  `setup.ts`'s callback handlers into application functions that both Telegram
  and the Mini App call, as AGENTS.md requires. Telegram behaviour must not
  change; its existing tests are the regression check.
- **Validation.** The server re-checks every id against the user's listed
  calendars: writable for the default, not the task calendar, and the
  last-selected rule. The client's view is never trusted.
- **Selection side effects.** Unselecting a calendar must not cancel or hide
  anything inferred from access loss; it only changes views, overlap checks and
  reminders, exactly as in Telegram today. Re-selecting resumes syncing.
- **Mini App contract.** Mirror the Telegram copy: "Default for new events",
  "Task deadlines". Use the existing list rows, toggles and 44px targets; no new
  component family. Needs a screenshot refresh.

## Cost and risk

- Reads come from D1 already synced; slice 1 adds one read per screen open and
  one statement per change. Well inside ADR 0009's per-invocation budget.
- Slice 2 adds one Google call per creation, already counted by `RunBudget`.
- Largest risk is drift between the two surfaces; the shared-operations step
  removes it. Smallest viable first release is slice 1.

## Acceptance

1. Toggling, default choice and creation in the Mini App match Telegram for the
   same inputs (shared tests run against both entry points).
2. A view-only or task calendar cannot be made the default; the last selected
   calendar cannot be unselected; another user's calendar id is refused.
3. A creation whose Google outcome is unknown shows as pending and reconciles,
   never as done.
4. Unselecting then re-selecting a calendar changes nothing in the user's tasks
   or events.

## Decisions (2026-11-16)

1. Build slice 1 and slice 2.
2. Telegram's **Create a new calendar** also offers "Make it the default" as a
   choice, instead of always making the new calendar the default. This is part
   of the shared creation operation, delivered with slice 2.
3. Not decided: a Mini App counterpart to the guided `/event` calendar question.
   Event creation stays out of the Mini App.

## Delivery

Slice 1 first (shared operations extracted from `setup.ts`, then the API and
screen), then slice 2, each with its tests, screenshots and changelog entry.
