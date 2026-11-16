# ADR 0009: A per-invocation budget for D1 queries and outgoing calls

Status: Proposed (implemented on `feature/run-budget`, not yet deployed)
Date: 2026-10-22

## Context

Workers Free allows, per invocation, **50 D1 queries** and **50 subrequests**
(Google and Telegram calls). Cloudflare's D1 limits page says limits for
individual queries "apply to each individual statement contained within a batch
statement", so this ADR treats every statement in a `batch()` as one query.
Production can't confirm or rule this out: the owner's largest calendar has 32
synced events, so no batch there has exceeded 50 statements.

Before this change, the scheduled run bounded its work by item counts only. A
test-world measurement and code review found work that would exceed 50 queries
under that reading:

- **First sync of a normal calendar.** Pages of 250 events, one statement each,
  in one batch. A 120-event calendar took 127 statements in one run. A new user
  with a typical calendar would fail their first sync on every attempt, and
  their calendar would never sync.
- **A new daily repeating task.** Up to 31 occurrences, two statements each,
  in one batch: about 63.
- **Several people's agendas in the same minute.** One agenda pass is about 33
  queries, and the run processed up to 20 users.
- **Ordinary runs** use 14–28 queries before any of this, so stacked work could
  reach the limit unpredictably. One production run already failed partway
  (a D1 network error, not a limit), which showed the recovery path works.

A run that hits the limit throws. Its claims expire and the work is retried on
a later run, so nothing is lost. But a unit that can never fit, such as a big
sync page, fails on every attempt.

## Decision

- **Count everything.** `RunBudget` (`src/shared/run-budget.ts`) wraps the D1
  binding (counting each prepared statement, so a batch counts each one) and
  `fetch` (counting each Google and Telegram request, including failures).
  Each scheduled run, and the webhook's follow-up work, gets a fresh budget.
- **Check before each unit.** Each unit of work starts only if the budget covers
  its measured worst case (`UNIT_COSTS`), less a reserve of 3 queries and 1 call
  that lets the run record that it finished. Work that doesn't fit stays durable
  (inbox, operations, outbox, sync cursors, due times) and runs next minute.
- **Size variable work to what's left.**
  - Sync pages: 20 events for ordinary calendars, 6 for the task calendar
    (up to five statements per event). Up to 5 pages per run while they fit.
  - Series: occurrences per run are limited to what fits.
  - Horizon: when a user has more upcoming events than fit, it keeps the
    earliest; the rest enter as the window moves on.
  - Calendar list: a list longer than what's left waits, and is logged.
- **Priority order.**
  1. Replies to messages.
  2. Repeating-task occurrences, then agendas and reminders.
  3. Sending messages.
  4. Calendar writes, horizon refresh, and sync.
  5. Maintenance and cleanup.
  6. A second sending pass for anything queued by steps 4–5.

  The horizon refresh moves after reminders. Reminders use the horizon from its
  last refresh, at most 10 minutes old, and re-read each event before sending.
- **Visibility.** `tick.finished` logs `queries` and `calls` used, so
  `wrangler tail` shows how close each run comes to the limits.
- **Tests.** `tests/jobs/run-budget.test.ts` runs the scenarios above in the
  test world, plus everything due at once. Every run stays within 50 queries,
  and all the work completes on later runs.

## Alternatives considered

- **Multi-row inserts**, to cut statements per sync page. D1 caps bound
  parameters per statement (100), and the event upsert binds about 15 columns,
  so only about 6 rows fit per statement. That's more code for a smaller gain
  than smaller pages, and it can be added later.
- **Narrowing the first sync to recent events.** Google's sync tokens come from
  an unfiltered listing, so filtering the first listing risks breaking later
  incremental syncs.
- **Durable Objects or Queues**, for more work per invocation. More moving
  parts. The once-a-minute run with a budget handles a few users.
- **Paid Workers** (1,000 queries per invocation): ruled out by the spec.

## Consequences

- A user's first sync takes time instead of failing: about one page a minute
  beside other work, so a 1,000-event calendar takes roughly an hour. Their
  views read Google live in the meantime.
- **Bounded lateness.** When several people's agendas or reminders fall in the
  same minute, some go out a minute or a few minutes later. Never lost, never
  duplicated.
- **Webhook ordering.** The webhook's follow-up work now stops before the limit
  too. A heavy message still answers at once; calendar work waits for the next
  run as before.
- **CPU is not covered.** Workers can't measure CPU from inside a run. Live runs
  take 7–44 ms against a 10 ms limit that Cloudflare enforces only when exceeded
  "consistently"; none has been cut off (`docs/capacity.md`). Smaller sync
  pages also mean less JSON parsed per run. Watch for `exceededCpu` outcomes.
- The estimates in `UNIT_COSTS` must be raised if a unit grows. The load tests
  catch a run that goes over, not an estimate that is merely too low.
