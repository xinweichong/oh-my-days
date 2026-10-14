-- While the Google OAuth app is in Testing, refresh tokens end seven days after
-- consent (improvement B1). The generation that was already warned, so each
-- connection gets one warning.
ALTER TABLE google_connections ADD COLUMN expiry_warned_generation INTEGER;
