-- R2 multi-account storage: r2 key per halaman + last-access + LB quota.

ALTER TABLE chapter_pages ADD COLUMN r2_key TEXT;
ALTER TABLE chapter_pages ADD COLUMN r2_account_idx INTEGER;

-- Last-accessed per R2 object (chapter-view granularity, bukan per-page-view).
CREATE TABLE IF NOT EXISTS r2_last_access (
  r2_key       TEXT PRIMARY KEY,
  account_idx  INTEGER NOT NULL,
  last_viewed  INTEGER NOT NULL,   -- unix ms
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_r2_last_access_view ON r2_last_access(last_viewed);

-- Quota tracking round-robin API: 1 baris per origin per hari.
-- Composite PK (bukan account_id tunggal) supaya 1 origin punya 1 baris/hari.
CREATE TABLE IF NOT EXISTS lb_usage (
  origin_url   TEXT NOT NULL,
  date_key     TEXT NOT NULL,      -- 'YYYY-MM-DD'
  req_count    INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (origin_url, date_key)
);