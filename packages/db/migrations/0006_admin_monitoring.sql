-- 0006_admin_monitoring.sql
-- Admin monitoring tables: provider runtime metrics, scrape job history, DB usage snapshots.
-- Plus users.last_login_at column.

-- users: track last login for admin user list display.
ALTER TABLE users ADD COLUMN last_login_at INTEGER;

-- provider_accounts: runtime metrics for accounts used by LB/scraper.
-- Distinct from lb_accounts (which stores encrypted CF API token + provision state).
-- This table is metrics-only — no credentials. Linked to lb_accounts via `provider`+`label`, not FK.
CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_error TEXT,
  requests_24h INTEGER NOT NULL DEFAULT 0,
  failures_24h INTEGER NOT NULL DEFAULT 0,
  quota_used_bytes INTEGER,
  quota_limit_bytes INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_label ON provider_accounts(provider, label);

-- scrape_jobs_log: append-only history for charting, distinct from scrape_jobs (runtime job tracker).
CREATE TABLE IF NOT EXISTS scrape_jobs_log (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  provider_account_id TEXT REFERENCES provider_accounts(id),
  status TEXT NOT NULL,
  items_scraped INTEGER DEFAULT 0,
  duration_ms INTEGER,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_log_started ON scrape_jobs_log(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_log_source ON scrape_jobs_log(source, started_at DESC);

-- db_usage_snapshot: D1 rows + R2 objects/bytes, append-only per snapshot per db.
CREATE TABLE IF NOT EXISTS db_usage_snapshot (
  id TEXT PRIMARY KEY,
  db_name TEXT NOT NULL,
  rows_or_objects INTEGER,
  size_bytes INTEGER,
  captured_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_db_usage_time ON db_usage_snapshot(db_name, captured_at);
