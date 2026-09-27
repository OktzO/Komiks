CREATE TABLE IF NOT EXISTS novel_series (
  id               TEXT PRIMARY KEY,
  source_series_id TEXT NOT NULL,
  source           TEXT NOT NULL,
  title            TEXT NOT NULL,
  author           TEXT,
  genre            TEXT,
  status           TEXT,
  cover_ref        TEXT,
  cover_fallback   TEXT,
  synopsis         TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (source, source_series_id)
);

CREATE TABLE IF NOT EXISTS novel_chapters (
  id                TEXT PRIMARY KEY,
  series_id         TEXT NOT NULL,
  source_chapter_id TEXT NOT NULL,
  number            REAL NOT NULL,
  title             TEXT,
  content           TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  source_url        TEXT,
  scraped_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (series_id, source_chapter_id)
);

CREATE INDEX IF NOT EXISTS idx_novel_series_updated ON novel_series (updated_at);
CREATE INDEX IF NOT EXISTS idx_novel_chapters_series ON novel_chapters (series_id, number);
