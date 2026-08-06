-- 0001_manga_data.sql — additive migration for data-api service.
-- Reuses existing series + chapters tables from packages/db/schema.sql.

ALTER TABLE series ADD COLUMN alt_titles TEXT;
ALTER TABLE series ADD COLUMN source_url TEXT;
ALTER TABLE series ADD COLUMN cover_r2_key TEXT;
ALTER TABLE series ADD COLUMN language TEXT;

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
