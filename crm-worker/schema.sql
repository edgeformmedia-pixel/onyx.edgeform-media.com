PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'rep',
  salt TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login TEXT
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
  body_text TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS sends_tracking_token_idx ON sends(tracking_token);
CREATE INDEX IF NOT EXISTS sends_campaign_idx ON sends(campaign_id, at DESC);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, note TEXT,
  status TEXT NOT NULL, requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
  expires TEXT NOT NULL, used_at TEXT
);
