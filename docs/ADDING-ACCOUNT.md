# Menambah Akun B2 Baru (dan Akun Worker API)

## B2 storage (gambar komiku)

1. Buat bucket (misal `manga-images`) di Backblaze B2 akun baru
2. B2 application key: access **Read & Write** untuk bucket tsb
3. Update secret `B2_ACCOUNTS` di **semua 3 worker** — tambah entry JSON
   (`name`/`bucket`/`keyId`/`appKey`/`region`)
4. Urutan list TIDAK berpengaruh untuk correctness (hash pick deterministik
   by key), tapi jaga `B2_CONFIG` (legacy single) konsisten dengan
   `B2_ACCOUNTS[0]`
5. Verifikasi: upload via `/api/reader/*` → `b2:usage:{idx}` bertambah di KV;
   `curl -I https://s3.<region>.backblazeb2.com/<bucket>/<key>` → 200

## Akun Worker API (origin round-robin)

- Provision via panel admin LB (auto-provision) atau manual
- **CORS checklist per akun baru:**
  - [ ] `ALLOWED_ORIGINS` = `https://manga-web-d32.pages.dev,http://localhost:3000`
  - [ ] OPTIONS preflight → 204 + echo `Access-Control-Allow-Origin`
  - [ ] Header `x-admin-*` TIDAK boleh di-allow dari browser
  - [ ] `curl -H "Origin: https://manga-web-d32.pages.dev" -I <origin>/api/health`
        → header CORS ada
  - [ ] `curl -I <origin>/api/health` tanpa Origin → TIDAK ada header CORS
        (fail-closed)
- Endpoint publik yang dipakai frontend (allowlist path di
  `apps/web/lib/api.ts`): `/api/health`, `/api/search`, `/api/series`,
  `/api/series/:slug`, `/api/manga/:id`, `/api/reader/*`,
  `/api/source-status` — endpoint admin (`/api/admin/*`, `/api/scrape`)
  tidak pernah dipanggil dari klien.

## Hash konsisten

Hash function = satu file `packages/shared/src/r2-routing.ts` (murmur3_32 +
`b2KeyFor`), di-import sisi scraper (Worker) dan frontend (Pages). Tidak ada
duplikasi → tidak ada drift.
