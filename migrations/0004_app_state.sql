-- Small application-wide settings that are not owned by a user, such as the
-- fingerprint of the command menu last registered with Telegram.
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
