-- Work sessions scheduled for a task (improvement D4; spec §6): ordinary
-- events in the user's calendar, linked to the task. The task's deadline is
-- never changed by them, and completing the task leaves them in place.
CREATE TABLE task_sessions (
  user_id TEXT NOT NULL REFERENCES users (id),
  task_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  -- As created; the synced copy of the event is preferred when there is one.
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, calendar_id, event_id),
  FOREIGN KEY (task_id, user_id) REFERENCES tasks (id, user_id)
);

CREATE INDEX task_sessions_task ON task_sessions (user_id, task_id, ends_at);
