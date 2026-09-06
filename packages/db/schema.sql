-- Manga Platform canonical D1 schema
-- SQLite-native (D1 runs via `wrangler d1 execute --file=...`); FTS5 supported in D1.

---------------------------------------------------------------------
-- series
---------------------------------------------------------------------
CREATE TABLE series (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    UNIQUE NOT NULL,
  external_id   TEXT,
  source        TEXT    NOT NULL DEFAULT 'komiku',
  title         TEXT    NOT NULL,
  synopsis      TEXT,
  type          TEXT    NOT NULL CHECK (type IN ('manga', 'manhwa', 'manhua')),
  status        TEXT    NOT NULL CHECK (status IN ('ongoing', 'completed', 'hiatus', 'cancelled')),
  author        TEXT,
  artist        TEXT,
  cover_image   TEXT,
  genres        TEXT,
  tags          TEXT,
  alt_titles    TEXT,
  source_url    TEXT,
  cover_r2_key  TEXT,
  language      TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

---------------------------------------------------------------------
-- chapters
---------------------------------------------------------------------
CREATE TABLE chapters (
  id            TEXT    PRIMARY KEY,
  series_slug   TEXT    NOT NULL REFERENCES series (slug) ON DELETE CASCADE,
  chapter_number REAL  NOT NULL,
  volume        TEXT,
  title         TEXT,
  language      TEXT    NOT NULL DEFAULT 'en',
  pages_count   INTEGER NOT NULL DEFAULT 0,
  published_at  INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_chapters_series_slug ON chapters(series_slug);

---------------------------------------------------------------------
-- chapter_pages (0002/0007/0009: no FK, B2 key + LRU)
---------------------------------------------------------------------
CREATE TABLE chapter_pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id    TEXT    NOT NULL,
  page_number   INTEGER NOT NULL,
  image_url     TEXT    NOT NULL,
  r2_key        TEXT,
  r2_account_idx INTEGER,
  last_access   INTEGER,
  UNIQUE (chapter_id, page_number)
);
CREATE INDEX idx_chapter_pages_chapter ON chapter_pages(chapter_id);
CREATE INDEX idx_chapter_pages_last_access ON chapter_pages(last_access);

---------------------------------------------------------------------
-- users
---------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    UNIQUE NOT NULL,
  name          TEXT,
  password_hash TEXT,
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned')),
  display_name  TEXT,
  avatar_url    TEXT,
  bio           TEXT,
  preferences   TEXT    NOT NULL DEFAULT '{}',
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

---------------------------------------------------------------------
-- bookmarks
---------------------------------------------------------------------
CREATE TABLE bookmarks (
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  series_slug   TEXT    NOT NULL REFERENCES series (slug) ON DELETE CASCADE,
  source        TEXT,
  source_url    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, series_slug)
);
CREATE INDEX idx_bookmarks_source ON bookmarks (source, created_at DESC);

---------------------------------------------------------------------
-- reading_history
---------------------------------------------------------------------
CREATE TABLE reading_history (
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  chapter_id    TEXT    NOT NULL REFERENCES chapters (id) ON DELETE CASCADE,
  last_page     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, chapter_id)
);

