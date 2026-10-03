-- Reminders, agendas, snoozing, and the short event horizon (backend stage 6).

-- Event occurrences in a short upcoming window, read with recurring instances
-- expanded. Rebuilt per calendar from complete listings; used to schedule
-- reminders. Each reminder is revalidated against Google before it is sent.
CREATE TABLE event_horizon (
  user_id TEXT NOT NULL REFERENCES users (id),
  calendar_id TEXT NOT NULL,
  -- Instance ID: unique per occurrence, including recurring instances.
  event_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  declined INTEGER NOT NULL DEFAULT 0 CHECK (declined IN (0, 1)),
  refreshed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, calendar_id, event_id)
);

CREATE INDEX event_horizon_user_start ON event_horizon (user_id, starts_at);

-- When each user's horizon was last rebuilt.
ALTER TABLE users ADD COLUMN horizon_refreshed_at INTEGER;

-- Per-target reminder preferences. minutes_before NULL means no reminder.
CREATE TABLE reminder_overrides (
  user_id TEXT NOT NULL REFERENCES users (id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('event', 'task')),
  -- Event: "<calendarId>/<eventId>"; task: task ID.
  target_key TEXT NOT NULL,
  minutes_before INTEGER CHECK (minutes_before IS NULL OR minutes_before BETWEEN 0 AND 10080),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_kind, target_key)
);

-- Every reminder ever handled, keyed by target, schedule, and offset, so each
-- logical reminder is delivered (or deliberately skipped) at most once.
CREATE TABLE reminder_log (
  user_id TEXT NOT NULL REFERENCES users (id),
  reminder_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'skipped', 'confirmed_on_create', 'summarized')),
  claimed_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, reminder_key)
);

CREATE INDEX reminder_log_created ON reminder_log (created_at);

-- One daily agenda per user and local date, whatever the timezone changes.
CREATE TABLE agenda_runs (
  user_id TEXT NOT NULL REFERENCES users (id),
  local_date TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, local_date)
);

-- Snoozing changes only the next reminder, never the deadline.
ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER;
