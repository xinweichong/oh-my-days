-- Mini App write idempotency (ADR 0005): each write carries a client key; the
-- key is recorded in the same batch as the change (only if it applied), and a
-- replayed key returns the current result without changing anything again.
-- Kept 7 days.
CREATE TABLE app_requests (
  user_id TEXT NOT NULL REFERENCES users (id),
  request_key TEXT NOT NULL,
  -- Small JSON the reply is rebuilt from, e.g. {"taskId": "…"}.
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_key)
);

CREATE INDEX app_requests_created ON app_requests (created_at);
