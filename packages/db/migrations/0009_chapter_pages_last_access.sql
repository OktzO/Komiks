-- Tambah kolom last_access ke chapter_pages untuk eviction LRU.
-- Eviction: hapus objek B2/R2 yang last_access > N hari (default 30) ketika quota > 80%.
-- Apply ke 3 D1.
ALTER TABLE chapter_pages ADD COLUMN last_access INTEGER;
CREATE INDEX IF NOT EXISTS idx_chapter_pages_last_access ON chapter_pages(last_access);
