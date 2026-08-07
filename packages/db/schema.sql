-- Manga Platform canonical D1 schema
-- SQLite-native (D1 runs via `wrangler d1 execute --file=...`); FTS5 supported in D1.

---------------------------------------------------------------------
-- series
---------------------------------------------------------------------
CREATE TABLE series (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    UNIQUE NOT NULL,
  external_id   TEXT,                       -- source external id (e.g. komiku slug)
  source        TEXT    NOT NULL DEFAULT 'komiku',
  title         TEXT    NOT NULL,
  synopsis      TEXT,                       -- mapped to FTS5 `description` column
  type          TEXT    NOT NULL CHECK (type IN ('manga', 'manhwa', 'manhua')),
  status        TEXT    NOT NULL CHECK (status IN ('ongoing', 'completed', 'hiatus', 'cancelled')),
  author        TEXT,
  artist        TEXT,
  cover_image   TEXT,
  genres        TEXT,                       -- JSON array string: '["action","isekai"]'
  tags          TEXT,                       -- JSON array string
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

---------------------------------------------------------------------
-- chapters
---------------------------------------------------------------------
CREATE TABLE chapters (
  id            TEXT    PRIMARY KEY,        -- e.g. '<external_id>@<lang>' or uuid
  series_slug   TEXT    NOT NULL REFERENCES series (slug) ON DELETE CASCADE,
  chapter_number REAL  NOT NULL,            -- allows 0.5 etc
  volume        TEXT,
  title         TEXT,
  language      TEXT    NOT NULL DEFAULT 'en',
  pages_count   INTEGER NOT NULL DEFAULT 0,
  published_at  INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_chapters_series_slug ON chapters(series_slug);

---------------------------------------------------------------------
-- chapter_pages
---------------------------------------------------------------------
CREATE TABLE chapter_pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id    TEXT    NOT NULL REFERENCES chapters (id) ON DELETE CASCADE,
  page_number   INTEGER NOT NULL,
  image_url     TEXT    NOT NULL,
  UNIQUE (chapter_id, page_number)
);
CREATE INDEX idx_pages_chapter_id ON chapter_pages(chapter_id);

---------------------------------------------------------------------
-- users
---------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    UNIQUE NOT NULL,
  name          TEXT,
  password_hash TEXT,
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

---------------------------------------------------------------------
-- bookmarks
---------------------------------------------------------------------
CREATE TABLE bookmarks (
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  series_slug   TEXT    NOT NULL REFERENCES series (slug) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, series_slug)
);

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
-- full-text search: simple shadow table over series (title, synopsis->description)
-- series.synopsis is mirrored into series_search.description via sync triggers.
---------------------------------------------------------------------
CREATE VIRTUAL TABLE series_search USING fts5 (
  title,
  description,
  tokenize = trigram
);
-- keep the shadow in sync with series (series.synopsis -> series_search.description)
CREATE TRIGGER series_search_ai AFTER INSERT ON series BEGIN
  INSERT INTO series_search(rowid, title, description)
  VALUES (new.id, new.title, new.synopsis);
END;
CREATE TRIGGER series_search_ad AFTER DELETE ON series BEGIN
  DELETE FROM series_search WHERE rowid = old.id;
END;
CREATE TRIGGER series_search_au AFTER UPDATE ON series BEGIN
  DELETE FROM series_search WHERE rowid = new.id;
  INSERT INTO series_search(rowid, title, description)
  VALUES (new.id, new.title, new.synopsis);
END;
