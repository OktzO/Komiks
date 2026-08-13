-- Session store untuk signed-cookie auth (KV-free).
-- Cookie payload berisi sid + uid + email + role + iat + exp (HMAC-signed).
-- D1 `sessions` tabel = revocation list: row ada = valid; revoked_at NOT NULL = logout.
-- Lazy revocation: getSessionUser cek D1 row revoked_at, gak rely on KV TTL.
-- Apply ke 3 D1 (akun-1 main + akun-2 origin + akun-3 new).
CREATE TABLE IF NOT EXISTS sessions (
  sid         TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  ua          TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
