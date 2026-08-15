# Design: D1 Metadata Sharding + Full-B2 Storage + Cross-Account Cache/Traffic

**Date**: 2026-08-15
**Status**: Draft (pending user review)
**Author**: opencode session (with brainstorming skill)

## Problem Statement

The platform uses 3 Cloudflare accounts (3 Workers, 3 D1s, 3 KVs) + 2 Backblaze B2 accounts. The R2→B2 migration is ~complete in active code (bindings removed), but the infra is still mostly independent-per-account: each Worker serves from its own D1/KV, B2 uploads are an **ordered fallback chain** (B2-A primary, B2-B only on failure), the cross-account D1 forwarding scaffolding (`routes/internal.ts`, `dbWrite.ts`) is **unmounted/dead**, there is **no scheduled/cron handler**, and eviction is lazy + row-count-based rather than usage-based.

User goals (all confirmed):

1. **Lebih cepat** — gambar tersimpan penuh di B2 (cache-aside), tidak perlu fetch ke sumber asal lagi.
2. **Hemat & nambah kapasitas** — kapasitas D1 digabung lewat sharding metadata gambar lintas 3 D1; kapasitas B2 digabung lewat round-robin 2 akun (Kom + Boltz).
3. **Beban tersebar** — request/data round-robin ke 3 worker.
4. **Hemat biaya** — R2 dihapus total, 100% B2.
5. **Eviction saat penuh** — ketika storage B2 penuh/nyaris, auto-hapus gambar lama/jarang dipanggil (LRU) untuk hemat.

## Scope (approved decisions)

| # | Area | Decision |
|---|------|----------|
| 1 | Storage | R2 dihapus total (sisa nama/ring code/frontend/provision dibersihkan). Full B2. |
| 2 | B2 round-robin | `hash(objectKey) % accounts.length` → pilih akun; fallback ke akun lain saat gagal; simpan indeks di `chapter_pages.r2_account_idx` (negatif). |
| 3 | D1 sharding | Hanya `chapter_pages` di-shard `hash(chapterId) % 3` ke D1 pemilik. `chapters`, `series`, `users`, `sessions`, `bookmarks` tetap lokal per-akun. |
| 4 | KV | Cache tetap per-akun (write lokal); pada **miss** baca peer KV via internal route sebelum fetch asal. |
| 5 | Traffic | Frontend round-robin `/api/reader/*`, `/api/series*`, `/api/search`, `/api/health`, `/api/source-status` ke 3 worker. Auth tetap sticky ke akun-2. |
| 6 | Eviction | Usage tracker + cron scheduled (akun-1) + cek saat upload. `>80%` kuota → evict LRU ke `≤70%`; upload saat `>90%` → evict sebagian. |

## Architecture

### Topology (unchanged)

| Akun | Worker | D1 id | KV id | Peran |
|------|--------|-------|-------|-------|
| Akun-1 | `manga-api` | `76606365-...` | `6205fceab...` | Fallback + eviction owner + host Pages |
| Akun-2 | `manga-api-2` | `61cbf1b1-...` | `cf560313-...` | Auth origin (cookie sticky) |
| Akun-3 | `manga-api-3` | `160d0a4f-...` | `0412740b-...` | Peers |

B2: **Kom** (`us-east-005`, bucket `manga-images`), **Boltz** (`eu-central-003`, bucket `manga-images`). Both shared across all workers (`B2_CONFIG` + `B2_ACCOUNTS` secrets).

### 1. Storage — Full B2, R2 removed

**Upload pick** (`apps/api-cf/src/lib/b2Config.ts` + `s3Upload.ts`):

```
pickB2Account(accounts, key):
  if accounts.length === 1 → accounts[0]
  idx = murmur3_32(key) % accounts.length
  return accounts[idx]
```

- Deterministic: object yang sama selalu ke akun yang sama (konsisten, bisa dedup).
- Fallback: jika akun terpilih gagal → coba akun berikutnya (modular); semua gagal → proxy-only (existing behavior, response tetap diserve).
- Indeks tersimpan di `chapter_pages.r2_account_idx` = `-(i+1)` (B2, negative) — format existing sudah didukung `b2AccountForIdx`.
- **Serving**: presigned GET 7 hari (`b2PresignedGet`), existing. Karena pick deterministik by key, worker mana pun yang serve chapter detail bisa presign akun yang benar dari `r2_account_idx` yang tersimpan.
- `identify.ts` (temp `uploads/{uuid}`) dan `scrape.ts` (covers) ikut memakai `pickB2Account`.

