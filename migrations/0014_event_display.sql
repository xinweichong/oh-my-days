-- Display-only event details for reminders (improvement C2): location, video
-- call link, and Google Calendar link. Kept with the short-lived event horizon
-- (rows go when the occurrence leaves the window); never part of event fields,
-- so conflict checks and patches are unaffected.
ALTER TABLE event_horizon ADD COLUMN location TEXT;
ALTER TABLE event_horizon ADD COLUMN call_url TEXT;
ALTER TABLE event_horizon ADD COLUMN html_link TEXT;
