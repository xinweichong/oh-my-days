-- Cheaper idle ticks (improvement B4). The reminder pass visits a user only when
-- next_due_at has passed (or is unknown). Any change that could bring a
-- reminder or agenda earlier clears it, by trigger, so no code path can forget;
-- due_version lets a tick store its computed time only if nothing changed while
-- it was computing.
ALTER TABLE users ADD COLUMN next_due_at INTEGER;
ALTER TABLE users ADD COLUMN due_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX users_next_due ON users (next_due_at);

CREATE TRIGGER next_due_task_insert AFTER INSERT ON tasks
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = NEW.user_id;
END;

CREATE TRIGGER next_due_task_update
AFTER UPDATE OF status, due_kind, due_date, due_at, snoozed_until ON tasks
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = NEW.user_id;
END;

CREATE TRIGGER next_due_override_insert AFTER INSERT ON reminder_overrides
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = NEW.user_id;
END;

CREATE TRIGGER next_due_override_update AFTER UPDATE ON reminder_overrides
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = NEW.user_id;
END;

CREATE TRIGGER next_due_override_delete AFTER DELETE ON reminder_overrides
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = OLD.user_id;
END;

-- The horizon is upserted on every refresh; only new or moved occurrences count.
CREATE TRIGGER next_due_horizon_insert AFTER INSERT ON event_horizon
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = NEW.user_id;
END;

CREATE TRIGGER next_due_horizon_update AFTER UPDATE OF starts_at, declined ON event_horizon
WHEN OLD.starts_at IS NOT NEW.starts_at OR OLD.declined IS NOT NEW.declined
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = NEW.user_id;
END;

CREATE TRIGGER next_due_timezone AFTER UPDATE OF timezone ON users
WHEN OLD.timezone IS NOT NEW.timezone
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = NEW.id;
END;
