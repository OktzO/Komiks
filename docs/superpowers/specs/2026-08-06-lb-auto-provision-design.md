# LB Auto-Provision + Hybrid Routing

## Problem
Sistem LB sekarang manual: admin input token CF + URL Worker sendiri. Mau otomatis — admin input CF API token, sistem bikin D1 baru + deploy Worker baru di akun CF itu, catat sebagai origin LB. Routing client-side round-robin anti-SPOF.

## Arsitektur

```
User ──> Frontend (manga-web.pages.dev)
  │
  ├─ GET /api/origins (dari manga-api utama) → daftar origin sehat + URL
  │
  ├─ Round-robin client-side ke origin:
  │   api1.oktz.workers.dev (akun CF A, D1-A terpisah)
  │   api2.oktz.workers.dev (akun CF B, D1-B terpisah)
  │
  └─ Fallback: kalau origin gagal → retry origin lain → main API
```

## Komponen

### 1. Auto-provision (`POST /api/admin/lb/accounts/provision`)
Admin input: `label` + `cfApiToken` (token CF dengan permission `Workers Scripts:Edit`, `D1:Edit`, `Workers KV Storage:Edit`, `Workers R2 Storage:Edit`).

Flow:
1. Verifikasi token via `GET /client/v4/user/tokens/verify`
2. Get account ID via `GET /client/v4/accounts` (token punya akses ke akun)
3. Create D1 database: `POST /client/v4/accounts/{id}/d1/database` → database_id
4. Run migration: `POST /client/v4/accounts/{id}/d1/database/{db}/query` dengan schema.sql + migration 0001
5. Create KV namespace: `POST /client/v4/accounts/{id}/storage/kv/namespaces`
6. Create R2 bucket: `PUT /client/v4/accounts/{id}/r2/buckets/{name}`
7. Deploy Worker: `PUT /client/v4/accounts/{id}/workers/scripts/{name}` — upload bundle manga-api (ESM module + metadata bindings DB/KV/R2 + secrets)
8. Set secrets: `PUT /client/v4/accounts/{id}/workers/scripts/{name}/secrets` untuk MANGADEX_API_KEY, ALLOWED_ORIGINS, SCRAPE_API_KEY
9. Catat URL Worker (`https://{name}.{subdomain}.workers.dev`) sebagai origin di D1 utama
10. Encrypt + store token CF di `lb_accounts`

Worker name format: `manga-api-{timestamp}` atau input admin. Subdomain dari akun CF itu.

### 2. Origin health (passive + lazy)
- Tiap origin record `source_health` di D1-nya sendiri saat user aktivitas
- Main API `/api/origins` lazy-check: fetch `GET /api/health` per origin (5s timeout), cache 30s di KV
- Origin dianggap sehat kalau respond 200 dalam timeout

### 3. Frontend routing (`lib/api.ts`)
- `getOrigins()` → `GET /api/origins` dari main API → array `{url, priority, weight, healthy}`
- Session storage cache origin list (60s)
- `api()` function: round-robin pilih origin. Kalau gagal (timeout 12s / network error / 5xx), fallback ke origin lain. Kalau semua origin gagal, fallback ke main API URL.
- State: index round-robin di sessionStorage supaya persist antar page

### 4. Endpoint baru
- `GET /api/origins` (public, no auth) — return `{data: [{url, priority, weight, healthy}]}`. Lazy health check + KV cache 30s.
- `POST /api/admin/lb/accounts/provision` (step-up auth) — jalankan auto-provision flow. Return `{job_id, status: 'provisioning'}`. Proses async via `executionCtx.waitUntil`. Status via `GET /api/admin/lb/accounts/:id/provision-status`.

### 5. File baru/berubah
| File | Status | Fungsi |
|------|--------|--------|
| `packages/lb/provision.ts` | BARU | CF API client: verifyToken, getAccountId, createD1, runMigration, createKV, createR2, deployWorker, setSecrets, provisionAccount |
| `packages/lb/provision-job.ts` | BARU | Job status tracker (KV-based: `provision:{jobId}` → status/step/error) |
| `apps/api-cf/src/routes/origins.ts` | BARU | `GET /api/origins` public |
| `apps/api-cf/src/routes/admin/lb.ts` | UBAH | Tambah `/accounts/provision` + `/accounts/:id/provision-status` |
| `apps/web/lib/api.ts` | UBAH | Round-robin client + fallback + getOrigins |
| `apps/web/app/admin/settings/load-balancing/page.tsx` | UBAH | Tombol "Provision Akun Baru" + status polling |

### 6. Worker bundle deploy
- Pakai bundle yang sama dengan main `manga-api` (sudah di-build di `.next` atau compiled)
- Upload via CF API: module format (ESM), metadata JSON bindings
- Wrangler config tidak perlu — bindings di-set via API metadata
- Bundle source: `apps/api-cf/dist/worker.js` (perlu build step ke single file)

### 7. Schema D1 baru
Saat provision, D1 baru di-migrate dengan:
1. `packages/db/schema.sql` (13 tabel + FTS5 + triggers)
2. `packages/db/migrations/0001_manga_data.sql` (ALTER + image_hashes + scrape_jobs + source_health)
3. Optional: seed manga populer (jalankan scrape untuk top 20 Komiku)

## Data flow

```
Admin panel
  │
  ├─ Input CF API token + label
  │
  POST /api/admin/lb/accounts/provision
  │
  ├─ verifyToken → getAccountId
  ├─ createD1 → runMigration (schema + 0001)
  ├─ createKV → createR2
  ├─ deployWorker (bundle + bindings)
  ├─ setSecrets (MANGADEX_API_KEY, ALLOWED_ORIGINS, SCRAPE_API_KEY)
  ├─ addOrigin (URL Worker baru, priority, weight)
  └─ encryptToken + addAccount
  │
  Return {job_id, worker_url}
  │
Frontend poll /accounts/:id/provision-status sampai selesai
```

```
User search/reader
  │
  getOrigins() → [/api/origins] → origin list (cached 60s)
  │
  Round-robin pilih origin → fetch ke origin URL
  │
  Gagal? → retry origin lain → ... → fallback main API
```

## Error handling
- Token invalid → 422, tidak lanjut provision
- Permission不足 → 422 dengan list permission kurang
- D1/Worker create gagal → rollback (delete D1/Worker kalau sudah create), return error
- Worker deploy timeout → job status `failed`, admin bisa retry
- Origin health check timeout → mark unhealthy, exclude dari round-robin

## Security
- CF API token di-encrypt (AES-GCM, pakai LB_ENCRYPTION_KEY) sebelum store
- Token permission check: butuh `Workers Scripts:Edit`, `D1:Edit`, `Workers KV Storage:Edit`, `Workers R2 Storage:Edit`
- Provision endpoint tetap step-up auth (`x-admin-stepup`)
- Worker baru set `ALLOWED_ORIGINS` = domain frontend utama saja
- `SCRAPE_API_KEY` Worker baru = generate random, tidak share dengan main

## Batas & risiko
- CF API rate limit saat provisioning (cahaya, 1 provision per beberapa menit acceptable)
- D1 terpisah = data tidak sinkron. Search hasil bisa beda. Mitigasi: seed awal + scrape incremental
- Bundle Worker ~600KB, upload butuh beberapa detik
- Worker baru cold start lebih lambat (belum ada cache KV)
- Round-robin client-side expose origin URL (tidak masalah, origin public API)
