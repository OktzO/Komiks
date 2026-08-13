#!/usr/bin/env bash
# Set secrets di akun-2 + akun-3 (sync dari akun-1 yang sudah ada).
# Usage: SECRETS_JSON='{"GOOGLE_CLIENT_ID":"...","GOOGLE_CLIENT_SECRET":"...","LB_ENCRYPTION_KEY":"...","ALLOWED_ORIGINS":"...","ADMIN_EMAILS":"...","B2_ACCOUNTS":"[...]","R2_ACCOUNTS":"[...]","SCRAPE_API_KEY":"...","ADMIN_PASSWORD_HASH":"..."}' ./scripts/sync-secrets.sh
#
# Atau set env var individual:
#   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx LB_ENCRYPTION_KEY=xxx \
#   ALLOWED_ORIGINS=xxx ADMIN_EMAILS=xxx B2_ACCOUNTS='[...]' R2_ACCOUNTS='[...]' \
#   SCRAPE_API_KEY=xxx ADMIN_PASSWORD_HASH=xxx ./scripts/sync-secrets.sh
set -euo pipefail

# Tokens
TOKEN2="***REMOVED***"
TOKEN3="***REMOVED***"

# Helper: set secret via wrangler
set_secret() {
  local token="$1" config="$2" name="$3" value="$4"
  echo "  Setting $name..."
  echo -n "$value" | CLOUDFLARE_API_TOKEN="$token" npx wrangler secret put "$name" --config "$config" 2>&1 | tail -1
}

# Secrets to sync
SECRET_NAMES=(
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  LB_ENCRYPTION_KEY
  ALLOWED_ORIGINS
  ADMIN_EMAILS
  B2_ACCOUNTS
  R2_ACCOUNTS
  SCRAPE_API_KEY
  ADMIN_PASSWORD_HASH
)

echo "=== Setting secrets for akun-2 (manga-api-2) ==="
for name in "${SECRET_NAMES[@]}"; do
  value="${!name:-}"
  if [ -z "$value" ]; then
    echo "  SKIP $name (not set)"
    continue
  fi
  set_secret "$TOKEN2" "apps/api-cf/wrangler.origin.toml" "$name" "$value"
done

echo "=== Setting secrets for akun-3 (manga-api-3) ==="
for name in "${SECRET_NAMES[@]}"; do
  value="${!name:-}"
  if [ -z "$value" ]; then
    echo "  SKIP $name (not set)"
    continue
  fi
  set_secret "$TOKEN3" "apps/api-cf/wrangler.origin3.toml" "$name" "$value"
done

echo "=== Done. Test with: ==="
echo "  curl -s https://manga-api-2.tzok5555.workers.dev/api/auth/google?origin=https://oktzz.xyz"
