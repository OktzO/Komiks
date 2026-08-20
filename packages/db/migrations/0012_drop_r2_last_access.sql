-- Drop orphan table r2_last_access.
-- Tabel ini dibuat di migration 0002 (era R2 multi-account) untuk track last
-- access per r2_key. Setelah migrasi ke B2 cache-aside (per chapter_pages
-- row, bukan per r2_key global), tracking last_access pindah ke kolom
-- chapter_pages.last_access (migration 0009). Tabel r2_last_access sudah tidak
-- dipakai kode mana pun — hapus dari schema.
DROP TABLE IF EXISTS r2_last_access;
DROP INDEX IF EXISTS idx_r2_last_access_view;
