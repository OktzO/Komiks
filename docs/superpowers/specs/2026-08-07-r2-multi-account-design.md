# R2 Multi-Account Storage & Routing — Design Spec

Date: 2026-08-07
Status: Approved (brainstorming) — diimplementasikan langsung atas permintaan user (auto-pilot)

## 1. Ringkasan & Keputusan Kunci

Sistem storage gambar multi-akun Cloudflare R2 untuk manga-web. Gambar chapter Komiku di-scrape, di-upload ke R2 bucket milik N akun Cloudflare, diserve langsung dari custom domain per-akun (tanpa lewat Worker). Hash-based routing dengan consistent hashing.

**Keputusan yang sudah dikunci user:**
1. **Rehost Komiku saja** — MangaDex tetap 100% proxy (ToS MangaDex melarang rehost; prinsip project lama "gambar tidak pernah di-rehost" diubah untuk Komiku saja).
2. **R2-first + proxy fallback** — reader coba fetch R2 langsung; 404 → fallback proxy path lama, upload background via `waitUntil`. User tidak pernah lihat error cache-miss.
3. **Upload asli, kompresi ditunda** — riset docs: Free plan Workers CPU = 10ms/request → encode WebP/AVIF via WASM tidak feasible. Cloudflare Images gratis cuma 5.000 gambar/bulan. Upgrade path: pindah scraper ke paid plan (CPU 30s) + encoder WASM, atau Images Transformations on-delivery.

**Fakta limit terverifikasi dari docs (akses 2026-08-07):**
- Workers Free: 100k req/day, **50 subrequests/invocation** (termasuk R2/KV/D1), **CPU 10ms/req**, 128MB memori, 64 env var, 5KB/var, bundle 3MB gzip.
- KV Free: 100k reads/day, **1.000 writes/day**, 1 write/s/key, 1GB/akun, **eventually consistent** (nilai lama kebaca sampai cache TTL).
- D1 Free: 10 DB, 500MB/DB, 5GB/akun, **50 queries/invocation**, single-threaded (~1ms/query → ~1.000 qps). Tidak ada daily quota eksplisit — limit per-invocation.
- R2 Free: **10GB-month/akun**, 1M Class A ops (writes), 10M Class B ops (reads/head), egress gratis. Lifecycle rule hanya berbasis umur (`Expiration.Days`). **Free tier tidak berlaku untuk Infrequent Access** (STANDARD_IA $0.01/GB + minimum 30 hari). `r2.dev` rate-limited, custom domain wajib untuk produksi. S3-compatible API untuk cross-account (endpoint `https://{account_id}.r2.cloudflarestorage.com`).

## 2. Arsitektur & Alur Data

```
                    ┌─────────────────────────────────────────────┐
                    │         AKUN CF PRIMARY (manga-api)          │
                    │  Worker: scrape/reader/api + D1 + KV        │
                    └──────┬──────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────────────────┐
        │                  │                              │
   Scraper path      Reader path (miss)              API round-robin
   (upload R2)       (proxy fallback +                  (existing LB)
   S3 API cross-    upload background)
   account upload
        │                  │
   ┌────▼────┐        ┌────▼────┐                    ┌──────────┐
   │ AKUN 1  │        │ AKUN 2  │   ... N akun       │ Origin   │
   │ R2 bucket│       │ R2 bucket│                    │ Workers  │
   │ cdn1.dom│        │ cdn2.dom│                    │ api1..N  │
   └────┬────┘        └────┬────┘                    └──────────┘
        └────────┬─────────┘
                 │
        User browser → frontend Pages → hash(manga_slug) → ring
                 → fetch langsung dari cdnN.dom (TANPA Worker)
```

**Alur inti:**
1. **Scraper** (primary Worker, `/api/scrape` source=komiku): scrape chapter → untuk tiap halaman: fetch `img.komiku.org` (Referer header) → stream upload via S3 API ke bucket akun hasil `hash(slug)` → key deterministik `komiku/{slug}/{chapterId}/{pageNo}.{ext}` → upsert D1 `chapter_pages.r2_key` + `r2_account_idx`.
2. **Reader** (frontend): hitung `hash(slug)` dari URL halaman → pilih domain `cdnN` → `fetch` gambar langsung dari R2 public. Worker tidak tersentuh untuk serving gambar.
3. **Cache-miss** (404/network di R2): frontend fallback ke proxy path lama `/api/reader/komiku/page/{chapterId}/{pageNo}` → Worker fetch Komiku + serve + `waitUntil` upload ke R2 (key sama, idempoten). Request berikutnya langsung R2.
4. **MangaDex**: tetap 100% proxy (tidak di-hash, tidak di-upload).
5. **D1 + KV**: tetap satu di primary, tidak di-shard.

