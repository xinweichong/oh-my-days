-- Google connection, calendar selection, and setup state (backend stage 3).

-- One Google account per user. Tokens are AES-GCM encrypted with a key held in a
-- Worker secret, bound to the owning user (see src/security/token-cipher.ts).
CREATE TABLE google_connections (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  -- OpenID Connect subject: the stable Google account identifier.
  google_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  scopes TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  access_token_enc TEXT,
  access_token_expires_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active', 'auth_required')),
  -- Incremented on every successful (re)connection; keys one alert per outage.
  auth_generation INTEGER NOT NULL DEFAULT 1,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Short-lived links sent in Telegram. Opening one only shows the connection page;
-- starting authorization consumes it.
CREATE TABLE connect_links (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  -- 'replace' permits linking a different Google account after confirmation.
  purpose TEXT NOT NULL CHECK (purpose IN ('connect', 'reconnect', 'replace')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Single-use OAuth state with its PKCE verifier. outcome records the result so a
-- refreshed callback shows it without exchanging the code again.
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('connect', 'reconnect', 'replace')),
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  outcome TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX connect_links_expiry ON connect_links (expires_at);
CREATE INDEX oauth_states_expiry ON oauth_states (expires_at);

-- The user's calendars as last listed from Google. Provider IDs, never names,
-- identify calendars. access_role is a cache for display; writes are still
-- checked by Google.
CREATE TABLE calendars (
  user_id TEXT NOT NULL REFERENCES users (id),
  calendar_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  access_role TEXT NOT NULL CHECK (access_role IN ('owner', 'writer', 'reader', 'freeBusyReader')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  -- 0 once the calendar disappears from the user's list; kept for links.
  listed INTEGER NOT NULL DEFAULT 1 CHECK (listed IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, calendar_id)
);

ALTER TABLE users ADD COLUMN default_calendar_id TEXT;
ALTER TABLE users ADD COLUMN task_calendar_id TEXT;
-- Guided setup position: connect -> calendars -> default -> task_calendar -> timezone -> done.
ALTER TABLE users ADD COLUMN setup_step TEXT NOT NULL DEFAULT 'connect'
  CHECK (setup_step IN ('connect', 'calendars', 'default', 'task_calendar', 'timezone', 'done'));

-- Opaque button tokens for non-operation actions (pickers, settings, setup).
-- Payload is server-side state; buttons carry only the token.
CREATE TABLE ui_actions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX ui_actions_expiry ON ui_actions (expires_at);

-- A question awaiting a typed answer (e.g. a calendar name or timezone).
CREATE TABLE pending_inputs (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  kind TEXT NOT NULL CHECK (kind IN ('new_default_calendar_name', 'timezone')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
