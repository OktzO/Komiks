#!/usr/bin/env bash
# Usage: CF_TOKEN_AKUN{1..4} set in env; run: ./scripts/migrate-all-4.sh
# Applies 0001..0018 + backfill_entity_decode to all 4 D1; records _migrations ledger.
set -u
CFGS="apps/api-cf/wrangler.toml apps/api-cf/wrangler.origin.toml apps/api-cf/wrangler.origin3.toml apps/api-cf/wrangler.origin4.toml"
apply() {
  cfg="$1"; f="$2"
  [ -f "$f" ] || { echo "skip missing $f"; return 0; }
  if CLOUDFLARE_API_TOKEN="$tok" npx wrangler d1 execute manga-db --remote --file "$f" --config "$cfg"; then
    name="$(basename "$f")"
    CLOUDFLARE_API_TOKEN="$tok" npx wrangler d1 execute manga-db --remote --command "INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES ('$name', $(date +%s))" --config "$cfg" >/dev/null 2>&1 || true
  else
    echo "FAILED $cfg $f"
  fi
}
i=0
for cfg in $CFGS; do
  i=$((i + 1))
  eval "tok=\${CF_TOKEN_AKUN${i}:-}"
  if [ -z "${tok:-}" ]; then echo "skip $cfg: token AKUN$i unset"; continue; fi
  for f in packages/db/migrations/0018_*.sql; do apply "$cfg" "$f"; done
  for n in 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017; do
    for f in packages/db/migrations/${n}_*.sql; do
      [ -f "$f" ] || { echo "skip missing $n"; break; }
      apply "$cfg" "$f"
    done
  done
  apply "$cfg" "packages/db/migrations/backfill_entity_decode.sql"
done
