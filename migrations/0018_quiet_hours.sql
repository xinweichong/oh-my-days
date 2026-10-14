-- Optional nightly quiet hours (improvement D5): local start and end hours, or
-- both NULL when off. Reminders due inside are held and summarized at the end.
ALTER TABLE users ADD COLUMN quiet_start INTEGER CHECK (quiet_start BETWEEN 0 AND 23);
ALTER TABLE users ADD COLUMN quiet_end INTEGER CHECK (quiet_end BETWEEN 0 AND 23);

CREATE TRIGGER next_due_quiet_hours AFTER UPDATE OF quiet_start, quiet_end ON users
WHEN OLD.quiet_start IS NOT NEW.quiet_start OR OLD.quiet_end IS NOT NEW.quiet_end
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = NEW.id;
END;
