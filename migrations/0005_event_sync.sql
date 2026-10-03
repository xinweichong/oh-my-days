-- Event cache and per-calendar synchronization state (backend stage 4).
-- Google owns event state; this is a versioned cache, never proof of permission.

CREATE TABLE event_cache (
  user_id TEXT NOT NULL REFERENCES users (id),
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  etag TEXT NOT NULL,
  summary TEXT NOT NULL,
  start_json TEXT NOT NULL,
  end_json TEXT NOT NULL,
  -- Timed events: UTC instants. All-day events: local dates (end exclusive).
  -- Exactly one pair is set; date-only values are never turned into instants.
  starts_at INTEGER,
  ends_at INTEGER,
  start_date TEXT,
  end_date TEXT,
  recurring INTEGER NOT NULL DEFAULT 0 CHECK (recurring IN (0, 1)),
  recurring_event_id TEXT,
  transparent INTEGER NOT NULL DEFAULT 0 CHECK (transparent IN (0, 1)),
  declined INTEGER NOT NULL DEFAULT 0 CHECK (declined IN (0, 1)),
  has_guests INTEGER NOT NULL DEFAULT 0 CHECK (has_guests IN (0, 1)),
  organizer_self INTEGER NOT NULL DEFAULT 1 CHECK (organizer_self IN (0, 1)),
  -- Full-resync generation that last confirmed this row.
  generation INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, calendar_id, event_id),
  CHECK ((starts_at IS NULL) = (ends_at IS NULL)),
  CHECK ((start_date IS NULL) = (end_date IS NULL)),
  CHECK ((starts_at IS NULL) <> (start_date IS NULL))
);

CREATE INDEX event_cache_user_time ON event_cache (user_id, starts_at);
CREATE INDEX event_cache_user_date ON event_cache (user_id, start_date);

CREATE TABLE calendar_sync (
  user_id TEXT NOT NULL REFERENCES users (id),
  calendar_id TEXT NOT NULL,
  sync_token TEXT,
  -- Set while a page sequence is in progress; the sync token advances only
  -- after the final page succeeds.
  page_token TEXT,
  -- Completed full-resync generation, and the one in progress (if any).
  generation INTEGER NOT NULL DEFAULT 0,
  resync_generation INTEGER,
  next_sync_at INTEGER NOT NULL,
  last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_class TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  PRIMARY KEY (user_id, calendar_id)
);

CREATE INDEX calendar_sync_due ON calendar_sync (next_sync_at);

-- When the user last pressed Force poll (cooldown), and when calendars were listed.
ALTER TABLE users ADD COLUMN force_poll_at INTEGER;
ALTER TABLE users ADD COLUMN calendars_listed_at INTEGER;
