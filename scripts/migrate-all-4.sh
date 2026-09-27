#!/usr/bin/env bash
# Usage: CF_TOKEN_AKUN{1..4} set in env; run: ./scripts/migrate-all-4.sh
# Applies 0001..0020 + backfill_entity_decode to all 4 D1; records _migrations ledger.
# Each file is skipped when _migrations already lists it, so re-running is safe.
# 0018 (tabel _migrations) harus lebih dulu — ledger butuh tabel itu.
# 0019 (drop security_events) DIJALANKAN PALING AKHIR dari blok drop: backfill
# 0001..0017 menghidupkan lagi tabel via 0013_admin_dashboard.sql, jadi drop
# terakhir memastikan tak ada yang tersisa.
# 0020 (tambah kolom last_tested_at) dijalan setelah 0019. ALTER TABLE ADD COLUMN
# tidak idempoten, jadi dicek dulu lewat PRAGMA table_info(lb_accounts) dengan
# --json + sentinel "name": "last_tested_at" (match di key result, bukan echo).
# Catatan: ledger mengasumsikan tabel _migrations sudah ada (0018) DAN schema.sql
# baseline sudah di-apply sebelum numbered migrations — script tidak bisa
# membuat lb_accounts sendiri.
# Exit code: 0 hanya kalau semua config punya token dan tidak ada file yang
# gagal. Config tanpa CF_TOKEN_AKUN{i} dihitung sebagai failure (di-skip, tapi
# fleet itu tidak tuntas). Kegagalan tidak menghentikan run — operator lihat
# semua masalah sekaligus — tapi exit non-zero supaya tidak dipakai di chained
# command tanpa dicek.
# N-agnostik: daftar config wrangler dari WORKER_CFGS (whitespace-separated).
# Default = 4 akun saat ini. Token diambil dari CF_TOKEN_AKUN{i} per urutan
# index config (posisional). Tambah/kurangi config = set WORKER_CFGS.
# Contoh: WORKER_CFGS="a.toml b.toml" CF_TOKEN_AKUN1=... CF_TOKEN_AKUN2=... ./scripts/migrate-all-4.sh
set -u
WORKER_CFGS="${WORKER_CFGS:-apps/api-cf/wrangler.toml apps/api-cf/wrangler.origin.toml apps/api-cf/wrangler.origin3.toml apps/api-cf/wrangler.origin4.toml}"
# ledger_has <cfg> <nama-file>: exit 0 hanya kalau _migrations sudah berisi nama.
# Kalau tabel _migrations belum ada (DB baru), query gagal → exit != 0 → file dijalankan.
ledger_has() {
  CLOUDFLARE_API_TOKEN="$tok" npx wrangler d1 execute manga-db --remote --json \
    --command "SELECT 1 AS applied FROM _migrations WHERE name = '$2' LIMIT 1" --config "$1" 2>/dev/null \
    | grep -q '"applied":'
}
record() {
  CLOUDFLARE_API_TOKEN="$tok" npx wrangler d1 execute manga-db --remote \
    --command "INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES ('$2', $(date +%s))" \
    --config "$1" >/dev/null 2>&1 || true
}
apply() {
  cfg="$1"; f="$2"
  [ -f "$f" ] || { echo "skip missing $f"; return 0; }
  name="$(basename "$f")"
  if ledger_has "$cfg" "$name"; then
    echo "skip $cfg $name: already applied"
    return 0
  fi
  if CLOUDFLARE_API_TOKEN="$tok" npx wrangler d1 execute manga-db --remote --file "$f" --config "$cfg"; then
    record "$cfg" "$name"
  else
    echo "FAILED $cfg $f"
    failures=$((failures + 1))
  fi
}
apply_0020() {
  cfg="$1"; f="packages/db/migrations/0020_admin_inventory.sql"
  [ -f "$f" ] || { echo "skip missing $f"; return 0; }
  name="$(basename "$f")"
  if ledger_has "$cfg" "$name"; then
    echo "skip $cfg $name: already applied"
    return 0
  fi
  if CLOUDFLARE_API_TOKEN="$tok" npx wrangler d1 execute manga-db --remote --json \
    --command "PRAGMA table_info(lb_accounts)" --config "$cfg" 2>/dev/null \
    | grep -qE '"name":[[:space:]]*"last_tested_at"'; then
    echo "skip $cfg $name: last_tested_at already present"
    return 0
  fi
  apply "$cfg" "$f"
}
failures=0
i=0
for cfg in $WORKER_CFGS; do
  i=$((i + 1))
  eval "tok=\${CF_TOKEN_AKUN${i}:-}"
  if [ -z "${tok:-}" ]; then
    echo "skip $cfg: token AKUN$i unset"
    failures=$((failures + 1))
    continue
  fi
  for f in packages/db/migrations/0018_*.sql; do apply "$cfg" "$f"; done
  for n in 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017; do
    for f in packages/db/migrations/${n}_*.sql; do
      [ -f "$f" ] || { echo "skip missing $n"; break; }
      apply "$cfg" "$f"
    done
  done
  apply "$cfg" "packages/db/migrations/backfill_entity_decode.sql"
  for f in packages/db/migrations/0019_*.sql; do apply "$cfg" "$f"; done
  apply_0020 "$cfg"
done
if [ "$failures" -gt 0 ]; then
  echo "aborted: $failures migration(s) failed — see FAILED lines above"
  exit 1
fi
echo "ok: all migrations applied or already present"
