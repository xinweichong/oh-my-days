# ADR 0008: Several reminders per item, fixed times, and date-only deadlines

Status: Proposed (implemented on `feature/item-reminders`, not yet deployed)
Date: 2026-10-20

## Context

The spec allows per-event reminder overrides (§5) and lists reminder
preferences as an attribute of a request (§4). Until now each event or task had
at most one override: one of five lead times (10 min to 1 day) or none, stored
as one `minutes_before` value in `reminder_overrides`. The owner asked for
several reminders per item, custom ones (a lead time or a fixed time), and the
same reminders on date-only deadlines, which until now only appeared in the
daily agenda. Both the chat and the Mini App must offer this.

Two constraints shaped the design:

- **The event horizon is 26 hours.** The reminder pass schedules event
  reminders from `event_horizon`, which is rebuilt every 10 minutes from live
  listings. Widening it to a week would rewrite every upcoming occurrence on
  each refresh, which would cost too many D1 rows written for several users.
- **Workers Free allows 50 D1 queries per invocation**, and each claim in the
  reminder log is one statement.

## Decision

- **Rules.** An item's reminders are a set of up to five rules
  (`src/domain/reminders.ts`):
  - a lead time before an event's start or an exact deadline (`b60`);
  - a local time on the item's day or up to 7 days before (`d1@18:00`);
  - a fixed instant (`a<ms>`).

  Lead times apply only to timed items. On a date-only deadline, a whole-day
  lead ("1 day before") means that day at the agenda hour. A reminder must fall
  before the item: before its start, or before the end of a date-only
  deadline's day.
- **Storage.** `reminder_overrides` keeps one row per item (migration 0023).
  `rules` holds the JSON list of codes; an empty list means no reminders;
  no row means the default. Rows written before this migration have
  `rules = NULL` and are read from `minutes_before`. `minutes_before` is still
  written, as the shortest lead time, so a rollback keeps one reminder working.
- **Beyond the horizon.** An event's row also keeps the start (`anchor_at`) or
  all-day date (`anchor_date`) seen when its reminders were set. The reminder
  pass uses the horizon for events inside it and the kept start for the rest
  (and for all-day events). Before sending, every event reminder is re-read
  from Google as before. A moved event's reminder is skipped and its kept start
  updated, so its other reminders follow the new time. Rows for events more
  than two days past are purged in cleanup.
- **One planner.** `planReminders` (`src/application/reminder-plan.ts`) is pure
  and gives every reminder with its time and log key. The reminder pass,
  `/reminders`, and the Mini App use it. Keys keep bare minutes for lead times,
  so reminders already logged under the old keys are not sent again.
- **Late and stale.** A rule whose time had passed when the item's reminders
  were set is not sent. Rules are refused at entry in that case, with a reason.
  Item reminders more than 7 days late are dropped (the log keeps keys for 30).
  Two of an item's reminders due at the same moment are one message.
- **Query budget.** A user's pass handles at most 8 due reminders
  (`MAX_DUE_PER_PASS`); a backlog goes out over consecutive minutes. Cached
  event details for due items, and for `/reminders`, are read in one query.
- **Interfaces.**
  - **Chat:** the event and task cards' **Reminders** button opens a menu.
    Presets toggle on and off. **Custom…** takes typed input
    ("45m, 1 day before 6pm, Thu 9am"; "only …" replaces). There are also
    **Default** and **None**. Replies and last-item follow-ups accept
    "remind me 2h", "remind me Sun 8pm", and "no reminders". "Remind me to …"
    is still a new task.
  - **Mini App:** task detail shows the reminders, with a sheet to change them.
    Tapping an event opens a sheet with its reminders and **Open in Google
    Calendar**.

  Both use the same parser and checks. Mini App writes replace the set,
  carry the version (`updated_at`), and use an idempotency key.

## Alternatives considered

- **A row per rule** in a new table. This gives per-rule timestamps, but it
  needs new triggers for the next-due time (ADR 0004), a second cleanup, and
  multi-row replacement for each edit. One row per item keeps the existing
  triggers and makes every change a single upsert.
- **Widening the horizon to 7 days.** This is simple, but it rewrites every
  upcoming event on each refresh, which would cost several thousand rows written
  per user per day.
- **Several default reminders in `/settings`.** Not requested. The default
  stays one lead time.

## Consequences

- Reminders now have a fourth kind of time to get right (local wall times
  relative to an item's day). This is covered by DST and zone tests in
  `tests/domain/reminders.test.ts`.
- Changing an item's reminders resets the "set at" time used for lateness. A
  reminder that was due but held (quiet hours, downtime) when the set changed
  is dropped rather than sent late.
- After downtime with more than 8 reminders due, the catch-up arrives as more
  than one summary, a minute apart. This is a deliberate exception to "one
  catch-up summary" (spec §8), to stay inside the query limit.
- An event's kept start can be stale until its next reminder re-reads it.
  A reminder set long ahead for an event moved earlier may then arrive late or
  be skipped. This is never a duplicate, and never a reminder for a cancelled
  event.
- Reminders are still not settable in the creating message ("Dinner Fri 7pm
  remind 1d"). They are set right after it, by reply or button. The spec's §4
  attribute remains partly open.
