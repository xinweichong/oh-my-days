-- Recurring tasks (backend stage 7; ADR 0003). A series materializes ordinary
-- task rows as occurrences, each with an immutable occurrence date.

CREATE TABLE task_series (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  freq TEXT NOT NULL CHECK (freq IN ('daily', 'weekly', 'monthly', 'yearly')),
  interval INTEGER NOT NULL DEFAULT 1 CHECK (interval >= 1),
  anchor_date TEXT NOT NULL,
  -- Optional local due time (HH:MM) in the series timezone; otherwise date-only.
  due_time TEXT,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
  -- Last occurrence date materialized; the job resumes after it.
  materialized_through TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, user_id),
  FOREIGN KEY (list_id, user_id) REFERENCES task_lists (id, user_id)
);

CREATE INDEX task_series_due ON task_series (status, materialized_through);

ALTER TABLE tasks ADD COLUMN series_id TEXT;
ALTER TABLE tasks ADD COLUMN occurrence_date TEXT;

-- One row per occurrence, whatever later happens to its deadline.
CREATE UNIQUE INDEX tasks_occurrence ON tasks (user_id, series_id, occurrence_date)
  WHERE series_id IS NOT NULL;
