-- Timezones the user used before, newest first (improvement C7), offered as
-- buttons when changing timezone. JSON array of IANA names.
ALTER TABLE users ADD COLUMN recent_timezones TEXT NOT NULL DEFAULT '[]';
