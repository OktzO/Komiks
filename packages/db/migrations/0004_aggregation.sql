-- Manga aggregation: multi-source links + manual merge queue.
-- series table remains the canonical entity; manga_source_link maps a series
-- to (source, source_slug) rows from each upstream site.

ALTER TABLE series ADD COLUMN alt_titles TEXT;  -- JSON array string

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
  candidate_ids TEXT    NOT NULL,   -- JSON array of series.id candidates
  confidence    REAL    NOT NULL,   -- 0..1
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','rejected')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at   INTEGER
);
CREATE INDEX idx_mq_status ON manga_merge_queue(status);