**R2 removal checklist** (cleanup, no behavior):
- `packages/shared/src/r2-routing.ts` → rename `r2KeyFor` → `b2KeyFor`; hapus `buildRing`/`accountFor`/`generateRemapReport`/`r2UrlFor` (frontend-only, dead).
- `apps/api-cf/src/routes/reader.ts` → rename `markPageR2Uploaded` → `markPageB2Uploaded`; bersihkan komentar.
- `apps/api-cf/src/routes/identify.ts` → kolom type `r2_key` (nama kolom D1 tetap, tapi rename comment).
- `apps/api-cf/src/routes/admin/scrape.ts` → param `r2Key` → `b2Key`.
- `apps/web/lib/api.ts` → hapus `NEXT_PUBLIC_R2_DOMAINS` ring code (`r2UrlFor`, murmur ring).
- `apps/web/components/Reader.tsx`, `ReaderShell.tsx` → hapus fallback `p.r2Url`.
- `packages/lb/provision.ts` → hapus pembuatan `ASSETS_R2` bucket + binding (opsional).
- `scripts/setup-r2-account.mjs` → hapus.
- `packages/db/index.ts` → hapus `touchLastAccess` + `r2_last_access` (dead), simpan `touchPageLastAccess`/`listStalePages`/`clearPageStorage` (dipakai eviction).
- `docs/` (R2 spec/plan, `ADDING-ACCOUNT.md`, `README.md` bagian R2) → update.
- `.env`, `.env.deploy`, `README.md` → hapus referensi `R2_DOMAINS`/`R2_ACCOUNTS`/`ASSETS_R2`.

### 2. D1 — Shard `chapter_pages` lintas 3 D1

**Owner deterministik** (reuse `murmur3_32` dari `packages/shared/src/r2-routing.ts`):

```
owner(chapterId) = murmur3_32(chapterId) % PEERS.length   // 0,1,2
```

`PEERS` = 3 worker URL, diurutkan akun-1/2/3. Konsisten di semua worker (env var `PEER_URLS`).

**Aktifkan internal route** (sudah ada, sedang mati):
- `apps/api-cf/src/index.ts` → mount `routes/internal.ts` (endpoint `/api/_internal/db/exec`, sudah punya auth `x-db-forward-key` + allowlist tabel).
- Set secret `DB_FORWARD_KEY` (sama di 3 worker) + env `PEER_URLS` per worker (3 URL sendiri).
- `dbWrite.ts`: `forwardWrite`/`writeWithFallback` sudah ada — targetkan ke owner via `PEER_URLS[owner]`.

**Write `chapter_pages`** (proxy upload + scrape + B2 upload):
- 1. Tulis B2 (pick account, store idx).
- 2. Tulis row ke D1 **owner** via `forwardWrite` (`INSERT ... ON CONFLICT DO UPDATE` `r2_key`/`r2_account_idx`/`last_access`).
- 3. Kalau forward gagal (owner down) → tulis lokal sebagai fallback (row healing, lihat Edge cases).

**Read chapter detail** (halaman reader):
- Serving worker (bisa mana saja karena traffic round-robin):
  1. Cek KV lokal `chapter:detail:{src}:{chapterId}` → hit? serve.
  2. Miss → baca `chapter_pages` dari **owner** D1 via internal exec (`/api/_internal/db/exec`, SELECT).
  3. Presign B2 dari `r2_account_idx` → return `pages[].b2Url` + `proxyUrl`.
  4. Cache lokal 300s.

**Tabel yang TETAP lokal** (tidak di-shard):
- `chapters` — daftar chapter series dibaca lokal (series detail tidak fan-out). FK `chapters.series_slug → series` tetap terjaga.
- `series`, `users`, `sessions`, `bookmarks` — tetap per-akun (auth di akun-2).

### 3. KV — cache lokal + peer fallback

- Write cache: lokal seperti sekarang.
- Read (miss): setelah miss lokal, coba peer KV sebelum fetch asal.
  - Scope: hanya key cache publik read-through (`series:detail:*`, `chapters:list:*`, `chapter:detail:*`) via endpoint internal `/api/_internal/kv/get?key=` dengan **allowlist prefix**. Key sharded (chapter_pages) tidak lewat path ini — itu dibaca dari D1 owner (Bagian 2).
  - Order: lokal → peers (paralel 2) → origin fetch.
  - Hasil miss-peer tetap di-cache lokal (write) supaya next hit lokal.
  - Internal get timeout 2s; kalau peer gagal → skip, lanjut origin (jangan blok request).

### 4. Traffic — round-robin request

- `apps/web/lib/api.ts` → perbaiki `apiWithFailover` menjadi round-robin untuk allowlist data paths (`/api/reader/*`, `/api/series*`, `/api/search`, `/api/health`, `/api/source-status`): simpan index counter di `sessionStorage`/`localStorage`, iterasikan 3 `API_URL`s, fallback health-check per attempt.
- Endpoint auth (`/api/user/*`, login) → selalu auth origin (akun-2) via `getAuthApiUrl()` (existing).
- Worker mana pun dapat serve chapter detail karena owner-forwarding (Bagian 2).

### 5. Eviction saat B2 penuh

**Usage tracker** (KV `b2:usage:{idx}`, TTL 30d):
- Upload sukses: `b2:usage:{idx}` += bytes (best-effort, `waitUntil`).
- Delete eviction: `-=` bytes.
- Sync akurat: setiap cron, query B2 native `b2_list_buckets` → `fileCount` + `usedBucketCapabilities` per bucket → overwrite tracker. (Fallback: agregate `ListObjectsV2` bila native unavailable — tapi native didukung.)

