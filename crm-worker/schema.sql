PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'rep',
  salt TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login TEXT,
  phone TEXT NOT NULL DEFAULT '', sender_first_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username), expires TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, phone TEXT, website TEXT, city TEXT, state TEXT,
  rating REAL, review_count INTEGER, is_national_chain TEXT, dm_name TEXT, dm_title TEXT, email TEXT,
  lead_score INTEGER, stage TEXT NOT NULL DEFAULT 'New Lead', owner TEXT, next_action_date TEXT,
  last_contacted TEXT, enriched_at TEXT, needs_human_review INTEGER NOT NULL DEFAULT 0,
  scraped_at TEXT, updated_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_pipeline_idx ON leads(stage, lead_score DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS leads_review_idx ON leads(rating ASC, review_count DESC);
CREATE INDEX IF NOT EXISTS leads_owner_idx ON leads(owner, next_action_date);
CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads(phone);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user TEXT NOT NULL, lead_id TEXT,
  lead_name TEXT, type TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS activity_lead_idx ON activity(lead_id, at DESC);
CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user TEXT NOT NULL, lead_id TEXT, recipient TEXT,
  from_local TEXT, subject TEXT, resend_id TEXT, status TEXT, tracking_token TEXT, opened_at TEXT,
  open_count INTEGER NOT NULL DEFAULT 0, campaign_id TEXT, campaign_name TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '', member_id INTEGER, step_no INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS sends_tracking_token_idx ON sends(tracking_token);
CREATE INDEX IF NOT EXISTS sends_campaign_idx ON sends(campaign_id, at DESC);
CREATE INDEX IF NOT EXISTS sends_member_idx ON sends(member_id, step_no);

-- Email sequences (campaign-worker migration 0003)
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
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, note TEXT,
  status TEXT NOT NULL, requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
  expires TEXT NOT NULL, used_at TEXT
);
