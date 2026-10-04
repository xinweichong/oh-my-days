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

All runs completed (`outcome: ok`). Wall time is 3–7 seconds, dominated by D1
round trips; scheduled invocations are not limited by wall time.

Design rules that keep CPU down (`src/jobs/tick.ts`): one calendar sync per run;
frequent maintenance (calendar lists, sync health, menu, confirmation expiry)
every 5 minutes and cleanup every 30 minutes, run on ticks without a sync unless
overdue by twice their interval; reminders load only tasks that could be due.

Residual risk: a run that syncs a calendar with many changed events parses more
JSON; pages are 250 events and at most 3 pages per run. If `cpuTime` exceeds the
limit regularly, lower `EVENT_PAGE_SIZE` or `MAX_PAGES_PER_RUN`.

## D1 (Workers Free daily allowances)

| Metric | Measured (24 h, before tuning) | Operating target | Allowance |
|---|---:|---:|---:|
| Rows read | 416,421 | 2,500,000 | 5,000,000 |
| Rows written | 5,218 | 50,000 | 100,000 |
| Database size | 0.4 MB | 2.5 GB aggregate | 500 MB per database |

Reads come mostly from the minute cron; the tuning above removed roughly half
of its queries, so reads should fall. Recheck with `npx wrangler d1 info
oh-my-days` after 24 hours, and before adding users: reads grow roughly
linearly with users and synced calendars.

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
