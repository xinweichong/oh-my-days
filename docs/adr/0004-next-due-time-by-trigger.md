# ADR 0004: Skip idle users with a trigger-maintained next due time

Status: Accepted
Date: 2026-10-09

## Context

The minute tick ran the reminder pass for every set-up user: about five D1
queries per user per minute (agenda check, reminder overrides, event horizon,
candidate tasks, reminder log), whether or not anything was due. One user cost
about 416,000 rows read a day and most of each tick's CPU, measured at a median
of 8 ms against the 10 ms Workers Free limit ([capacity](../capacity.md)).
Improvement B4 requires skipping idle users before a second user is added.

A stored "next due" time is only safe if every change that can bring a reminder
or agenda earlier clears it. Those changes come from many places: guided and
typed task changes, snoozes, reminder overrides, calendar sync importing task
markers, recurring-task materialization, the event horizon refresh, and
timezone changes. Clearing it explicitly on each path is easy to miss later.

## Decision

- `users.next_due_at` is the earliest of the next agenda, the next event or
  task reminder, and the next snooze end, capped at one hour from the visit.
  The reminder pass visits only users whose `next_due_at` is null or past.
- SQLite triggers clear `next_due_at` and increment `users.due_version` on
  inserts and relevant updates of `tasks`, any change to `reminder_overrides`,
  new or moved `event_horizon` rows, and timezone changes (migration 0013).
- The pass stores its computed time only if `due_version` is unchanged since it
  read the user, so a change made during the pass is never overwritten.
- The horizon refresh upserts rows and deletes those it no longer sees, instead
  of deleting everything first, so unchanged occurrences don't clear the time.

## Alternatives

- Clear `next_due_at` in application code on each change path: no schema
  logic, but a forgotten path silently delays reminders by up to the cap.
- Keep visiting every user with cheaper queries: helps CPU less and still
  scales reads with users × minutes.
- Per-reminder schedule rows (a due queue): precise, but duplicates the
  existing reminder computation and its revalidation rules.

## Consequences

- D1 reports rows changed by triggers in `meta.changes`. Code that treats
  `changes === 1` as "this guarded write won" must target a table without
  these triggers (today: operations, outbox, inbox, callback refs, agenda runs,
  connections). `tests/storage/d1-semantics.test.ts` pins this.
- Each task, override, horizon, or timezone change writes one extra row.
- A missed case delays a reminder by at most one hour (the cap), never drops it;
  a stale-early time only causes an extra visit.
- New settings that move reminders or the agenda (improvement D1, quiet hours
  D5) must clear `next_due_at` too, by trigger or explicitly.
