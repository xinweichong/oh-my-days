-- Durable operations, confirmations, and Undo references.
-- Composite (id, user_id) keys make cross-user references impossible at the schema level.

-- An intended change and its lifecycle:
--   awaiting_confirmation -> ready -> applying -> succeeded
--   with retry_wait, needs_resolution, auth_required, failed, and cancelled branches.
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL,
  -- Unique per user; repeated requests with the same key return the same operation.
  idempotency_key TEXT NOT NULL,
  -- Operation input: target, base version/values, and intended change.
  intent TEXT NOT NULL,
  -- Exact summary the user confirmed (recipients, scope, values) and its hash.
  preview TEXT,
  preview_hash TEXT,
  confirmation_expires_at INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_confirmation', 'ready', 'applying', 'retry_wait', 'succeeded',
    'needs_resolution', 'auth_required', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  lease_token TEXT,
  lease_expires_at INTEGER,
  -- Set when a provider call may have taken effect without confirmation; the next
  -- attempt must reconcile provider state before writing again.
  outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
  result TEXT,
  error_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, user_id),
  UNIQUE (user_id, idempotency_key),
  CHECK ((status = 'applying') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (status <> 'awaiting_confirmation'
    OR (preview_hash IS NOT NULL AND confirmation_expires_at IS NOT NULL))
);

CREATE INDEX operations_due ON operations (status, next_attempt_at);
CREATE INDEX operations_user_status ON operations (user_id, status);

-- Opaque tokens carried in Telegram callback_data. A token is bound to one user,
-- one operation, one action, and (for confirmations) the exact preview shown.
CREATE TABLE callback_refs (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('confirm', 'cancel', 'undo')),
  preview_hash TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id, user_id) REFERENCES operations (id, user_id)
);

CREATE INDEX callback_refs_operation ON callback_refs (operation_id, user_id);
CREATE INDEX callback_refs_expiry ON callback_refs (expires_at);
