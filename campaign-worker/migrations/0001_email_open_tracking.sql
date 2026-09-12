ALTER TABLE sends ADD COLUMN tracking_token TEXT;
ALTER TABLE sends ADD COLUMN opened_at TEXT;
ALTER TABLE sends ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS sends_tracking_token_idx ON sends(tracking_token);
