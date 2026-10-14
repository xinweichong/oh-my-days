-- How many "Next time you can type: …" hints the user has seen after guided
-- creations (improvement A3); hints stop after three.
ALTER TABLE users ADD COLUMN typing_hints_shown INTEGER NOT NULL DEFAULT 0;