---------------------------------------------------------------------
-- sessions (0008)
---------------------------------------------------------------------
CREATE TABLE sessions (
  sid         TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  ua          TEXT,
  ip          TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

---------------------------------------------------------------------
-- image_hashes + scrape_jobs + source_health (0001)
---------------------------------------------------------------------
CREATE TABLE image_hashes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  series_slug TEXT    NOT NULL REFERENCES series(slug) ON DELETE CASCADE,
  hash        TEXT    NOT NULL,
  r2_key      TEXT,
  image_type  TEXT    NOT NULL CHECK (image_type IN ('cover','page')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_image_hashes_hash ON image_hashes(hash);
CREATE INDEX idx_image_hashes_slug ON image_hashes(series_slug);

CREATE TABLE scrape_jobs (
  id          TEXT PRIMARY KEY,
  source      TEXT    NOT NULL,
  source_url  TEXT,
  query       TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('pending','running','completed','failed','skipped_robots')) DEFAULT 'pending',
  series_slug TEXT    REFERENCES series(slug) ON DELETE SET NULL,
  error       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);
CREATE INDEX idx_scrape_jobs_status ON scrape_jobs(status);
CREATE INDEX idx_scrape_jobs_series ON scrape_jobs(series_slug);

CREATE TABLE source_health (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,
  healthy     INTEGER NOT NULL,
  latency_ms  INTEGER,
  error       TEXT,
  checked_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_source_health_source ON source_health(source, checked_at DESC);

---------------------------------------------------------------------
-- lb_usage (0002)
---------------------------------------------------------------------
CREATE TABLE lb_usage (
  origin_url   TEXT NOT NULL,
  date_key     TEXT NOT NULL,
  req_count    INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (origin_url, date_key)
);

---------------------------------------------------------------------
-- aggregation (0004)
---------------------------------------------------------------------
CREATE TABLE manga_source_link (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  manga_id         INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  source           TEXT    NOT NULL,
  source_slug      TEXT    NOT NULL,
  has_chapter_list INTEGER NOT NULL DEFAULT 1,
  chapter_count    INTEGER NOT NULL DEFAULT 0,
  last_scraped_at  INTEGER,
  UNIQUE (source, source_slug)
);
CREATE INDEX idx_msl_manga ON manga_source_link(manga_id);

CREATE TABLE manga_merge_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT    NOT NULL,
  source_slug   TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  candidate_ids TEXT    NOT NULL,
  confidence    REAL    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','rejected')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at   INTEGER
);
CREATE INDEX idx_mq_status ON manga_merge_queue(status);

---------------------------------------------------------------------
-- admin monitoring (0006)
---------------------------------------------------------------------
CREATE TABLE provider_accounts (
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
CREATE UNIQUE INDEX idx_provider_accounts_provider_label ON provider_accounts(provider, label);

CREATE TABLE scrape_jobs_log (
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
CREATE INDEX idx_scrape_jobs_log_started ON scrape_jobs_log(started_at DESC);
CREATE INDEX idx_scrape_jobs_log_source ON scrape_jobs_log(source, started_at DESC);

CREATE TABLE db_usage_snapshot (
  id TEXT PRIMARY KEY,
  db_name TEXT NOT NULL,
  rows_or_objects INTEGER,
  size_bytes INTEGER,
  captured_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_db_usage_time ON db_usage_snapshot(db_name, captured_at);

---------------------------------------------------------------------
-- load balancing settings (single row, id = 1)
---------------------------------------------------------------------
CREATE TABLE lb_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  mode          TEXT    NOT NULL CHECK (mode IN ('off','on')) DEFAULT 'off',
  implementation TEXT   NOT NULL CHECK (implementation IN ('native_cf','custom')) DEFAULT 'custom',
  steering_policy TEXT  DEFAULT 'failover',
  health_check_interval_sec INTEGER DEFAULT 30,
  health_check_timeout_ms INTEGER DEFAULT 3000,
  failure_threshold INTEGER DEFAULT 2
);

---------------------------------------------------------------------
-- load balancing accounts (tokens AES-GCM encrypted at rest, stored as BLOB)
---------------------------------------------------------------------
CREATE TABLE lb_accounts (
  id              TEXT PRIMARY KEY,
  provider        TEXT    NOT NULL CHECK (provider IN ('cloudflare','vercel')),
  label           TEXT    NOT NULL,
  account_ref     TEXT,
  encrypted_token BLOB    NOT NULL,
  token_last4     TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('verified','unverified','failed')) DEFAULT 'unverified',
  created_by      INTEGER REFERENCES users (id),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

---------------------------------------------------------------------
-- load balancing origins
---------------------------------------------------------------------
CREATE TABLE lb_origins (
  id                TEXT PRIMARY KEY,
  account_id        TEXT REFERENCES lb_accounts (id) ON DELETE SET NULL,
  origin_url        TEXT    NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 0,
  weight            INTEGER NOT NULL DEFAULT 1,
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_health_status TEXT,
  last_checked_at   INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

---------------------------------------------------------------------
-- load balancing audit log (account_id / origin_id are TEXT FK to lb_* )
---------------------------------------------------------------------
CREATE TABLE lb_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT REFERENCES lb_accounts (id),
  origin_id     TEXT REFERENCES lb_origins (id),
  action        TEXT    NOT NULL,
  user_id       INTEGER REFERENCES users (id),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_audit_account ON lb_audit_log(account_id);
CREATE INDEX idx_audit_origin  ON lb_audit_log(origin_id);

---------------------------------------------------------------------
-- security events (admin dashboard abuse feed)
---------------------------------------------------------------------
CREATE TABLE security_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL,
  severity    TEXT    NOT NULL DEFAULT 'low' CHECK (severity IN ('low','medium','high','critical')),
  message     TEXT,
  ip          TEXT,
  path        TEXT,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER
);
CREATE INDEX idx_security_events_created ON security_events(created_at DESC);
CREATE INDEX idx_security_events_resolved ON security_events(resolved, created_at DESC);

---------------------------------------------------------------------
-- full-text search (0011: title + description + alt_titles)
---------------------------------------------------------------------
CREATE VIRTUAL TABLE series_search USING fts5 (
  title,
  description,
  alt_titles,
  tokenize = trigram
);
CREATE TRIGGER series_search_ai AFTER INSERT ON series BEGIN
  INSERT INTO series_search(rowid, title, description, alt_titles)
  VALUES (new.id, new.title, new.synopsis, new.alt_titles);
END;
CREATE TRIGGER series_search_ad AFTER DELETE ON series BEGIN
  DELETE FROM series_search WHERE rowid = old.id;
END;
CREATE TRIGGER series_search_au AFTER UPDATE ON series BEGIN
  DELETE FROM series_search WHERE rowid = new.id;
  INSERT INTO series_search(rowid, title, description, alt_titles)
  VALUES (new.id, new.title, new.synopsis, new.alt_titles);
END;

---------------------------------------------------------------------
-- B2 usage + temp objects + replication outbox + migration ledger
---------------------------------------------------------------------
CREATE TABLE b2_usage (
  account_name TEXT PRIMARY KEY,
  bytes        INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE b2_temp_objects (
  key         TEXT PRIMARY KEY,
  account_idx INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_b2_temp_objects_created ON b2_temp_objects(created_at);

CREATE TABLE _outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_url  TEXT NOT NULL,
  table_name TEXT NOT NULL,
  sql        TEXT NOT NULL,
  params     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_outbox_created ON _outbox (created_at);

CREATE TABLE _migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
