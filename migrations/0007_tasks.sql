-- Tasks and lists (backend stage 5). The application owns task state; the task
-- calendar holds deadline markers projected from it.

CREATE TABLE task_lists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  -- Lower-cased, whitespace-collapsed name; unique so lists never silently duplicate.
  normalized_name TEXT NOT NULL,
  is_inbox INTEGER NOT NULL DEFAULT 0 CHECK (is_inbox IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, user_id),
  UNIQUE (user_id, normalized_name)
);

CREATE UNIQUE INDEX task_lists_one_inbox ON task_lists (user_id) WHERE is_inbox = 1;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  -- Deadline: none, a local date (never an instant), or an instant with the zone
  -- it was given in.
  due_kind TEXT NOT NULL CHECK (due_kind IN ('none', 'date', 'datetime')),
  due_date TEXT,
  due_at INTEGER,
  due_tz TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled')),
  completed_at INTEGER,
  cancelled_at INTEGER,
  -- Incremented on every change; binds Undo and confirmations to an exact state.
  version INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL CHECK (origin IN ('telegram', 'calendar')),
  -- Deadline marker in the task calendar, and what was last written there.
  projection_calendar_id TEXT,
  projection_event_id TEXT,
  projection_etag TEXT,
  projected_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, user_id),
  FOREIGN KEY (list_id, user_id) REFERENCES task_lists (id, user_id),
  CHECK ((due_kind = 'none') = (due_date IS NULL AND due_at IS NULL)),
  CHECK ((due_kind = 'date') = (due_date IS NOT NULL)),
  CHECK ((due_kind = 'datetime') = (due_at IS NOT NULL AND due_tz IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((projection_calendar_id IS NULL) = (projection_event_id IS NULL))
);

CREATE INDEX tasks_user_status ON tasks (user_id, status, due_at, due_date);
CREATE INDEX tasks_user_list ON tasks (user_id, list_id, status);
CREATE UNIQUE INDEX tasks_projection ON tasks (user_id, projection_calendar_id, projection_event_id)
  WHERE projection_event_id IS NOT NULL;
