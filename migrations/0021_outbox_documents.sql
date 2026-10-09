-- Allow sendDocument in the outbox (improvement D6, /export). SQLite cannot
-- change a CHECK constraint, so the table is rebuilt with every row, column,
-- and index preserved. Nothing references telegram_outbox by foreign key.
CREATE TABLE telegram_outbox_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  logical_key TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN (
    'sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'answerCallbackQuery',
    'sendDocument')),
  payload TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'unknown', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  provider_message_id INTEGER,
  error_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  target TEXT,
  UNIQUE (user_id, logical_key),
  CHECK ((status IN ('pending', 'sending')) = (payload IS NOT NULL)),
  CHECK ((status = 'sending') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

INSERT INTO telegram_outbox_new (id, user_id, logical_key, method, payload, status, attempts,
  due_at, lease_token, lease_expires_at, provider_message_id, error_class, created_at,
  updated_at, target)
SELECT id, user_id, logical_key, method, payload, status, attempts, due_at, lease_token,
  lease_expires_at, provider_message_id, error_class, created_at, updated_at, target
FROM telegram_outbox;

DROP TABLE telegram_outbox;
ALTER TABLE telegram_outbox_new RENAME TO telegram_outbox;

CREATE INDEX telegram_outbox_status_due ON telegram_outbox (status, due_at);
CREATE INDEX telegram_outbox_user_status ON telegram_outbox (user_id, status);
CREATE INDEX telegram_outbox_reply ON telegram_outbox (user_id, provider_message_id);
