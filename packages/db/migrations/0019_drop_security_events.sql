-- 0019: hapus fitur security alerts sepenuhnya (tabel + index + data).
-- Penulis/pembaca sudah dihapus dari kode (api-cf, admin UI).
DROP INDEX IF EXISTS idx_security_events_created;
DROP INDEX IF EXISTS idx_security_events_resolved;
DROP TABLE IF EXISTS security_events;