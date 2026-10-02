-- Foundation: users, durable Telegram inbox, and Telegram delivery outbox.
-- Times are UTC epoch milliseconds. Every user-owned row carries user_id.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  private_chat_id INTEGER NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Singapore',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  settings_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Accepted updates are persisted before the webhook is acknowledged. Only the
-- normalized fields needed for processing are stored, and the payload is cleared
-- once processing finishes; the row remains as a deduplication record.
CREATE TABLE telegram_inbox (
  update_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL CHECK (kind IN ('message', 'callback_query')),
  payload TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at INTEGER,
  received_at INTEGER NOT NULL,
  finished_at INTEGER,
  CHECK ((status IN ('processed', 'failed')) = (payload IS NULL)),
  CHECK ((status = 'processing') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX telegram_inbox_user_status ON telegram_inbox (user_id, status, update_id);
CREATE INDEX telegram_inbox_status_received ON telegram_inbox (status, received_at);

-- Outgoing Telegram calls. logical_key makes enqueueing idempotent per user.
-- 'unknown' means a send may have reached Telegram; it is never replayed blindly.
CREATE TABLE telegram_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  logical_key TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN (
    'sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'answerCallbackQuery')),
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
  UNIQUE (user_id, logical_key),
  CHECK ((status IN ('pending', 'sending')) = (payload IS NOT NULL)),
  CHECK ((status = 'sending') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX telegram_outbox_status_due ON telegram_outbox (status, due_at);
CREATE INDEX telegram_outbox_user_status ON telegram_outbox (user_id, status);
