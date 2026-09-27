# Menambah Akun B2 Baru (dan Akun Worker API)

> Untuk menambah/mengurangi **worker API** (perubahan jumlah peer `PEER_URLS`),
> ikuti `docs/DEPLOY.md` §11a (tambah) / §11b (hapus) — bukan daftar di bawah.
> Perubahan N me-remap semua shard `murmur3_32 % N`, jadi harus lewat maintenance
> window terkoordinasi, bukan langsung deploy.

## B2 storage (gambar komiku)

1. Buat bucket (misal `manga-images`) di Backblaze B2 akun baru
2. B2 application key: access **Read & Write** untuk bucket tsb
3. Update secret `B2_ACCOUNTS` di **semua worker** — tambah entry JSON
   (`name`/`bucket`/`keyId`/`appKey`/`region`). **Append di akhir array** —
   jangan reorder: `r2_account_idx` (-1, -2, ...) di `chapter_pages` memetakan
   posisi array, reorder = salah bucket. Set via raw API
   `PUT .../workers/scripts/{name}/secrets` (name `B2_ACCOUNTS`, type `secret_text`).
4. Urutan list TIDAK berpengaruh untuk correctness (hash pick deterministik
   by key), tapi jaga `B2_CONFIG` (legacy single) konsisten dengan
   `B2_ACCOUNTS[0]`
5. Triple-check: seluruh worker mendapat **nilai JSON yang identik** (hash
   pick + index mapping harus konsisten lintas worker)
6. Verifikasi: upload via `/api/reader/*` → `b2:usage:{idx}` bertambah di KV;
    `curl -I https://s3.<region>.backblazeb2.com/<bucket>/<key>` → 200

## Akun Worker API (origin round-robin)

- Provision via panel admin LB (auto-provision) atau manual
- ⚠️ Untuk menambah worker API: **`docs/DEPLOY.md` §11a** (maintenance window, deploy
  semua worker dengan `PEER_URLS` identik, verifikasi `?refresh=1`, baru enable origin)
- `CF_ACCOUNT_ID` / `CF_WORKER_NAME` / `CF_D1_ID` / `CF_KV_ID` di `wrangler.<baru>.toml`
  wajib diisi dari resource file itu sendiri — jangan copy-paste id akun lain
- **CORS checklist per akun baru:**
  - [ ] `ALLOWED_ORIGINS` memuat origin web yang benar-benar ter-deploy
        (`https://<manga-web-origin>`, plus `http://localhost:3000` untuk dev) —
        cek nama sebenarnya di dashboard / `apps/web/DEPLOY.md`
  - [ ] OPTIONS preflight → 204 + echo `Access-Control-Allow-Origin`
  - [ ] Header `x-admin-*` TIDAK boleh di-allow dari browser
  - [ ] `curl -H "Origin: https://<manga-web-origin>" -I <origin>/api/health`
        → header CORS ada
  - [ ] `curl -I <origin>/api/health` tanpa Origin → TIDAK ada header CORS
        (fail-closed)
- Endpoint yang boleh dipanggil lintas origin — allowlist persis di
  `apps/web/src/lib/api.ts` (`ORIGIN_PATH_ALLOWLIST`, dicocokkan dengan
  `path.startsWith`, jadi itu **prefix**, bukan path persis):
  `/api/reader/`, `/api/series`, `/api/search`, `/api/homepage`, `/api/health`,
  `/api/resolve`. Jadi `/api/series/:slug` ikut ter-cover oleh prefix
  `/api/series`. Yang **tidak** ada di allowlist (sengaja, hanya ke main API):
  `/api/source-status` — `source_health` dicatat per-akun jadi harus konsisten
  dari akun-1 — serta semua `/api/admin/*` dan `/api/scrape`, yang tidak pernah
  dipanggil dari klien. Tambah path baru? Tambah di `ORIGIN_PATH_ALLOWLIST`
  dulu, jangan di doc ini saja.

## Hash konsisten

Hash function = satu file `packages/shared/src/r2-routing.ts` (murmur3_32 +
`b2KeyFor`), di-import sisi scraper (Worker API) dan frontend (web worker
Astro). Tidak ada duplikasi → tidak ada drift.
