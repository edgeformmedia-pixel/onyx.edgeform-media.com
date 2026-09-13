ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN sender_first_name TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS campaign_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT, updated_by TEXT
);

CREATE TABLE IF NOT EXISTS sequences (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sequence_steps (
  sequence_id TEXT NOT NULL REFERENCES sequences(id), step_no INTEGER NOT NULL, variant TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL, body TEXT NOT NULL, delay_days INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sequence_id, step_no, variant)
);

CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sequence_id TEXT NOT NULL REFERENCES sequences(id),
  from_local TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL REFERENCES outreach_campaigns(id),
  lead_id TEXT NOT NULL, email TEXT NOT NULL, variant TEXT NOT NULL DEFAULT 'first', variant_reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', current_step INTEGER NOT NULL DEFAULT 0, next_due_at TEXT,
  last_sent_at TEXT, sending_at TEXT, enrolled_at TEXT NOT NULL, enrolled_by TEXT, status_at TEXT,
  unsub_token TEXT NOT NULL UNIQUE, UNIQUE (campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS campaign_members_due_idx ON campaign_members(status, next_due_at);
CREATE INDEX IF NOT EXISTS campaign_members_lead_idx ON campaign_members(lead_id);
CREATE INDEX IF NOT EXISTS campaign_members_email_idx ON campaign_members(email);

CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY, reason TEXT NOT NULL, lead_id TEXT, at TEXT NOT NULL
);

ALTER TABLE sends ADD COLUMN member_id INTEGER;
ALTER TABLE sends ADD COLUMN step_no INTEGER;
CREATE INDEX IF NOT EXISTS sends_member_idx ON sends(member_id, step_no);
