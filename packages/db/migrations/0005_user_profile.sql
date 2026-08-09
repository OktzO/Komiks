-- 0005_user_profile.sql — user profile columns + default LB data (2 akun + 2 origins).
-- Idempotent: ALTER TABLE safe-rerun not supported by SQLite (ADD COLUMN errors if exists);
-- seed uses INSERT OR IGNORE so re-runs are no-op.

-- ---------------------------------------------------------------
-- ALTER users: profile columns
-- ---------------------------------------------------------------
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN avatar_url   TEXT;
ALTER TABLE users ADD COLUMN bio          TEXT;
ALTER TABLE users ADD COLUMN preferences  TEXT NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------
-- Seed LB defaults (idempotent INSERT OR IGNORE)
-- ---------------------------------------------------------------

-- 1. lb_settings: default 'on', implementation 'custom'
INSERT OR IGNORE INTO lb_settings (id, mode, implementation, steering_policy, health_check_interval_sec, health_check_timeout_ms, failure_threshold)
VALUES (1, 'on', 'custom', 'failover', 30, 3000, 2);

-- 2. lb_accounts: 2 entry
--    encrypted_token seeded as empty blob X'' — Worker must handle gracefully (skip decrypt).
INSERT OR IGNORE INTO lb_accounts (id, provider, label, account_ref, encrypted_token, token_last4, status, created_at)
VALUES
  ('acc_main_oktz',       'cloudflare', 'Akun 1 (main)',         '4ce21aec2dd478bf380b7b59990a9165', X'', '****', 'verified', unixepoch()),
  ('acc_origin_tzok5555', 'cloudflare', 'Akun 2 (LB origin)',    '6a0bdfb8bccff744bd738a57502d0380', X'', '****', 'verified', unixepoch());

-- 3. lb_origins: 2 entry (satu per akun, weight=1 default)
INSERT OR IGNORE INTO lb_origins (id, account_id, origin_url, priority, weight, enabled, created_at)
VALUES
  ('ori_main',   'acc_main_oktz',      'https://manga-api.oktz.workers.dev', 0, 1, 1, unixepoch()),
  ('ori_tzok5555', 'acc_origin_tzok5555', 'https://manga-api-2.tzok5555.workers.dev', 1, 1, 1, unixepoch());
