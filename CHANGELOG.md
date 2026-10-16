# Changelog

All notable changes to this project are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`/import`**: up to eight tasks at once, one per line, written as you would one at a time (`Essay by Fri 23 Oct 11:59pm to CS2040S`). One preview lists each task with its deadline and list, and every skipped line with the reason; nothing is added until you confirm. A task you already have is skipped, so importing the same list twice adds nothing new. **Undo import** removes the batch after asking, keeping any task changed since

### Changed

- Right after a message, the bot now handles that one message and, if it was a heavy one, leaves calendar updates to the next minute's run, so a single request stays within the free plan's database query limit. Replies still go out at once

## [2.2.0] - 2026-10-16

A polished Mini App, in the landing page's finish.

### Changed

- **Mini App polish** to match the landing page ([ADR 0007](docs/adr/0007-mini-app-display-type-and-depth.md)): the mark beside Home's heading; a raised Next up card with a live countdown; Today, Overdue and This week tiles that show progress, the oldest overdue age and deadline days; overdue counts on lists; Figtree titles and figures and soft depth on floating layers, served from the app's own origin
- **Task screens**: Overdue folds recurring tasks under their series; lists group by Overdue, Today, Later and No deadline; task detail leads with the deadline and shows history as a timeline
- **Snooze** offers one-tap presets that show the time they mean, and a day and time picker in your own time zone
- README and landing page screenshots show the new design

### Added

- **All clear**: once a day, when everything today is behind you and nothing is overdue, with Back to Home
- **Launch screen** with the logo while the app opens

## [2.1.0] - 2026-10-15

A landing page, and a new production host.

### Added

- **Landing page** at `/`: the tagline made literal, with ten things in your head captured one message at a time, a scroll-driven walkthrough of an event, a task, the 8am agenda and a snooze in Telegram and Google Calendar, the Mini App, setup, and privacy. Separate desktop and phone compositions. Built with React, Tailwind CSS and Motion, with components adapted from Kokonut UI, beUI, Origin UI and Animate UI, prerendered and served as static assets ([ADR 0006](docs/adr/0006-landing-page-as-static-assets.md))

### Changed

- The Worker no longer serves the plain homepage at `/`; the landing page replaces it. Production moves to a new host, with the cutover steps in the deploy runbook

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
- Continuous integration: `npm run check` on every pull request and on pushes to `develop` and `main`
- Production values (host, database ID, bot username, contact address) are kept in an untracked file and merged in by `npm run deploy`

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

[Unreleased]: https://github.com/xinweichong/oh-my-days/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/xinweichong/oh-my-days/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/xinweichong/oh-my-days/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/xinweichong/oh-my-days/compare/v2.0.0-beta.1...v2.0.0
[2.0.0-beta.1]: https://github.com/xinweichong/oh-my-days/compare/v0.1.0-beta.1...v2.0.0-beta.1
[0.1.0-beta.1]: https://github.com/xinweichong/oh-my-days/releases/tag/v0.1.0-beta.1