**Hash key = slug manga** (semua chapter satu manga → satu akun). Trade-off (dokumentasikan di komentar kode): koherensi 1 manga di 1 domain (CDN cache + connection reuse, delete/migrasi per manga mudah) vs beban miring kalau ada manga super populer. Per-chapter hashing lebih merata tapi YAGNI.

## 3. Consistent Hashing (shared package)

- **File**: `packages/shared/src/r2-routing.ts` + test (`packages/shared/test/r2-routing.test.mjs`). Satu sumber kebenaran, di-import oleh scraper Worker (`apps/api-cf`) dan frontend Pages (`apps/web`). Tidak ada duplikasi kode → tidak ada drift.
- **Algoritma**: MurmurHash3 32-bit pure JS (tanpa dep, ~30 baris) → ring `2^32`; tiap akun diwakili N virtual node (default 32, configurable) → cari node pertama searah jarum jam setelah `hash(key)`.
- **Trade-off ring vs modulo** (di komentar kode): modulo remap ~semua manga saat jumlah akun berubah; ring cuma remap key di antara node baru dan tetangganya (~1/N bagian). Harga: overhead CPU kecil + distribusi bergantung jumlah virtual node.
- **API**:
  - `hashToAccount(key: string, accounts: readonly string[]): number` — index akun untuk key.
  - `buildRing(accounts: readonly string[], vnodes?: number): RingNode[]` — struktur ring (export untuk test).
  - `generateRemapReport(oldAccounts, newAccounts, sampleKeys)` — util offline untuk migrasi: output list key yang pindah + arahnya.
- **Identitas akun = urutan daftar domain** (`accounts[i]`), bukan nama akun. Sumber: scraper dapat dari secret `R2_ACCOUNTS` (JSON), frontend dari env `NEXT_PUBLIC_R2_DOMAINS`. Urutan WAJIB sama — diverifikasi setup script + smoke test.
- **Test**: hash deterministik lintas env (pure function), distribusi ring (sampling), remap report (simulasi 2→3 akun → proporsi pindah ≈ 1/N).

## 4. Config & Provisioning Multi-Akun

Semua konfigurasi env var/secret, nol hardcode.

**Worker (primary, `apps/api-cf`):**
- `R2_ACCOUNTS` (secret, JSON) — 1 var, bukan 3/akun (batas 64 env var/Worker):
  ```json
  [
    {"account_id": "...", "access_key_id": "...", "secret_access_key": "...", "public_domain": "cdn1.example.com"},
    {"account_id": "...", "access_key_id": "...", "secret_access_key": "...", "public_domain": "cdn2.example.com"}
  ]
  ```
  Access key = R2 API token S3-compatible per akun (dashboard/`wrangler r2 token create`). ~200 byte/akun → 20 akun ≈ 4KB < 5KB.
- `R2_EVICTION_DAYS` (text var, default `30`) — dipakai saat provisioning lifecycle rule.
- `R2_RING_VNODES` (text var, default `32`).

**Frontend (`apps/web/.env.production`):**
- `NEXT_PUBLIC_R2_DOMAINS=cdn1.example.com,cdn2.example.com` — urutan = index akun, harus sama dengan urutan `R2_ACCOUNTS`.

**Provisioning akun baru** — `scripts/setup-r2-account.mjs` + `docs/ADDING-ACCOUNT.md`:
1. `wrangler r2 bucket create manga-images`
2. Buat R2 API token (access key) manual di dashboard — jangan masuk script
3. `wrangler r2 bucket lifecycle set` — rule `Expiration.Days = R2_EVICTION_DAYS`, prefix `komiku/`
4. Hubungkan custom domain `cdnN.example.com` ke bucket (dashboard, butuh zone di akun tsb)
5. Tambah entry `R2_ACCOUNTS` + `NEXT_PUBLIC_R2_DOMAINS` (urutan konsisten)
6. Jalankan `generateRemapReport` → cek manga yang pindah → re-scrape on-demand otomatis via cache-aside (tanpa aksi manual)
7. Verifikasi: `curl -I https://cdnN.example.com/<test-object>` → 200

Catatan: lifecycle rule = bucket-level, di-set saat provisioning (wrangler CLI), bukan runtime env — angka dari `R2_EVICTION_DAYS` saat script jalan.

## 5. Scraper Upload & Cache-Aside Fallback

