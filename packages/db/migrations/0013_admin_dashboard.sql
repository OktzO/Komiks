-- 0013_admin_dashboard.sql
-- Admin dashboard data layer: user moderation status + security event feed.

-- users: moderation status (active/suspended/banned). Existing rows = active.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned'));

-- security_events: append-only feed of rate-limit triggers / blocked origins /
-- suspicious patterns. Written best-effort by middleware + admin routes.
CREATE TABLE IF NOT EXISTS security_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL,           -- rate_limit | blocked_origin | suspicious | manual
  severity    TEXT    NOT NULL DEFAULT 'low' CHECK (severity IN ('low','medium','high','critical')),
  message     TEXT,
  ip          TEXT,
  path        TEXT,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_resolved ON security_events(resolved, created_at DESC);
