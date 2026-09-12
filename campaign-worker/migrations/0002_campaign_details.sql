ALTER TABLE sends ADD COLUMN campaign_id TEXT;
ALTER TABLE sends ADD COLUMN campaign_name TEXT NOT NULL DEFAULT '';
ALTER TABLE sends ADD COLUMN body_text TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS sends_campaign_idx ON sends(campaign_id, at DESC);
