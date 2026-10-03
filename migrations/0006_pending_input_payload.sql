-- Guided flows carry a draft between questions. pending_inputs holds only
-- short-lived conversation state, so it is rebuilt rather than migrated; the
-- kind is validated in application code.
DROP TABLE pending_inputs;

CREATE TABLE pending_inputs (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
