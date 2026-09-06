-- 0014_b2_idx_backfill.sql
-- Bersihkan baris era R2 legacy (idx >= 0 tak pernah ter-serve/evict) agar re-upload sehat.
-- Idempoten: guard WHERE membuat re-run menjadi no-op.
UPDATE chapter_pages SET r2_key = NULL, r2_account_idx = NULL WHERE r2_account_idx >= 0;
