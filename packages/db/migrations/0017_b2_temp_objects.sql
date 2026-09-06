-- 0017_b2_temp_objects.sql
-- Registry upload temporer (identify uploads/*) untuk cleanup TTL oleh cron.
CREATE TABLE IF NOT EXISTS b2_temp_objects (
  key         TEXT PRIMARY KEY,
  account_idx INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_b2_temp_objects_created ON b2_temp_objects(created_at);
