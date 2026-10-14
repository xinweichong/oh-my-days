-- Per-user agenda time and default reminder lead (improvement D1). Defaults
-- keep the original behaviour: 8am, one hour before.
ALTER TABLE users ADD COLUMN agenda_hour INTEGER NOT NULL DEFAULT 8
  CHECK (agenda_hour BETWEEN 6 AND 11);
ALTER TABLE users ADD COLUMN reminder_minutes INTEGER NOT NULL DEFAULT 60
  CHECK (reminder_minutes BETWEEN 0 AND 1440);

-- Either can bring the next agenda or reminder earlier (ADR 0004).
CREATE TRIGGER next_due_schedule_settings
AFTER UPDATE OF agenda_hour, reminder_minutes ON users
WHEN OLD.agenda_hour IS NOT NEW.agenda_hour OR OLD.reminder_minutes IS NOT NEW.reminder_minutes
BEGIN
  UPDATE users SET next_due_at = NULL, due_version = due_version + 1 WHERE id = NEW.id;
END;