**Upload** (di `packages/sources/komiku` scrape flow + route `/api/scrape`):
- Saat scrape chapter Komiku: untuk tiap halaman — fetch `img.komiku.org` (Referer header), stream body langsung ke R2 target via S3 API, key `komiku/{slug}/{chapterId}/{pageNo}.{ext}`. Tanpa lookup table — key deterministik dari identitas chapter.
- Setelah sukses: upsert `chapter_pages` dengan `r2_key` + `r2_account_idx` (ON CONFLICT DO NOTHING).
- Budget subrequest: 1 chapter ≈ 30 halaman ≈ 30 uploads < 50/invocation. Kalau chapter > 40 halaman (jarang), proses halaman dalam 1 request dengan early-exit — catat limitation, upgrade path: split jadi 2 batch request.
- Gagal sebagian → serve sisanya; halaman gagal di-re-fetch saat miss berikutnya (idempoten).
- S3 client: implementasi minimal via `fetch` (signing AWS SigV4) — atau `@aws-sdk/client-s3`? **Keputusan: implementasi SigV4 minimal sendiri** (~80 baris) supaya bundle tetap kecil (3MB gzip limit) — `@aws-sdk` menambah ratusan KB ke bundle Worker yang di-auto-provision ke banyak akun. `ponytail:` ganti SDK kalau fitur S3 bertambah (multipart, dll).

**Fallback cache-aside** (route `/api/reader/:source/page/:chapterId/:pageNo`, source=komiku):
- Frontend R2-first: hitung domain dari slug → GET `https://cdnN/key`. **404/network error** → panggil proxy path existing.
- Worker: resolve slug dari `chapterId` (parse `-chapter-` atau query D1 `chapters.series_slug`, cache KV) → fetch Komiku → serve → `waitUntil`: upload R2 (key sama) + upsert D1.
- Race: 2 request paralel ke halaman sama → keduanya upload key sama → aman (overwrite idempoten, max 1 write/s/key).

## 6. D1 Schema & Eviction

Migration baru `packages/db/migrations/0002_r2_storage.sql` (primary account saja):

```sql
ALTER TABLE chapter_pages ADD COLUMN r2_key TEXT;
ALTER TABLE chapter_pages ADD COLUMN r2_account_idx INTEGER;

CREATE TABLE IF NOT EXISTS r2_last_access (
  r2_key       TEXT PRIMARY KEY,
  account_idx  INTEGER NOT NULL,
  last_viewed  INTEGER NOT NULL,   -- unix ms
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_r2_last_access_view ON r2_last_access(last_viewed);
```

**Eviction — umur absolut, bukan LRU manual:**
1. **R2 Object Lifecycle Rule**: `Expiration.Days = R2_EVICTION_DAYS` (default 30) — auto-delete gratis, tanpa Worker.
2. **`r2_last_access` di D1**: ditulis sekali per chapter-view (bukan per-page-view) — batch upsert semua halaman chapter itu (1 query). Kegunaan: laporan, migrasi, cek manga "hidup" sebelum remap akun.

**Kenapa bukan LRU manual (delete paling lama diakses):** lifecycle R2 hanya umur-based; LRU butuh ListObjects + delete = Class A ops termeter + Worker CPU + kompleksitas. Manfaat kecil karena cache-miss sudah di-handle cache-aside (gambar ke-evict di-fetch ulang otomatis). Trade-off dicatat di komentar kode. Upgrade path: cron paid plan + D1 query stale → S3 batch delete.

**Upsert hemat write:** scrape ulang → `INSERT ... ON CONFLICT(chapter_id, page_number) DO NOTHING` untuk page yang sudah ada; tidak ada insert ulang per run.

## 7. KV Cache & Quota Tracking

**KV (existing, tidak berubah):** cache query populer tetap di KV (search 120s, series 600s, origins 30s). KV **bukan** untuk counter — eventually consistent + 1.000 writes/day Free.

**Quota tracking round-robin API → D1** (bukan KV, bukan Durable Object):

```sql
CREATE TABLE IF NOT EXISTS lb_usage (
  account_id    TEXT PRIMARY KEY,
  date_key      TEXT NOT NULL,      -- 'YYYY-MM-DD'
  req_count     INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
```

- Update: `INSERT ... ON CONFLICT(account_id) DO UPDATE SET req_count = req_count + 1` — 1 query per request API. D1 single-threaded 1ms/query ≈ 1.000 qps — jauh di atas kebutuhan.
- **Kenapa bukan Durable Object**: DO stateful + storage DO termeter + complexity; D1 sudah ada + transactional. DO layak hanya kalau >1.000 qps pada satu akun (tidak realistis free tier) — komentar kode.
- Reset harian natural: `WHERE date_key = today`. Writes ke D1 aman (bukan daily quota, per-invocation limit).

## 8. Round-Robin API & CORS Checklist

