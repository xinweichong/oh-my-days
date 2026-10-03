# ADR 0003: Recurring tasks as materialized occurrences with individual markers

Status: Accepted
Date: 2026-10-03

## Context

Spec §6 requires fixed daily, weekly, monthly, and yearly recurring tasks whose
occurrences have independent completion, cancellation, deadline, and reminder
state, with calendar edits to one occurrence affecting only that occurrence.
The backend plan proposed mirroring each series as a native Google recurring
event, with per-occurrence state expressed as instance exceptions. That needs
instance-ID derivation, exception bookkeeping, and handling of master edits that
rewrite the rule, on top of the stage 5 projection machinery.

## Decision

- A recurring task is a `task_series` (title, list, frequency, interval, anchor
  date, optional due time and zone). Each occurrence is an ordinary task row with
  an immutable `occurrence_date` identity and its own state.
- Occurrences are materialized on a rolling horizon (60 days, at most 31 future
  occurrences per series) by a bounded scheduled job that resumes from a cursor,
  so occurrences missed during an outage are backfilled, a few per run.
- Each occurrence with a deadline gets its own ordinary marker in the task
  calendar through the existing projection operation; sync maps edits and
  deletions to that occurrence only.
- Dates follow RFC 5545 semantics: a monthly series on the 31st skips months
  without a 31st, and a yearly series on 29 February occurs only in leap years.
  The interpreted schedule is shown to the user; dates are never clamped.
- Recurring events remain native Google series (Google owns event state);
  single-occurrence and whole-series changes use instance and master IDs.

## Alternatives considered

- *Native recurring markers with exceptions* (the plan's proposal): one entry per
  series in Google Calendar, but more provider-specific logic and harder
  reconciliation of external master edits.
- *Materializing all occurrences indefinitely*: unbounded rows and writes.

## Consequences

- Google Calendar shows recurring task deadlines as separate entries up to the
  horizon, not as a series; editing "all events" there is not available for tasks.
- Whole-series changes from Telegram (rename, stop) update the materialized
  occurrences and their markers, a bounded number of Google writes.
- Entries created as recurring events directly in the task calendar are not
  imported as recurring tasks.
