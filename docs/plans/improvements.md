# Oh My Days — post-release improvement plan

Status: Every item approved by the owner (D7 on 2026-10-08, its layout and all
other items on 2026-10-09). Build order: Phases 1–4, then the Mini App (Phase 5)
last. Implementation status is in the Status column below; "Implemented" means
tested locally, not deployed.
Source of truth: [product specification](../specs/oh-my-days.md). Builds on the
[backend plan](backend.md), whose stages 0–8 and 10 are implemented and deployed.

## 1. Why

The structured release works, but the main interaction the spec and the
[experience brief](../design/experience.md) describe, typing a request, does
not work yet. Any text that is not a command or one of four follow-up phrases
gets "That isn't available yet" (`src/telegram/router.ts`). Creating an event
takes five steps, typed dates reject weekdays, and the follow-up phrases are
never mentioned to the user. Separately, Testing-mode OAuth disconnects Google
weekly with no warning, and CPU headroom is thin.

This plan fixes the capture path without AI, closes reliability gaps, makes
chat views actionable, and adds a Telegram Mini App for tasks and a day/week
overview. Natural-language interpretation through Gemini (backend stage 9)
stays deferred and unchanged in scope.

## 2. Items and approval

**Spec** marks a change to an agreed spec decision; the spec is updated
when the item is approved, before implementation.

| ID | Item | Phase | Spec | Status |
|---|---|---|---|---|
| A1 | Deterministic quick capture for free text | 1 | Extends §4 (no AI); spec amended | Implemented (`feature/quick-capture`) |
| A2 | Weekday and relative dates | 1 | — | Implemented (`feature/date-grammar`) |
| A3 | Examples and hints in `/help` | 1 | — | Implemented (`feature/help-examples`) |
| A4 | Cancel on guided prompts, `/cancel` | 1 | — | Implemented (`feature/guided-cancel`) |
| B1 | Warn before Google access expires | 2 | — | Implemented (`feature/expiry-warning`); live check at one Testing expiry pending |
| B2 | Google OAuth verification (owner action) | any | — | Approved (owner action) |
| B3 | Scheduler liveness in `/healthz` | 2 | — | Implemented (`feature/scheduler-liveness`) |
| B4 | Cheaper idle ticks (CPU and D1 reads) | 2 | — | Implemented (`feature/idle-ticks`); live 24 h re-measure pending deploy |
| B5 | Late-agenda cutoff | 2 | Clarifies §8 catch-up; spec amended | Implemented (`feature/late-agenda`) |
| C1 | Actionable agenda; snooze all overdue | 3 | — | Approved |
| C2 | Location, call link, Calendar link in event reminders | 3 | — | Approved |
| C3 | `/find` and date jump for events | 3 | — | Approved |
| C4 | Choose the calendar for a new event | 3 | — | Approved |
| C5 | Recent completed/cancelled tasks with Reopen/Restore | 3 | — | Approved |
| C6 | Restore a deleted guest-free event | 3 | — | Approved |
| C7 | Timezone buttons and city names | 3 | — | Approved |
| D1 | Configurable agenda time and default reminder lead | 4 | Changes fixed defaults | Approved |
| D2 | Optional evening preview of tomorrow | 4 | New | Approved |
| D3 | More repeat rules | 4 | Extends §6 | Approved |
| D4 | Schedule a work session for a task | 4 | Already in §6, unbuilt | Approved |
| D5 | Quiet hours | 4 | New | Approved |
| D6 | `/export` of tasks, lists, contacts | 4 | New | Approved |
| D7 | Telegram Mini App: tasks and day/week overview | 5 (last) | §2 exclusion amended | Approved |

Build the phases in order, 1 to 5; the Mini App is last because it reuses quick
capture, date parsing, history, and the other chat operations. Within a phase,
items are independent branches unless stated. For items marked in the Spec
column, amend the spec in the same branch before implementing.

## 3. Phase 1 — Typing works (A2 → A1, A3, A4)