**Existing** (`apps/web/lib/api.ts` + `packages/lb/router.ts`): `getOrigins()` cache 60s, `apiWithFailover()`, lazy health check 5s. **Gap yang ditutup:**
1. Health-aware fallback eksplisit: skip origin saat 429/5xx/timeout, retry max 2x, circuit breaker per origin di sessionStorage (2 gagal beruntun → skip 60s).
2. Timeout per origin: `AbortController` 8s.
3. **Audit endpoint publik**: origin list hanya berisi route baca (search/reader/series/manga/source-status) — enforce allowlist path di `lib/api.ts`; endpoint admin tidak pernah dipanggil dari frontend. Checklist per akun baru di `docs/ADDING-ACCOUNT.md`.
4. **CORS checklist per akun baru**:
   - [ ] `ALLOWED_ORIGINS` origin Worker = domain Pages (`https://manga-web-d32.pages.dev`, `http://localhost:3000`)
   - [ ] OPTIONS preflight → 204 + echo `Access-Control-Allow-Origin`
   - [ ] Header admin (`x-admin-*`) TIDAK di-allow dari browser
   - [ ] Verifikasi: `curl -H "Origin: https://manga-web-d32.pages.dev" -I <origin>/api/health` → CORS header benar

## 9. Keamanan & ToS

- Kredensial R2 hanya di `R2_ACCOUNTS` (secret Worker), tidak pernah masuk bundle frontend. `NEXT_PUBLIC_R2_DOMAINS` cuma domain publik (read-only), aman.
- Token R2 per akun = permission Object Read & Write minimum (bukan admin akun). Bucket public read = tujuan; write hanya via S3 token, tidak ada upload endpoint publik.
- Rehost Komiku: keputusan user (source tidak punya ToS API ketat; MangaDex tetap proxy).
- **ToS review manual wajib sebelum production live** (di luar scope kode): `docs/TOS-REVIEW.md` — verifikasi Acceptable Use Policy Cloudflare terkini soal multi-account untuk lipat kuota free tier.

## 10. Deliverables & Testing

| Item | Lokasi |
|---|---|
| Hash ring (MurmurHash3 + ring + remap) | `packages/shared/src/r2-routing.ts` + test |
| Config env | `R2_ACCOUNTS`, `R2_EVICTION_DAYS`, `R2_RING_VNODES`, `NEXT_PUBLIC_R2_DOMAINS` |
| Migration D1 | `packages/db/migrations/0002_r2_storage.sql` + schema.sql update |
| DB helpers | `packages/db/index.ts` (markR2Uploaded, touchLastAccess, quota incr) |
| Upload scraper Komiku | `packages/sources/komiku/` + `routes/admin/scrape.ts` |
| Fallback cache-aside reader | `routes/reader.ts` |
| R2-first frontend fetch | `apps/web/lib/api.ts` + `components/Reader.tsx` |
| Quota LB di D1 | `packages/db/index.ts` + `packages/lb/router.ts` |
| Setup akun script | `scripts/setup-r2-account.mjs` |
| Docs | `docs/ADDING-ACCOUNT.md`, `docs/TOS-REVIEW.md` |

**Testing:**
- Hash konsisten: unit test pure function (dipakai 2 sisi, 1 kode).
- Remap report: simulasi 2→3 akun → proporsi pindah ≈ 1/3.
- Fallback: mock R2 404 → proxy serve + upload triggered.
- Eviction config: unit test script setup (lifecycle rule JSON benar).
- Quota: test D1 upsert increment.

## 11. Referensi Dokumentasi Cloudflare (diakses 2026-08-07)

| Keputusan | Sumber |
|---|---|
| R2 public bucket custom domain wajib produksi; r2.dev rate-limited | https://developers.cloudflare.com/r2/buckets/public-buckets/ |
| Lifecycle age-only (`Expiration.Days`), prefix filter, via S3 API | https://developers.cloudflare.com/r2/buckets/object-lifecycles/ |
| R2 free tier 10GB/akun, Class A/B ops, egress gratis, IA tidak di free tier | https://developers.cloudflare.com/r2/platform/pricing/ |
| R2 limits: unlimited/bucket, 100 custom domain/bucket, 1 write/s/key | https://developers.cloudflare.com/r2/platform/limits/ |
| Workers Free: 100k req/day, 50 subrequests, CPU 10ms, 64 env vars, 3MB bundle | https://developers.cloudflare.com/workers/platform/limits/ |
| KV Free: 1.000 writes/day, 100k reads/day, eventual consistency | https://developers.cloudflare.com/kv/platform/limits/ + https://developers.cloudflare.com/kv/reference/faq/ |
| D1: 50 queries/invocation Free, single-threaded, 500MB/DB | https://developers.cloudflare.com/d1/platform/limits/ |
| S3-compatible API R2 (cross-account upload endpoint) | https://developers.cloudflare.com/r2/buckets/object-lifecycles/ (S3 client example) |
| Image optimize on-delivery (Transformations) — bukan upload-time | https://developers.cloudflare.com/images/optimization/transformations/overview/ |
