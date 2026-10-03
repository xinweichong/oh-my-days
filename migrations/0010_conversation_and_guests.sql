-- Contacts, reply targeting, and sync health alerts (backend stage 8).

-- Per-user shortcuts from a name to an email address. Never imported from Google.
CREATE TABLE contacts (
  user_id TEXT NOT NULL REFERENCES users (id),
  normalized_name TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, normalized_name)
);

-- The item a sent message is about, so a reply to it can target that item.
-- JSON: {"kind":"event","calendarId":…,"eventId":…} or {"kind":"task","taskId":…}.
ALTER TABLE telegram_outbox ADD COLUMN target TEXT;
CREATE INDEX telegram_outbox_reply ON telegram_outbox (user_id, provider_message_id);

-- The single item most recently discussed, for follow-ups that are not replies.
ALTER TABLE users ADD COLUMN last_item TEXT;
ALTER TABLE users ADD COLUMN last_item_at INTEGER;

-- One outage alert after repeated failed sync checks, and one recovery notice.
ALTER TABLE users ADD COLUMN sync_alerted_at INTEGER;
