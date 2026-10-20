-- Several reminders per event or task, including fixed times and date-only
-- deadlines (ADR 0008). `rules` is a JSON array of rule codes (b60, d1@18:00,
-- a<instant>); an empty array means no reminders, and NULL marks a row written
-- before this migration, read from minutes_before. For events, anchor_at (a
-- timed event's start) or anchor_date (an all-day event's date) is kept from
-- when the reminders were set, so reminders beyond the 26-hour event horizon
-- can be scheduled; each is re-read from Google before it is sent.
--
-- minutes_before keeps the shortest lead time (or NULL), so the previous
-- version still works after a rollback, with only that one reminder.
ALTER TABLE reminder_overrides ADD COLUMN rules TEXT;
ALTER TABLE reminder_overrides ADD COLUMN anchor_at INTEGER;
ALTER TABLE reminder_overrides ADD COLUMN anchor_date TEXT;
