# Changelog

All notable changes to this project are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-14

The first stable release: the structured beta plus typed capture, more control
over the day, and a Telegram Mini App.

### Added

- **Quick capture**: a plain message becomes one event or task through the same operations as the commands. Unclear dates, am/pm, or task-versus-event get a question with buttons; several requests in one message are refused; unreadable text offers **Add as task · Add as event**. Results can switch type (**Make it a task**, **Make it an event**)
- **One date grammar** for typing, follow-ups, and snoozing: weekdays, `next`/`this <weekday>`, `in N days/weeks`, `next week`, `end of month`, time ranges such as `7-9pm`, and number-word durations
- **Mini App** (`/app`, and **Open app** under the agenda, `/daily`, and `/tasks`): Home with Next up and counts, Today, Week, Overdue, lists, Recent, and task detail. Complete, reopen, snooze, rename, move, change deadlines, and cancel with confirmation; swipe to snooze; multi-select with complete, snooze, move, and cancel; quick add. Signs in with Telegram's signed launch data ([ADR 0005](docs/adr/0005-mini-app-surface-and-initdata-auth.md))
- `/find` across tasks and events; pick any date when moving an event
- `/export` of tasks, lists, recurring tasks, and contacts as a file
- `/cancel`, and **Cancel** on every guided question
- Recurring tasks every N days, weeks, or months, on weekdays, or on the last day of the month
- Work time: book time to work on a task, separate from its deadline
- Settings for agenda time and default reminder lead, quiet hours that hold reminders and summarize them afterwards, and an optional evening preview of tomorrow
- Timezone buttons and city names
- Act on agenda tasks from the agenda; **Snooze all** for overdue tasks
- **Recent** completed and cancelled tasks, with Reopen and Restore
- Event reminders carry location, call link, and **Open in Calendar**
- Move a just-created event to another calendar; restore a deleted event without guests as a copy
- A warning the day before Google access ends while the OAuth app is in Testing
- `/healthz` reports scheduler liveness (`ok tick_age_s=N`, or 503 when stale)
- Repository banner, README screenshots, this changelog, and a licence

### Changed

- `/help` leads with typed examples; the first guided creations suggest the typed form
- A morning agenda still unsent at noon becomes a catch-up of the rest of the day, and is skipped from 8pm
- The reminder pass visits only users with something due ([ADR 0004](docs/adr/0004-next-due-time-by-trigger.md)), keeping CPU within the free tier

### Fixed

- Mini App sign-in now includes the `signature` field in the hash check, so launches from current Telegram clients are accepted
- Deleting a user's data also deletes their work sessions and Mini App request keys
- The persistent keyboard's **Open app** replies with a button that can sign in, since keyboard launches carry no sign-in data

## [2.0.0-beta.1] - 2026-10-04

The structured release: everything works through commands and buttons.

### Added

- Google Calendar connection with PKCE, encrypted tokens, calendar selection, default and task calendars, and timezone, guided in Telegram
- Events: add, rename, move, and delete from Telegram, with an overlap check and Undo
- Tasks and lists with two-way deadline markers in a dedicated calendar
- The 8am agenda, reminders before events and exact deadlines, snoozing that never moves a deadline, and `/daily`, `/weekly`, `/monthly`, `/calendars`, `/overdue`, `/reminders`
- Recurring tasks with independent occurrences, and recurring events with one-occurrence or whole-series changes
- Invitations by email or saved contact, with every guest-notifying change previewed and confirmed
- Follow-ups by reply (`move it to 4pm`, `rename it to …`, `delete it`, `done`) and same-field conflict choices
- Incremental sync of selected calendars, outage alerts, `/health`, and a privacy page
- Operations and deploy runbooks, capacity measurements, and restore and rollback drills

### Changed

- Tick work is staggered and limited to one heavy job per run, cutting median CPU from 10–22 ms to 8 ms

## [0.1.0-beta.1] - 2026-10-02

### Added

- Worker foundation: webhook secret, allowlist, private chats only, a durable deduplicated inbox, per-user processing, and an outbox that treats a lost response as unknown
- Durable operations with confirmations bound to the previewed change, and Undo
- Product specification, backend plan, identity, and experience brief

[2.0.0]: https://github.com/xinweichong/oh-my-days/compare/v2.0.0-beta.1...v2.0.0
[2.0.0-beta.1]: https://github.com/xinweichong/oh-my-days/compare/v0.1.0-beta.1...v2.0.0-beta.1
[0.1.0-beta.1]: https://github.com/xinweichong/oh-my-days/releases/tag/v0.1.0-beta.1
