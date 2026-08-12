-- Drop FK chapter_pages.chapter_id → chapters(id) supaya cache-aside
-- upload storage marker (B2/R2) bisa di-insert meskipun chapter belum
-- pernah di-index ke D1 chapters table (auto-index saat ini hanya untuk
-- series row, chapter row dibuat on-the-fly oleh adapter tanpa persist).
-- Idempoten: aman di-run ulang (IF EXISTS). Tiap statement auto-commit
-- (D1 tidak izinkan BEGIN/COMMIT eksplisit via wrangler d1 execute).
PRAGMA foreign_keys=off;
CREATE TABLE IF NOT EXISTS chapter_pages_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id      TEXT    NOT NULL,
  page_number     INTEGER NOT NULL,
  image_url       TEXT    NOT NULL,
  r2_key          TEXT,
  r2_account_idx  INTEGER,
  UNIQUE (chapter_id, page_number)
);
INSERT OR IGNORE INTO chapter_pages_new (id, chapter_id, page_number, image_url, r2_key, r2_account_idx)
  SELECT id, chapter_id, page_number, image_url, r2_key, r2_account_idx FROM chapter_pages;
DROP TABLE chapter_pages;
ALTER TABLE chapter_pages_new RENAME TO chapter_pages;
CREATE INDEX IF NOT EXISTS idx_chapter_pages_chapter ON chapter_pages(chapter_id);
PRAGMA foreign_keys=on;