### A2. Weekday and relative dates

Extend `parseLocalDate` (`src/domain/parse-input.ts`) and keep it the single
date grammar for guided input, follow-ups, quick capture, and the Mini App.

| Input | Result |
|---|---|
| `mon` … `sunday` | Next occurrence after today. When it is today's weekday, ask: **Today, Fri 9 Oct · Fri 16 Oct** |
| `next fri` | The interpretation differs between people; when it differs from bare `fri`, ask with both dated choices (the brief's "Which Friday?") |
| `this fri` | The occurrence in the current Monday–Sunday week; refused if already past |
| `in 3 days`, `in 2 weeks` | Date arithmetic in the user's zone |
| `next week` | Monday of next week, shown explicitly |
| `end of month`, `eom` | Last day of the current month |

Ambiguity returns a typed "choose one of" result rather than null, so callers
render buttons. Time grammar gains ranges (`7-9pm`, `19:00–21:00`, `7pm to 9pm`);
a bare hour (`at 3`) is still refused, with "3am or 3pm?" buttons.

Tests: every form against a fixed clock, today-is-that-weekday, month and year
boundaries, Monday-start weeks, DST dates, and that existing accepted forms
are unchanged. Follow-up `move it to Friday` and the spec's `make that Friday`
then work through the existing grammar (add `make that`/`make it` as move verbs).

### A1. Deterministic quick capture

A new pure domain module `src/domain/capture.ts` turns one message into a
capture proposal, with no network calls. Application code (`src/application/
capture-flow.ts`) resolves lists/calendars and calls the **existing** create
operations, so results, pending notices, Undo, and conflicts behave as today.

Recognition, in order:

1. **Multiple instructions** (two or more date/time expressions joined by `,`,
   `;`, ` and `, or line breaks): reply that each request needs its own message;
   nothing is created. Closes acceptance row 14.
2. **Task signals**: leading `task`, `todo`, `remind me to`, or `by`/`due` before
   a date → task. A date without a time and with task signals → date-only
   deadline; with a time → exact deadline.
3. **Event signals**: a time or time range with no task signal → event (spec
   §4: a timed activity is normally an event). Duration from a range or
   `for 2 hours`, else the one-hour default.
4. **No date or time** → open-ended Inbox task (`Buy milk`).
5. **Date, no time, no signal** (`Dentist Friday`) → materially ambiguous: ask
   **Task due Fri 9 Oct · All-day event Fri 9 Oct**.
6. Optional attributes, matched only against existing names, case-insensitive
   and whole-word: `on <calendar>` (writable calendars), `to <list>`/`in <list>`
   (existing lists). An unmatched phrase stays in the title; nothing is created
   by inference (`Send report to Alex` keeps "to Alex").

The title is the remaining text with recognized tokens removed; an empty title
is refused. A clear result executes immediately with the spec's result message,
Undo, and one extra button: **Make it a task** / **Make it an event**, which is a
version-bound Undo followed by the other creation. Unrecognized or unsafe text
(over 200 characters, only symbols, a forwarded message with several lines)
gets **Add as task "…" · Add as event · Cancel** instead of the current dead end.

Boundaries: quick capture only creates. It never edits, deletes, or targets an
existing item; that stays with the follow-up grammar and its confirmation rules.
Text arriving while a guided prompt is open still goes to that prompt (A4 adds
the way out). Created items become the "last discussed" item for follow-ups.

Privacy: all parsing is local; no message content leaves the Worker. This is
also the local template step backend stage 9 needs, so it is reused there.

Tests: a table of synthetic phrases (event, task, open-ended, ambiguous,
multi-instruction, attribute matches and non-matches, Unicode, long input);
flow tests through the fake Telegram/Google showing one creation per message,
redelivery idempotency, Undo and switch-type version binding, and cross-user
list/calendar names never matching. Acceptance rows 1–3 gain "template forms ✓".

### A3. Help that shows what to type

`/help` leads with 4–6 synthetic examples (`Dinner Fri 7pm`, `Buy milk`,
`Pay rent by 1 Nov`, reply `move it to 4pm`, `done`), then commands. After each
of the first three guided creations, add one line: "Next time you can type:
Dinner Fri 7pm". Count stored per user; no repeated hints after that.

### A4. A way out of guided prompts

Every guided prompt gets a **Cancel** button; `/cancel` clears any pending
input and says what was abandoned. Add `cancel` to the command menu.

**Phase 1 exit:** typing the spec's example phrases creates the right item in
one message; acceptance matrix rows 1, 2, 3, 13, 14 updated with evidence.

## 4. Phase 2 — Reliability (B1, B3, B4, B5; B2 in parallel)

### B1. Warn before Google access expires

While the OAuth app is in Testing, refresh tokens last seven days from consent.
`google_connections.connected_at` is reset on each reconnect, so expiry is
estimated as `connected_at + 7 days`. Add `TESTING_TOKEN_TTL_DAYS` (unset once
verified). A maintenance job sends one message ~24 hours before, keyed by
`auth_generation`: "Google access ends tomorrow around 3pm. Reconnect now to
avoid a gap. [Reconnect]". `/health` shows "Reconnect by …". Existing
after-the-fact alerts stay. Tests: one warning per generation, none after
reconnect, none when the setting is unset.

### B2. OAuth verification (owner)

The homepage, privacy policy, domain, and narrow scopes from
[ADR 0002](../adr/0002-custom-domain-and-oauth-verification.md) are in place.
Remaining: demo video and per-scope justifications. Claude can draft the
justification text; submission is the owner's action. When approved, unset
`TESTING_TOKEN_TTL_DAYS` and update ADR 0002.

### B3. Scheduler liveness

Record `last_tick_at` in app state at the end of each tick (one write per
minute, about 1,440 rows/day; within budget, or every 5th tick if measured
otherwise). `/healthz` returns `ok` plus `tick_age_s`, and status 503 when the
last tick is older than 10 minutes. No user data. Optionally the owner points a
free external uptime monitor at it; that is a new free dependency and needs
separate approval. `/health` in Telegram shows the same figure.

### B4. Cheaper idle ticks

Measured median 8 ms of the 10 ms CPU limit, 11–14 ms after deploys, and
~416k D1 rows read/day for one user. Add a per-user `next_due_at` (earliest
reminder, agenda, snooze, or horizon refresh), maintained when tasks,
overrides, horizons, or settings change. The reminder pass loads only users
with `next_due_at <= now`. Re-measure CPU and rows read for 24 hours and record
in [capacity](../capacity.md). Required before adding a second user.
Tests: no missed reminder when `next_due_at` is stale-early; recomputation on
every change path; concurrent ticks.

### B5. Late agenda cutoff

An agenda not sent by 12:00 local is sent as "Catch-up: today so far" with only
remaining events and still-relevant tasks; after 20:00 it is skipped and the
date recorded as covered. Setup completed after 08:00 sends no agenda that day.
Clarifies spec §8 "Missed reminders"; updated there on approval.

**Phase 2 exit:** B1 observed live at one Testing expiry; capacity re-measured
with B4; `/healthz` liveness verified with a paused cron in local tests.

## 5. Phase 3 — Chat that does more (C1–C7)

- **C1 Actionable agenda.** Add **Act on a task** to the agenda and `/daily`:
  a picker of today's due and overdue occurrences, each opening
  **Done · Snooze · Edit** (the brief's select-then-act pattern). Add
  **Snooze all overdue → tomorrow 8am**: one confirmation listing the count,
  never moves deadlines, per-occurrence snooze records, one Undo.
- **C2 Better event reminders.** Read `location`, the conference/video link,
  and `htmlLink` from Google into a display-only structure kept **outside**
  `EventFields`, so conflict detection and patches are unaffected. Event
  reminders show them and an **Open in Calendar** URL button. Location and
  links stay in Telegram and D1 only; the event cache retention rules apply.
- **C3 Find.** `/find <words>` searches open tasks and synced one-off events
  for the user (case-insensitive substring, max 20 results, paged), plus a live
  Google `q` search for recurring events when reachable. "Change an event" gains
  **Pick a date** beyond the 14-day list.
- **C4 Calendar choice.** Event results show **Calendar: Personal ▸** to move a
  just-created event to another writable calendar (Google `move`), bound to the
  created version; A1 also accepts `on <calendar>`.
- **C5 History.** `/tasks` gains a **Recent** filter: completed and cancelled
  in the last 30 days with **Reopen**/**Restore**, using existing operations.
- **C6 Restore deleted event.** After deleting an event without guests, offer
  **Restore** for 24 hours: recreates it from the stored snapshot with a new ID
  in the same calendar, stating that it is a copy. Guest events stay
  unrestorable (it would notify again). Recurring series excluded.
- **C7 Timezone.** Buttons for recent zones and a short common list; typed
  input also accepts unambiguous city names from the runtime's IANA list
  (`London` → `Europe/London`); ambiguous names get choices.

Each C item is its own branch with flow tests, including cross-user refusal
and stale-button cases.

## 6. Phase 4 — Further features (D1–D6)

- **D1** Settings for agenda hour and default event/timed-task reminder lead;
  defaults stay 8am and 1 hour. Requires amending the spec's fixed values.
  Agenda keys remain per local date, so changing the hour cannot send twice.
- **D2** Evening preview: off by default; a short "Tomorrow" message at a chosen
  time, same rendering as the agenda.
- **D3** Repeat rules: every N days/weeks/months, weekdays only, last day of the
  month (RFC 5545 `BYSETPOS=-1`). Same materialization (ADR 0003).
- **D4** Work sessions: "Schedule time" on a task creates an ordinary event in
  the default calendar linked to the task; deadline untouched; completing the
  task does not delete the event.
- **D5** Quiet hours: reminders falling in the window are held and sent once as
  a summary afterwards; agenda unaffected.
- **D6** `/export`: a JSON document of the user's tasks, lists, series, and
  contacts sent as a Telegram file; no tokens or event cache.

## 7. Phase 5 — Telegram Mini App (D7, built last)

A Mini App is a web page that Telegram opens inside the chat. It gives a
Reminders-style task manager and a read-only day/week overview, using the same
backend operations as chat. It replaces nothing: chat, reminders, and the
agenda continue unchanged; Google Calendar remains the calendar interface.

### Scope

| Screen | Content | Actions |
|---|---|---|
| Today (start screen) | All-day events, timed events in order, due and overdue tasks, open-ended count | Check off, snooze, open task; events read-only, tap opens Google Calendar |
| Week | Monday–Sunday, compact list per day; previous/next | Same as Today |
| Tasks | List tabs; sections Overdue, Today, Upcoming, No deadline | Check off, quick add (A1 grammar), swipe/long-press: snooze, move, cancel |
| Task detail | Title, deadline, list, reminder override, repeat rule, history | Rename, change/remove deadline, move, cancel/restore, series actions |
| Bulk | Multi-select in Tasks | Move, snooze, complete; cancel requires confirmation |
| Recent | Completed and cancelled, 30 days | Reopen, restore |

Out of scope: event creation and editing, time or month grids,
drag-to-reschedule, offline use, widgets, notifications from the app,
settings (a later decision).

### Architecture

- **Serving.** The Worker serves `/app` (one HTML document with inline CSS and
  a small vanilla-TypeScript bundle built by the existing toolchain; no
  framework unless the design phase shows a clear need) and a JSON API under
  `/app/api/`. Strict CSP like the existing pages, plus Telegram's script.
- **Authentication.** Every API request carries Telegram `initData` in a
  header. The Worker verifies the HMAC (secret derived from the bot token as
  Telegram documents), rejects `auth_date` older than 1 hour, maps the Telegram
  user ID through the existing allowlist to a user, and refuses users whose
  setup is incomplete. No cookies, sessions, or new OAuth. Requests without
  valid `initData` get 401 and no data.
- **Reads.** `GET /app/api/today`, `/week?start=`, `/tasks?list=&section=`,
  `/tasks/:id`, `/recent`. All queries user-scoped. Events come from a live
  Google read with fallback to the synced copy, labelled in the UI, as `/weekly`
  does now (recurring occurrences are not in the cache).
- **Writes.** `POST /app/api/tasks/...` maps one-to-one to existing task
  operations. Each request carries the task `version` and a client-generated
  idempotency key; a version mismatch returns 409 with the current task so the
  UI refreshes instead of overwriting. Confirmation-required actions (cancel,
  series stop, bulk cancel) use a two-step preview/confirm bound to a preview
  hash, as chat does. Pending Google projections are shown as pending.
- **Entry points.** The chat Menu button stays the command list. The app opens
  from a persistent keyboard button, the bot's main Mini App (BotFather), and
  inline `web_app` buttons on `/tasks`, the agenda, and `/daily` (decided
  2026-10-09). Full-screen and add-to-home-screen
  support is used where the client supports it; versions are checked first.
- **Theme.** Telegram theme parameters drive colours, so light/dark follow the
  client; identity rules (no decorative emoji, explicit labels, status never by
  colour alone) apply.
- **Budget.** Each open is ~2–4 Worker requests and bounded D1 reads; live
  Google reads are limited to the visible range. Measured and added to
  [capacity](../capacity.md) before release.
- **ADR 0005** records the Mini App surface, `initData` authentication, and
  API conventions when step 5a starts.

### Delivery

| Step | Content | Exit evidence |
|---|---|---|
| 5.0 Design | Experience brief section and copy for the screens; layout explored with the owner (frontend design was reserved for a separate discussion) | **Done 2026-10-09:** smart lists home approved; see the [experience brief](../design/experience.md#telegram-mini-app) |
| 5a Foundation | `initData` verification, `/app` shell, read API, Today and Week | Auth tests (bad hash, stale, other bot, non-allowlisted, cross-user IDs); views match `/daily` and `/weekly` output for the same fixtures |
| 5b Tasks | Tasks screen, detail, check-off, snooze, quick add, move, rename, deadline | Every action matches the chat operation's result, Undo, and projection; 409 on stale version; redelivered POST idempotent |
| 5c Bulk and history | Multi-select actions, Recent | Bulk operations atomic per item with one summary; confirmation bound to the exact set |
| 5d Release | Live smoke test on the owner's phone (iOS/Android as available), capacity check, docs | Acceptance rows added; runbook updated |

Depends on A1/A2 (quick add and date parsing) and C5 (history operations).


## 8. Cross-cutting rules

All AGENTS.md rules apply. In particular, each item:

- Uses the existing operation pipeline; no new path mutates Google or tasks.
- Scopes every new query, button payload, and API route to the user, with an
  explicit cross-user test.
- Uses injected clocks and IDs; covers timezone, DST, retry, and redelivery.
- Keeps message content and personal data out of logs and Gemini.
- Updates this table's status, the [acceptance matrix](../acceptance.md), and
  the spec where marked, in the same branch.
- Records capacity impact for anything that runs on the tick or adds requests.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Quick capture misreads intent | Only creates, always shows the interpretation with Undo and a type switch; ambiguous cases ask |
| A1 grammar grows unmaintainable | Pure module with a phrase table test; new forms added only with tests |
| CPU limit exceeded as features grow | B4 before new tick work; measure after each phase |
| Mini App API widens attack surface | `initData` HMAC + freshness, allowlist, user-scoped queries, version checks, CSP; no session state |
| Mini App and chat diverge | Both call the same application operations; flow tests compare results |
| Testing-mode weekly expiry persists | B1 warning; B2 verification |
