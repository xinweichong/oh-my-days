# Capacity and free-tier measurements

Measured 2026-10-04 on the deployed Worker with one user (the owner), three
synced calendars, and the minute cron. Sources: `wrangler tail` (`cpuTime`),
`wrangler d1 info`, and the [operating targets](specs/oh-my-days.md#cloudflare-account-capacity).

## Worker CPU (Workers Free: 10 ms per invocation)

| Change | Minute runs | CPU per run |
|---|---|---|
| Before tuning | 6 | 10–22 ms (every run at or above the limit) |
| Periodic work staggered, reminder queries trimmed | 10 | 5–7 ms most runs; 14–22 ms with maintenance; 10–15 ms with syncs |
| At most one heavy job per run (one calendar sync, maintenance, or cleanup) | 12 | idle 5 ms; sync 7–8 ms; maintenance 7 ms; median 8 ms. The first two runs after a deploy took 11–14 ms (warm-up) |
| 2.4.0, live (2026-10-21, about 53 minutes) | 53 | median 13 ms, mean 14.5 ms, range 7–31 ms; 12 of 53 at or under 10 ms, 7 over 20 ms. Outcomes not yet captured |

**2026-10-21: CPU has risen since the tuning** and most runs are over the
Workers Free limit; several releases came in between, so the cause is not yet
known. Before adding users, capture outcomes (`exceededCpu`) and the
`tick.finished` summary per run, find the costly step, and fix it.

On 2026-10-04 all runs completed (`outcome: ok`). Wall time is 3–7 seconds, dominated by D1
round trips; scheduled invocations are not limited by wall time.

Worker size since the first measurement, from `wrangler deploy --dry-run`:
348 KiB (2026-10-04) → 557 KiB (2.0.0) → 622 KiB (2.3.0) → 663 KiB (2.4.0), all
our own code; no large dependencies. Each fresh isolate parses the whole bundle,
and that counts toward a run's CPU time, which fits idle runs roughly doubling
(5 ms → 8–16 ms). From 2.4.1 (2026-10-21) the bundle is minified (`minify` in
`wrangler.jsonc`, 425 KiB), with source maps uploaded. **This did not lower CPU**
(2026-10-22, 55 runs): idle median 11 ms (7–24), sync median 23 ms (11–38),
maintenance median 22.5 ms (14–44). Bundle size is not the main cost, so
serving the Mini App script and font as assets is not expected to help either.
No run in about two hours of captures was cut off for CPU (`exceededCpu`); runs
of 30–44 ms finished `ok`, so the 10 ms limit is not applied per run. One run
ended in `exception` (2026-10-21 13:33 UTC): a transient
`D1_ERROR: Network connection lost.` while claiming a delivery, not CPU and not
a code fault; the outbox kept the message and a later run sent it (a claim
whose reply is lost expires and is recovered). Each run syncs at most one calendar
whatever the number of users, so more users mainly means more runs that sync,
not heavier ones. Watch outcomes after each new user.

Design rules that keep CPU down (`src/jobs/tick.ts`): one calendar sync per run;
frequent maintenance (calendar lists, sync health, menu, confirmation expiry)
every 5 minutes and cleanup every 30 minutes, run on ticks without a sync unless
overdue by twice their interval; reminders load only tasks that could be due.

Residual risk: a run that syncs a calendar with many changed events parses more
JSON; pages are 250 events and at most 3 pages per run. If `cpuTime` exceeds the
limit regularly, lower `EVENT_PAGE_SIZE` or `MAX_PAGES_PER_RUN`.

## D1 (Workers Free daily allowances)

| Metric | 2026-10-04, before tuning | 2026-10-21, 2.4.0 | Operating target | Allowance |
|---|---:|---:|---:|---:|
| Rows read | 416,421 | 83,719 | 2,500,000 | 5,000,000 |
| Rows written | 5,218 | 4,917 | 50,000 | 100,000 |
| Read / write queries | — | 17,424 / 3,725 | — | — |
| Database size | 0.4 MB | 0.67 MB | 2.5 GB aggregate | 500 MB per database |

The 2026-10-21 figures are `wrangler d1 info` at about 11:10 UTC: one user (the
owner), the last 24 hours, about 21 of them on 2.4.0 (deployed 2026-10-20 13:51
UTC). Rows read fell about 80% since the first measurement, after the CPU tuning
and the idle reminder pass (B4). They are 3% of the operating target and 1.7% of
the allowance; rows written are 10% of the target. If usage grows in proportion
to users, five such users would read about 420,000 rows and write about 25,000
a day, within the targets. That is a rough projection: calendars, messages,
and Mini App use vary per person.

Reads come mostly from the minute cron. Recheck with `npx wrangler d1 info
oh-my-days --config wrangler.production.jsonc` after 24 hours, and before adding users: reads grow roughly
linearly with users and synced calendars.

## Idle reminder pass (improvement B4, deployed 2026-10-10)

The reminder pass now visits a user only when their `next_due_at` has passed
([ADR 0004](adr/0004-next-due-time-by-trigger.md)); an idle user is visited
about once an hour instead of every minute. Local measurement (2026-10-09,
one user, one calendar, 60 idle minute ticks in the test world, statements
counted at `prepare`):

| Statements in one idle hour | Before B4 | After B4 |
|---|---:|---:|
| Reminder-pass reads (horizon, overrides, tasks, log, agenda) | 576 | 6 |
| All statements | 2,419 | 1,707 |

The remaining statements are the rest of each tick (inbox, operations,
deliveries, maintenance). Rows read were measured live on 2026-10-21 (table
above). CPU has not been re-measured live with `wrangler tail`; do that before
adding a second user.

Scheduler liveness (improvement B3, deployed 2026-10-10) writes one `app_state`
row per tick: about 1,440 rows written a day, under 3% of the operating target.

The access-expiry warning (B1) adds one indexed read of `google_connections`
to frequent maintenance (every 5 minutes) and one write per user per week.

The evening preview (D2), when turned on, adds one live Google read of the
next day per user per evening, like the agenda.

Quick capture (improvement A1, deployed 2026-10-10) adds no scheduled work: each
plain message reads the user's lists and calendars (a few rows each) and makes
the same writes as the guided command it replaces. Choice buttons are retired
by primary key. Not yet measured live.

## Mini App (improvement D7, deployed 2026-10-10)

Local measurement (2026-10-10, test world, 20 open tasks, one calendar,
statements counted at `prepare`):

| Request | D1 statements | Google reads |
|---|---:|---:|
| Home (`/app/api/home`) | 12 | 1 per selected calendar |
| Today | 7 | 1 per selected calendar |
| Week | 7 | 1 per selected calendar |
| Overdue, No deadline, a list | 4 | 0 |
| Recent | 3 | 0 |
| One task write | about 3–5 | 0 (the deadline marker follows as a queued operation) |

Opening the app is three Worker requests (page, script, Home); each further
screen or action is one. Twenty opens a day with a few screens each is well
under 200 requests and 1,000 statements a day for one user. Each request also
verifies `initData` (two HMACs). Live CPU and request counts are measured at
step 5d, after a deploy the owner approves.

## Worker requests (Workers Free: 100,000 per day)

The cron is 1,440 invocations a day; webhook requests are one per Telegram
message or button press, plus page loads during Google connection. One active
user is roughly 2,000 requests a day, well inside the 50,000 operating target.

## Google and Telegram

- Google Calendar API: one list request per calendar every 5 minutes (about 864
  a day for three calendars), plus live reads for views, reminders, and changes;
  far below Google's per-project quota.
- Telegram: at most 20 sends per tick, ordered per user.

## Rollback drill

2026-10-04: rolled the live Worker back to the previous version with
`wrangler rollback`, confirmed `/healthz` and `/privacy` served, then rolled
forward to the current version. Migrations are additive, so the older version
ran against the newer schema without errors.

## Per-invocation budget (ADR 0009, 2026-10-22, not yet deployed)

Workers Free allows 50 D1 queries (each statement in a batch counting) and 50
subrequests per invocation. Measured in the test world before the change:

| Work | D1 statements |
|---|---:|
| Idle run | 14–28 |
| One message, whole webhook invocation | 15–22 |
| One user's reminder pass with the morning agenda | 33 (37 with 20 reminders due) |
| One user's horizon refresh (busy day) | 22 |
| First sync of a 120-event calendar, before | 127 in one run |
| A new daily task's first occurrences, before | about 63 in one run |

Since the change, every run counts its statements and calls and starts a unit
only if its worst case fits (`UNIT_COSTS` in `src/shared/run-budget.ts`). In
`tests/jobs/run-budget.test.ts`, no run exceeded 50 queries in any of these
cases: a 120-event first sync (spread over about 13 runs), five agendas in the
same minute (all sent within 5 runs), a new daily task, a 30-message backlog
under a nearly spent budget, and everything due at once. After deploying,
`tick.finished` logs `queries` and `calls` for every run; record the live
figures here.
