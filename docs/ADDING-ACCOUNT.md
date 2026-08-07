# Menambah Akun R2 Baru (dan Akun Worker API)

## R2 storage (gambar komiku)

1. Buat bucket `manga-images` di akun Cloudflare baru
2. R2 API token: permission **Object Read & Write**, scope bucket tsb
   (bukan Admin)
3. Custom domain `cdnN.example.com` → bucket (butuh zone di akun tsb)
4. Lifecycle rule prefix `komiku/` → `Expiration.Days = R2_EVICTION_DAYS`
   (default 30 — lihat `scripts/setup-r2-account.mjs`)
5. Update secret `R2_ACCOUNTS` (Worker primary) + `NEXT_PUBLIC_R2_DOMAINS`
   (web) — **urutan list WAJIB sama** (index akun = identitas hash)
6. Jalankan `node scripts/setup-r2-account.mjs` untuk panduan + remap report
7. Verifikasi: `curl -I https://cdnN.example.com/<key>` → 200

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

## Verifikasi hash konsisten

Hash function = satu file `packages/shared/src/r2-routing.ts`, di-import
sisi scraper (Worker) dan frontend (Pages). Tidak ada duplikasi → tidak ada
drift. Konfirmasi urutan domain di `R2_ACCOUNTS` dan
`NEXT_PUBLIC_R2_DOMAINS` identik.