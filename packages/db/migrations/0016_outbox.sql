CREATE TABLE IF NOT EXISTS _outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_url TEXT NOT NULL,
  table_name TEXT NOT NULL,
  sql TEXT NOT NULL,
  params TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON _outbox (created_at);
