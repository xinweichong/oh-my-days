-- Optional evening preview of tomorrow (improvement D2): the local hour it is
-- sent, or NULL when off. Sent previews are recorded in agenda_runs under
-- "evening:<local date>", so each date gets at most one and they are purged
-- with agenda runs.
ALTER TABLE users ADD COLUMN evening_hour INTEGER CHECK (evening_hour BETWEEN 18 AND 22);

CREATE TRIGGER next_due_evening_hour AFTER UPDATE OF evening_hour ON users
WHEN OLD.evening_hour IS NOT NEW.evening_hour
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = NEW.id;
END;