**Cron scheduled** — hanya di akun-1 (`wrangler.toml`):
```toml
[triggers]
crons = ["0 * * * *"]
```
- `scheduled` handler di `index.ts` (guard: hanya eksekusi kalau env `EVICTION_OWNER="1"` menandai akun ini eviction owner + KV lock `eviction:lock` TTL 10m anti-dobel). `EVICTION_OWNER` hanya di-set di wrangler.toml akun-1.
- Per B2 account: usage/`B2_QUOTA_BYTES` (default 10GB, configurable) `> 80%` → `evictStaleStorage(env)` (LRU: `listStalePages(accountIdx, staleBeforeTs, 100)` dengan `staleBefore` = now - 30d, hapus `b2DeleteObject`, `clearPageStorage`) sampai usage `≤ 70%`. Row-count guard existing (`ROW_COUNT_THRESHOLD`) diganti/ditambah kondisi usage.

**Cek saat upload** (reaktif):
- Sebelum upload, baca `b2:usage:{pickIdx}`; `> 90%` → `waitUntil` evict beberapa sekaligus (paling lama `last_access`).

### Data flow (chapter reader, end-to-end)

```
Browser <img> → b2Url (presigned, 7d)
   ▲
chapter detail (serving worker R)
   └─ KV lokal? ──hit──▶ serve
      miss → owner O = PEERS[hash(chapterId)%3]
      ├─ O == R → baca D1 lokal → presign → cache → serve
      └─ O != R → /api/_internal/db/exec @ O (SELECT chapter_pages)
                 → presign (idx lokal diketahui dari row) → cache lokal → serve

Jika halaman belum di-B2 (proxyUrl dipakai):
  proxy path (serving worker) → fetch asal (cache edge) → upload B2 (pick hash)
  → tulis row ke owner D1 (forwardWrite) → patch KV chapter:detail (b2Url baru)
```

### Error handling

| Case | Behavior |
|------|----------|
| Owner D1 down (forward gagal) | Write → tulis lokal (row healing). Read → fallback baca lokal; kalau ada row lokal, mirror ke owner (heal). Kalau tidak ada → proxy path. |
| B2 akun terpilih gagal | Fallback akun lain; semua gagal → proxy-only (serve tetap jalan). |
| Peer KV timeout | Skip peer, lanjut origin fetch (jangan blok request). Timeout internal 2s. |
| Eviction dobel (2 worker cron) | KV lock `eviction:lock` TTL 10m; hanya akun-1 yang punya cron. |
| Presigned expired | `chapter:detail` cache 300s → re-presign saat cache expired (existing). |

### Security

- Internal route tetap butuh `x-db-forward-key` (= `DB_FORWARD_KEY`, secret sama di 3 worker) + allowlist tabel (`chapter_pages`). Tidak expose ke publik.
- `PEER_URLS` env per-worker hanya URL workers.dev sendiri (HTTPS). Internal exec memakai `fetch` dengan header auth.
- Presigned URL tetap 7d, tanpa buka akses publik permanen.

### Testing

- **Unit (node:test, `packages/db/test/`)**: `pickB2Account` deterministik + distribusi hash; `owner(chapterId)` deterministik.
- **Unit API (`apps/api-cf/test/`)**: forwardWrite → payload `x-db-forward-key` + allowlist rejection; internal `/api/_internal/db/exec` auth (tolak tanpa key / tabel non-allowlist).
- **Integration stub-D1**: chapter detail → owner read fallback + heal path.
- **Live probe (CF API)**: hash `chapterId` → owner → tulis `chapter_pages` ke owner D1 → baca balik → hapus probe.
- **Smoke live**: chapter yang belum di-B2 → proxy → upload B2 (pick account idx) → request kedua langsung b2Url.

### Migration steps

1. Cleanup R2 (checklist Bagian 1) — code + docs + env.
2. Activate internal route + set `DB_FORWARD_KEY` + `PEER_URLS` di 3 worker (`wrangler secret put`/`vars put`).
3. B2 pick-by-hash di `s3Upload.ts`/`b2Config.ts` (kompatibel: akun tunggal → `accounts[0]`).
4. D1 write/read owner-forwarding di reader path.
5. KV peer fallback.
6. Frontend round-robin + hapus ring code.
7. Usage tracker + cron akun-1 + upload-time check.
8. Deploy 3 workers + Pages + sync secrets.
9. Live verify (probe + smoke).

### Out of scope

- Shard `chapters`/`series` (user: jangan — biar series detail tetap lokal).
- Migrasi D1 schema (tidak perlu; kolom `r2_key`/`r2_account_idx` sudah ada; `r2_last_access` hanya dibersihkan).
- Read-path dedup antar B2 bucket (sama objek di 2 akun) — deterministik by key mencegah.
