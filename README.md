# Manga Platform

Developer documentation. Updated 2026-08-16.



## 1. Deskripsi Platform

| Concern | Teknologi |
|---|---|
| Frontend | Next.js 16.3 (App Router), `@opennextjs/cloudflare` (Workers deploy, `nodejs_compat`), dark theme OKLCH |
| API | 4 Cloudflare Workers (round-robin LB): akun-1 (fallback) + akun-2/3/4 (primary) |
| DB | Cloudflare D1 (SQLite), schema `packages/db/schema.sql` + 12 migrations + 1 backfill; `chapter_pages` **sharded** by chapterId → owner D1 (murmur3, cross-account forward) |
| Cache | KV (`CACHE_KV`) per-akun, cache-aside (search/series/reader), TTL 30s–3600s |
| Storage | Backblaze B2 multi-account (100%, **R2 removed**): `manga-oktz-assets` (akun-1) + `manga-oktz-assets-2` (akun-2), region `us-east-005`, hash-pick deterministik (`murmur3_32(key) % accounts.length`), **presigned GET 7 hari** (SigV4 query auth) |
| Storage fallback | **Tidak ada** — semua B2 gagal → proxy-only (serve gambar langsung dari source CDN, tanpa simpan) |
| Rehost | **Hanya Komiku** di-rehost ke B2. BacaKomik/Thrive/ManhwaIndo tetap 100% proxy |
| Browser | Cloudflare Browser binding (`MY_BROWSER`, `remote=true`) — Puppeteer fetch fallback untuk BacaKomik & ManhwaIndo (Cloudflare Bot Fight) |
| Eviction | Usage-based: KV `b2:usage:{idx}` vs `B2_QUOTA_BYTES` (default 10GiB); trigger tiap 100th chapter-detail (`eviction:tick`) + cron hourly akun-1 (`EVICTION_OWNER=1`); hapus B2 objek `last_access > 30d` ketika quota > 80% → turun ke 70% |

**4 source adapter** (`packages/sources/`, interface `SourceAdapter`): `search | getSeries |
listChapters | fetchPageUrls | scrapeUrl`. Komiku fetch+regex (no Puppeteer); Thrive parse
`__NEXT_DATA__`; BacaKomik/ManhwaIndo hybrid fetch → `MY_BROWSER` fallback. Semua di-scrape
HTML — **tidak ada MangaDex API** (dihapus 2026-08-07).

---

## 2. Quick Start (Dev)

Butuh `node >= 18` + `npm` + Cloudflare `wrangler`.

```bash
git clone <repo> manga && cd manga
npm install
```

### D1 lokal (schema + migrasi)

```bash
npx wrangler d1 execute manga-db --local --file=packages/db/schema.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0001_manga_data.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0002_r2_storage.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0003_drop_mangadex.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0004_aggregation.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0005_user_profile.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0006_admin_monitoring.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0007_relax_chapter_pages_fk.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0008_sessions.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0009_chapter_pages_last_access.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0010_bookmark_source.sql
```

### Worker + Web dev (2 terminal)

```bash
# Worker (akun-1) — port 8787
cd apps/api-cf && npx wrangler dev --port 8787 --local

# Web — port 3000
cd apps/web && npx next dev --port 3000
```

`.env.local` (dev) contoh:
```
NEXT_PUBLIC_API_URL=http://localhost:8787
NEXT_PUBLIC_AUTH_API_URL=http://localhost:8787
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

> `wrangler dev --local` memakai binding `preview_id`/preview bucket. Untuk origin
> akun-2/akun-3 dev pakai varian wrangler masingkin:
> `npx wrangler dev --config apps/api-cf/wrangler.origin.toml --port 8788 --local`.

---

## 3. Deploy ke Production

### Worker (4 akun — akun-1 fallback, akun-2 & akun-3 & akun-4 primary)

```bash
# Akun-1 (main/fallback)
CLOUDFLARE_API_TOKEN="cfut_...akun1..." npx wrangler deploy --config apps/api-cf/wrangler.toml

# Akun-2 (primary)
CLOUDFLARE_API_TOKEN="cfut_...akun2..." npx wrangler deploy --config apps/api-cf/wrangler.origin.toml

# Akun-3 (primary)
CLOUDFLARE_API_TOKEN="cfut_...akun3..." npx wrangler deploy --config apps/api-cf/wrangler.origin3.toml

# Akun-4 (primary)
CLOUDFLARE_API_TOKEN="cfut_...akun4..." npx wrangler deploy --config apps/api-cf/wrangler.origin4.toml
```

### Frontend (Pages)

```bash
cd apps/web
NEXT_PUBLIC_API_URL=https://manga-api.oktz.workers.dev \
NEXT_PUBLIC_AUTH_API_URL=https://manga-api-2.tzok5555.workers.dev \
NEXT_PUBLIC_SITE_URL=https://manga-web-d32.pages.dev \
npx opennextjs-cloudflare build && npx wrangler deploy \
  --name manga-web --branch main
```
(`NEXT_PUBLIC_AUTH_FALLBACK` / `NEXT_PUBLIC_R2_DOMAINS` — legacy, tidak dibaca kode.)

### Build bundle worker (untuk auto-provision LB)

```bash
node scripts/build-worker-bundle.mjs        # → apps/api-cf/dist/worker.js (~143KB base64)
base64 -w0 apps/api-cf/dist/worker.js > /tmp/bundle.b64
npx wrangler kv key put --binding=CACHE_KV "worker-bundle:latest" --path=/tmp/bundle.b64
npx wrangler kv key put --binding=CACHE_KV "provision:schema:latest" --path=packages/db/schema.sql
npx wrangler kv key put --binding=CACHE_KV "provision:migration:latest" --path=packages/db/migrations/0001_manga_data.sql
```

### Secrets (set per-akun via `wrangler secret put`)

| Secret | Deskripsi |
|---|---|
| `LB_ENCRYPTION_KEY` | AES-GCM encrypt CF API token di `lb_accounts` (bukan cookie — cookie pakai ECDSA) |
| `GOOGLE_CLIENT_ID` | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `ALLOWED_ORIGINS` | comma-separated: `https://oktzz.xyz,https://www.oktzz.xyz,https://oktz.xyz,https://manga-web-d32.pages.dev,https://*.manga-web-d32.pages.dev,http://localhost:3000` |
| `ADMIN_EMAILS` | comma-separated email → auto role admin |
| `SCRAPE_API_KEY` | admin API key untuk `/api/scrape` (via header `x-admin-api-key`) |
| `B2_ACCOUNTS` | JSON array 2-item (`b2-a`, `b2-b`) — `keyId`/`appKey`/`bucket`/`region` |
| `B2_QUOTA_BYTES` | kuota per B2 akun (default `10737418240` = 10GB) |
| `B2_EVICTION_DAYS` | LRU eviction threshold days (default `30`) |
| `DB_FORWARD_KEY` | secret bersama untuk internal `/api/_internal` (owner D1) |

`PEER_URLS` / `PEER_INDEX` / `EVICTION_OWNER` = **`[vars]` di `wrangler*.toml`** (bukan secret),
empat file harus sinkron (lihat §3 bawah).

> R2 removed — storage 100% B2 (`B2_CONFIG` + `B2_ACCOUNTS`).

> **`[vars]` toml (bukan secret)** — jaga sinkron dengan yang ter-deploy:
> `PEER_URLS` (4 worker URLs), `PEER_INDEX` (`0` akun-1 / `1` akun-2 / `2` akun-3 / `3` akun-4),
> `EVICTION_OWNER="1"` (hanya akun-1, cron `[triggers]` ada di `wrangler.toml`).
>
> ⚠️ **Set secret manual per-akun** — `scripts/sync-secrets.sh` sudah dihapus (jarang dipakai). Untuk set secret di akun lain, jalankan langsung:
> ```bash
> CLOUDFLARE_API_TOKEN=$CF_TOKEN_AKUN2 npx wrangler secret put <NAME> --config apps/api-cf/wrangler.origin.toml
> CLOUDFLARE_API_TOKEN=$CF_TOKEN_AKUN3 npx wrangler secret put <NAME> --config apps/api-cf/wrangler.origin3.toml
> CLOUDFLARE_API_TOKEN=$CF_TOKEN_AKUN4 npx wrangler secret put <NAME> --config apps/api-cf/wrangler.origin4.toml
> ```

> ⚠️ **Migrasi schema baru harus dijalankan ke SEMUA 4 D1** (D1 tidak pakai
> `d1_migrations` tracking). Kasus nyata: `0007_relax_chapter_pages_fk` hanya
> diterapkan ke akun-1 → akun-2/3 masih enforce FK `chapter_pages.chapter_id →
> chapters(id)` → cache-aside row gagal ditulis **silent** (upload B2 sukses,
> row D1 tidak ada → re-download tiap 5min). ✅ Diverifikasi fix (2026-08-16):
> 0007 dijalankan ke akun-2 & akun-3, tes tulis FK-orphan via `/api/_internal/db/exec`
> sukses di keduanya. Setiap deploy migrasi, jalankan per akun:
> `npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0011_series_alt_titles_fts.sql --config apps/api-cf/wrangler.toml` (akun-1)
> `npx wrangler d1 execute manga-db --remote --file=... --config apps/api-cf/wrangler.origin.toml` (akun-2)
> `npx wrangler d1 execute manga-db --remote --file=... --config apps/api-cf/wrangler.origin3.toml` (akun-3)
> `npx wrangler d1 execute manga-db --remote --file=... --config apps/api-cf/wrangler.origin4.toml` (akun-4)

---

## 4. Arsitektur

### 4.1 Storage — B2 multi-account (hash pick, R2 removed)

```
Upload (Komiku page baru, cache miss):   hash(key) → B2-A/B-B (deterministik, wrap on fail)
Read  (cache miss):                     b2Url → /api/reader proxy
b2Url  = https://s3.us-east-005.backblazeb2.com/{key}?X-Amz-Signature=... (SigV4, 7 hari, langsung B2, no Worker)
proxy  = Worker stream (Komiku: +Referer https://komiku.org/; lain: plain)
```

- Key deterministik: `{source}/{slug}/{chapterId}/{pageNo}` (tanpa ekstensi).
- `packages/shared/src/r2-routing.ts` (MurmurHash3 + `b2KeyFor`) — satu sumber hash. R2 ring (`buildRing`/`accountFor`) **dihapus**.
- Hash-pick: `pickB2AccountIdx = murmur3_32(b2Key) % accounts.length` (`lib/b2Config.ts`). Mulai dari akun terpilih; gagal → wrap ke akun lain. Idempoten.
- `resolveB2Accounts()` merge `B2_CONFIG` (legacy) + `B2_ACCOUNTS` (array) → dedup by `keyId`. Urutan = idx: -1 = B2-A (akun-1), -2 = B2-B (akun-2).
- **`chapter_pages` sharded** by chapterId → owner D1 (`ownerFor = murmur3_32 % peers.length`, `lib/peers.ts`). Upload menulis row (b2Key + accountIdx) ke owner via forward `/api/_internal/db/exec`; forward gagal → tulis lokal (healing). Read owner → presigned GET.
- B2 upload (Komiku) di-`waitUntil`; stream **clone dulu** sebelum `new Response(upstream.body)`.
- BacaKomik/Thrive/ManhwaIndo = **100% proxy, tidak pernah disimpan.**
- Eviction usage-based + cron: lihat table §1 `Eviction`.

### 4.2 4 Worker round-robin (KV-free auth, sticky origin + shard reads)

```
                    ┌──────────────────┐
Frontend ─────────▶│  CDN / WAF       │
  │                 └────────┬─────────┘
  │ getAuthApiUrl()         │
  │ health-check akun-2→3→1  ▼
  │ sessionStorage('auth_origin')  sticky 60s
  │
  ├─ allowlisted public path ──▶ round-robin origin (reader + series + search + health + source-status;
  │                              circuit-breaker 2 gagal → skip 60s, cursor rr_index sessionStorage)
  └─ auth / user path ──────────▶ STICKY origin (cookie lives di origin Worker itu)
```

- `manga-api` (akun-1) = fallback + host `oktzz.xyz` + cron eviction (`EVICTION_OWNER=1`).
- `manga-api-2` (akun-2, primary), `manga-api-3` (akun-3, primary).
- D1 split per-akun (tidak sinkron) → sticky origin untuk semua r/w user.
- **Reader/series/search/health/source-status BISA round-robin** — `chapter_pages` shard-readable dari worker mana pun via owner forwarding (`ORIGIN_PATH_ALLOWLIST` di `apps/web/lib/api.ts`). Auth paths tidak di allowlist.
- CSP `connect-src` **wajib** include ke-3 worker domain.

### 4.3 KV-free OAuth auth (asymmetric ECDSA cookie)

- **State:** cookie `__Host-oauth-state` = base64url payload + ECDSA P-256 signature (nol KV).
- **Session:** cookie `__Host-session` = `{sid, uid, email, role, kid, iat, exp}` base64url + ECDSA sig.
  - `Set-Cookie: __Host-session=...; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800`
  - `__Host-` prefix = butuh `Path=/`, `Secure`, no `Domain` → cookie ini hanya bisa diset oleh API origin (bukan frontend).
- **Revocation:** D1 `sessions` tabel; lazy check `getSession(sid).revoked_at IS NULL` (1 D1 read).
- `createSession()` = **1 D1 INSERT** (was 2 KV.puts). `getSessionUser()` = ECDSA verify (public key by kid) + check expiry + 1 D1 read session di owner shard (fail-closed: row hilang = revoked).
- OAuth: Google only. Password auth — **removed** (commit `b2b9866`). `AuthForm.tsx` = single Google button.
- Frontend: `middleware.ts` = no-op pass-through; halaman guard via `fetch('/api/user/me', {credentials:'include'})`.
- CSRF: mutasi non-GET, `Origin` tidak di-allowlist → 403.
- Admin: `requireAdminSession` (session role D1) + `ADMIN_EMAILS` auto-assign `role='admin'`.

### 4.4 Multi-source aggregation

- `manga_source_link(manga_id FK→series, source, source_slug, has_chapter_list, chapter_count, last_scraped_at, UNIQUE(source,source_slug))`.
- `/api/reader/:source/series/:sourceId/sources` → D1 `manga_source_link` → live-resolve fallback (search title di source lain, exact match preferred) + **auto-index persist D1 background**.
- Matching pure: `packages/db/src/matching.ts` (`normalizeTitle` + `jaroWinkler` threshold 0.92 → `exact|fuzzy|queue|new`).

---

## 5. Bookmark Multi-Source

**Migration `0010_bookmark_source.sql`** (baru, 2026-08): menambah 2 kolom ke `bookmarks`:

```sql
ALTER TABLE bookmarks ADD COLUMN source TEXT;
ALTER TABLE bookmarks ADD COLUMN source_url TEXT;
CREATE INDEX idx_bookmarks_source ON bookmarks (source, created_at DESC);
```

- `source` = `komiku|bacakomik|thrive|manhwaindo` (default `NULL` → konvensi resolve ke `komiku`).
- `source_url` = URL detail series di source asal (untuk Switch source).
- `addBookmark({ userId, seriesSlug, source, source_url })` — INSERT OR IGNORE.
- `listBookmarks(userId)` — JOIN `series`, return `bookmark_source` / `bookmark_url` /
  `bookmark_created_at` (untuk filter per-source di halaman bookmark).
- POST `/api/user/bookmark` menerima `{ seriesSlug, source, source_url }`.

### Rate limit (penting — perbaikan 429)

| Endpoint | Limiter | Limit |
|---|---|---|
| `GET /api/user/bookmark/:slug` | global only | **60/min** (exempt dari `rateLimitMutate`) |
| `GET /api/user/bookmarks` | global only | **60/min** (exempt) |
| `POST /api/user/bookmark` | global + `rateLimitMutate` | 60/min ∩ **60/hr** |
| `DELETE /api/user/bookmark/:slug` | global + `rateLimitMutate` | 60/min ∩ **60/hr** |
| `DELETE /api/user/bookmarks` | global + `rateLimitMutate` | 60/min ∩ **60/hr** |

`rateLimitMutate = makeLimiter(60, 3600)` = **60/hr**, terdaftar **hanya** di route
mutasi (`apps/api-cf/src/routes/user.ts:78,80,82`). GET bookmark **tidak** melewati
`rateLimitMutate` — jadi tidak akan dapat 429 dari limiter 60/hr. Global `rateLimit`
(60/min) tetap berlaku segala route; limiter berbasis in-memory Map per-isolate
(no KV ops — mengganti KV counter lama yang borong kuota).

```
router.post('/bookmark', requireSession, rateLimitMutate);   // 60/hr
router.get('/bookmark/:slug', requireSession);               // global 60/min only  ← FIX 429
router.delete('/bookmark/:slug', requireSession, rateLimitMutate);  // 60/hr
router.get('/bookmarks', requireSession);                    // global 60/min only  ← FIX 429
router.delete('/bookmarks', requireSession, rateLimitMutate); // 60/hr
```

> Catat: effective limit POST/DELETE = min(60/min, 60/hr) = **60/hr**. Jika butuh
> lebih tinggi, naikkan `rateLimitMutate` di `lib/rateLimit.ts`.

### `BookmarkButton` — tempat sajian

`BookmarkButton` **hanya** dirender di **halaman detail komik** (`apps/web/app/[source]/s/[slug]/page.tsx:235`).
**Tidak** muncul di homepage atau halaman lain — `MangaCard` menerima prop
`bookmarkable` (default `false`); homepage & `/bookmark` card tidak mengaktifkannya:

```tsx
// detail page
<BookmarkButton slug={params.slug} />

// MangaCard — homepage jalankan dengan bookmarkable={false} (default), button tidak render
{bookmarkable && (
  <div className="absolute top-1.5 right-1.5 z-10">
    <BookmarkButton slug={bookmarkSlug ?? manga.slug} size="sm" />
  </div>
)}
```

`BookmarkButton` guest-friendly: cek `GET /api/user/me` (200 + `{data:null}`). Guest
klik → redirect `/login`. Mutasi POST/DELETE pakai `getAuthApiUrl()` (sticky origin).

---

## 6. API Endpoints

Semua di satu Worker Hono (`apps/api-cf/src/index.ts`), mount `/api/*`.

### Public (no auth, global 60/min)

| Method | Path | Deskripsi |
|---|---|---|
| GET | `/api/health` | `{status:"ok", ts}` |
| GET | `/api/search?q=<q>` | 4 source paralel, merge title → badge multi-source; kosong = homepage feed; KV 300s |
| GET | `/api/series?genre=&page=&limit=` | List series (D1) |
| GET | `/api/series/:slug` | Detail by slug (D1+KV) |
| GET | `/api/manga/:id` | Manga meta (D1+KV 3600s) |
| GET | `/api/source-status` | Passive health per source (D1, no live ping) |
| GET | `/api/origins` | Daftar origin sehat (lazy 5s, KV 30s) |

### Reader (global 60/min; data API)

| Method | Path | Deskripsi |
|---|---|---|
| GET | `/api/reader/:source/series/:sourceId/detail?lang=` | Series + chapters consolidated (two-tier cache) |
| GET | `/api/reader/:source/series/:sourceId` | Series detail (KV 600s) |
| GET | `/api/reader/:source/series/:sourceId/chapters?lang=id` | Chapter list (KV 300s) |
| GET | `/api/reader/:source/series/:sourceId/sources` | Aggregated sources + auto-index D1 background (KV 600s) |
| GET | `/api/reader/:source/chapter/:chapterId` | Chapter + page URL list (KV 300s) |
| GET | `/api/reader/:source/page/:chapterId/:pageNo` | Image proxy (Komiku: +Referer, upload B2 background) |

### Auth — OAuth only (password removed, commit `b2b9866`)

| Method | Path | Deskripsi |
|---|---|---|
| GET | `/api/auth/google` | Redirect Google OAuth |
| GET | `/api/auth/google/callback` | Callback → upsert user, update `last_login_at`, auto-admin via `ADMIN_EMAILS` |
| GET | `/api/auth/me` | Guest-friendly: `{data:user}` or `{data:null}` |
| POST | `/api/auth/logout` | Hapus+revoke session |

### User (auth required, except `GET /me` guest-friendly)

| Method | Path | Limit | Deskripsi |
|---|---|---|---|
| GET | `/api/user/me` | 60/min | `{data:null}` bila guest |
| PATCH | `/api/user/me` | 60/min | Update `{display_name,bio,preferences,avatar_url}` |
| DELETE | `/api/user/me` | 60/min | `{confirm:"DELETE"}` |
| POST | `/api/user/bookmark` | 60/hr | addBookmark source-aware |
| GET | `/api/user/bookmark/:slug` | 60/min | cek bookmarked (exempt mutate) |
| GET | `/api/user/bookmarks` | 60/min | list (exempt mutate) |
| DELETE | `/api/user/bookmark/:slug` | 60/hr | hapus |
| DELETE | `/api/user/bookmarks` | 60/hr | clear semua |
| POST | `/api/user/history` | 60/min | upsertHistory |
| GET | `/api/user/history` | 60/min | list |
| DELETE | `/api/user/history` | 60/min | clear |
| GET | `/api/user/sessions` | 60/min | list active (D1) |
| DELETE | `/api/user/sessions/:token` | 60/min | revoke satu |
| POST | `/api/user/sessions/revoke-all` | 60/min | kecuali current |

### Identify (strict 10/min, `rateLimitIdentify`)

| Method | Path | Deskripsi |
|---|---|---|
| POST | `/api/identify` | Upload gambar ≤10MB → phash → match series |

### Admin (scrape + monitoring + merge) — `requireAdminKey` / `requireAdminSession`

| Method | Path | Auth | Limit | Deskripsi |
|---|---|---|---|---|
| POST | `/api/scrape` | `x-admin-api-key` | admin | `{source,url?,query?}` |
| GET | `/api/scrape` | `x-admin-api-key` | admin | list jobs |
| GET | `/api/scrape/:job_id` | `x-admin-api-key` | admin | status |
| GET | `/api/admin/overview` | session admin | admin | stat ringkas |
| GET | `/api/admin/health` | session admin | admin | origin+adapter health |
| GET | `/api/admin/db` | session admin | admin | D1 size, row counts |
| GET | `/api/admin/users` | session admin | admin | list (paginated) |
| GET | `/api/admin/users/:id` | session admin | admin | detail |
| GET | `/api/admin/usage` | session admin | admin | LB+B2 usage |
| GET | `/api/admin/jobs` | session admin | admin | scrape log |
| GET | `/api/admin/source-detail/:source` | session admin | admin | per-source detail |
| GET | `/api/admin/lb/*` | session admin | admin | LB set/accounts/origins/status/usage |
| POST | `/api/admin/lb/accounts/provision` | session admin | admin | auto-provision akun baru |
| GET | `/api/admin/merge/queue` | session admin | admin | list queue |
| POST | `/api/admin/merge/queue/:id` | session admin | admin | merge/reject |
| POST | `/api/admin/merge/series` | session admin | admin | manual merge |

> Scraper pakai **per-route** `requireAdminKey` (bukan `router.use('*')` wildcard —
> wildcard akan blokir endpoint lain). Lihat `routes/admin/scrape.ts`.

---

## 7. Struktur Folder

```
Manga/
├── apps/
│   ├── api-cf/                       # Worker tunggal (manga-api, akun-1 fallback)
│   │   ├── wrangler.toml             #   — akun-1: DB + KV + Browser (no R2)
│   │   ├── wrangler.origin.toml      #   — akun-2: DB + KV + Browser (no R2)
│   │   ├── wrangler.origin3.toml     #   — akun-3: DB + KV + Browser (no R2)
│   │   ├── wrangler.origin4.toml     #   — akun-4: DB + KV + Browser (no R2)
│   │   ├── package.json              #   — build:bundle (esbuild → dist/worker.js)
│   │   └── src/
│   │       ├── index.ts              # Hono, CORS allowlist, security headers, global rateLimit
│   │       ├── lib/
│   │       │   ├── context.ts        # Env, json(), parseAllowedOrigins(), sha256Hex()
│   │       │   ├── auth.ts           # signed HMAC cookie (state+session), D1 sessions, requireSession/AdminKey/AdminSession
│   │       │   ├── rateLimit.ts      # makeLimiter(limit,window) in-memory; rateLimit 60/min, rateLimitIdentify 10/min, rateLimitAdmin 600/min, rateLimitMutate 60/hr
│   │       │   ├── retry.ts          # retryUpstream 429 backoff
│   │       │   ├── peers.ts          # PEER_URLS owner sharding + internalExec/Query + peerKvGet
│   │       │   ├── b2Config.ts       # parse B2_ACCOUNTS + B2_CONFIG, resolveB2Accounts(), pickB2AccountIdx()
│   │       │   ├── b2Usage.ts        # KV b2:usage tracker, quotaBytes, b2NativeUsage sync
│   │       │   ├── s3Upload.ts       # SigV4 signed PUT + presigned GET + delete (B2) no @aws-sdk
│   │       │   ├── storageEviction.ts# evictStaleStorage() usage-based 30d @ quota>80%, owner-sharded
│   │       │   ├── dbWrite.ts        # D1 overflow detector
│   │       │   ├── readThroughCache.ts # two-tier KV cache + circuit breaker + peer fallback
│   │       │   └── komikuSlug.ts        # parse '<slug>-chapter-<num>'
│   │       └── routes/
│   │           ├── health.ts • search.ts • series.ts • reader.ts • origins.ts
│   │           ├── manga.ts • identify.ts • auth.ts • user.ts
│   │           └── admin/{monitoring,lb,merge,scrape}.ts
│   ├── web/                              # Next.js 14 frontend (Pages)
│   │   ├── app/                          # App Router (runtime='edge' + revalidate di halaman dinamis)
│   │   │   ├── page.tsx                  # Home: hero + marquee + populer + genre + update (revalidate 300s)
│   │   │   ├── search/page.tsx • login/page.tsx • bookmark/page.tsx • history/page.tsx • status/page.tsx
│   │   │   ├── admin/{page,monitoring,users,[id],settings}/page.tsx
│   │   │   └── [source]/s/[slug]/{page,loading,page.tsx}  # detail + reader
│   │   ├── components/                   # MangaCard, TypeBadge, SourceBadge, SourceSwitcher, BookmarkButton, Reader, Skeleton, ConfirmModal, profile/*
│   │   ├── lib/api.ts                    # client + round-robin failover (reader+series+search) + getAuthApiUrl() sticky
│   │   ├── middleware.ts                 # NO-OP pass-through
│   │   ├── next.config.mjs • tailwind.config.ts • globals.css
│   │   └── .env.production
├── packages/
│   ├── db/                               # schema.sql, migrations/0001..0011 + backfill, index.ts (40+ helpers), matching.ts
│   ├── shared/                           # types.ts (Zod), r2-routing.ts (murmur3 B2 hash-pick + owner sharding), entities.ts (HTML entity decoder)
│   ├── sources/                          # komiku/bacakomik/thrive/manhwaindo adapters + registry
│   ├── lb/                               # crypto.ts, accounts.ts, router.ts, provision.ts
│   └── vision/                           # phash.ts, hamming.ts, identify.ts
├── scripts/                              # build-worker-bundle.mjs, gen-auth-keys.mjs, smoke-*
├── docs/                                 # DEPLOY.md, ADDING-ACCOUNT.md, specs
├── package.json • turbo.json
└── README.md                             # ini file
```

---

## 8. Commands

### Dev
```bash
npm run dev:api      # turbo → apps/api-cf npx wrangler dev
npm run dev:web      # turbo → apps/web npx next dev
```

### Type-check
```bash
cd apps/api-cf && npx tsc --noEmit       # pre-existing error auth.ts/crypto OK
cd apps/web && npx tsc --noEmit
cd packages/db && npx tsc --noEmit
cd packages/sources && npx tsc --noEmit
```

### Build
```bash
# Worker bundle (auto-provision)
node scripts/build-worker-bundle.mjs
# Web (Pages)
cd apps/web && npx next build && npx @cloudflare/next-on pages
# Workspace turbo
npx turbo run build
```

### Test
```bash
node packages/db/test/matching.test.mjs          # pure functions, no network
node packages/sources/test/thrive.test.mjs       # fixture, no network
node packages/sources/test/bacakomik.test.mjs    # fixture, no network
node packages/sources/test/manhwaindo.test.mjs   # fixture, no network
node packages/lb/test/provision.test.mjs         # unit crypto
```

### Smoke (dev)
```bash
CLOUDFLARE_API_TOKEN="..." node scripts/smoke-db.mjs          # D1 schema
CLOUDFLARE_API_TOKEN="..." node scripts/smoke-data-db.mjs     # data DB
node scripts/smoke-user.mjs     # /api/user/* smoke
```

### Migrasi D1 remote (semua akun — jangan lupa akun-2/3/4!)
```bash
export CLOUDFLARE_API_TOKEN="cfut_...akun1..."
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0011_series_alt_titles_fts.sql --config apps/api-cf/wrangler.toml
# ulangi per akun (token akun-2 + --config wrangler.origin.toml, akun-3 + wrangler.origin3.toml, akun-4 + wrangler.origin4.toml)
```

### Setup akun B2 baru
```bash
# Tambah entry baru ke secret B2_ACCOUNTS di semua 4 worker.
# Urutan array menentukan idx (-1/-2/...). Hash-pick distribusi otomatis.
# Jalankan juga di akun-1 via B2_CONFIG bila akun itu tidak punya B2_ACCOUNTS.
```

---

## 9. Gotchas

- **OpenNext + Cloudflare Workers** (`@opennextjs/cloudflare`) adalah build pipeline pengganti `@cloudflare/next-on-pages`. Semua halaman App Router (termasuk `search`, `[source]/s/[slug]/*`, `admin/*`) jalan di runtime `nodejs_compat` — **tidak perlu** `export const runtime = 'edge'` lagi. Build: `npx opennextjs-cloudflare build`, deploy via `wrangler deploy` (config `apps/web/wrangler.jsonc`).
- **`ALLOWED_ORIGINS` CORS cross-origin.** Frontend fetch ke `*.workers.dev` butuh origin match. Support wildcard subdomain `https://*.manga-web-d32.pages.dev`. Worker 500/exception → response **tanpa** CORS header → browser `TypeError: Failed to fetch` (bukan 5xx yang terlihat). Kalau admin/reader error fetch, cek dulu: domain frontend ada di allowlist? subdomain lama (`oktz.xyz` vs `oktzz.xyz`, `www.`) terlewat?
- **Cookie `__Host-`** butuh `Path=/`, `Secure`, tidak ada `Domain`.** Cookie hanya diset API origin, bukan frontend origin. Session guard pakai `credentials:'include'` fetch dari page-level client component, bukan `req.cookies` middleware.
- **Komiku proxy butuh `Referer: https://komiku.org/`.** Image CDN komiku 403 tanpa Referer — set di `routes/reader.ts`.
- **Migrasi D1 wajib ke 4 akun.** D1 tanpa `d1_migrations` tracking — `wrangler d1 execute --file` manual. Migrasi yang terlewat di akun-2/3/4 gagal **silent**: contoh `0007_relax_chapter_pages_fk` terlewat → `chapter_pages` masih enforce FK → `markPageB2Uploaded` catch error → upload B2 sukses tapi row D1 tidak ada. Verifikasi: setelah page baru di-upload, cek row di owner D1 (`SELECT ... FROM chapter_pages WHERE chapter_id=?`).
- **B2 upload idempotent.** Key sama → overwrite; race aman. Background via `waitUntil`. Gagal → akun lain (wrap) → proxy-only.
- **Clone stream sebelum `new Response(upstream.body)`.** Setelah dibaca stream terkunci (`ReadableStream.locked`).
- **Bundle worker base64 ~143KB.** Jangan via argumen shell; pakai `--path=` (KV key put limit 1MB, tapi argumen CLI lebih kecil).
- **D1 per-akun tidak sinkron.** User di akun-1 mungkin tidak ada di akun-2/3/4 → sticky auth origin wajib. Search/series (public) boleh round-robin karena D1 read-only snapshot konsisten cukup.
- **B2 presigned GET 7 hari.** Jangan pakai B2 S3 client key di frontend — presigned URL cukup (exp 7 hari). S3 `appKey` hanya di secret Worker.
- **`rateLimit` in-memory per-isolate.** Tidak konsisten lintas isolate; cukup untuk anti-abuse. `rateLimitMutate` (60/hr) hanya ke write bookmark — GET bookmark tetap subjek global 60/min saja.
- **Scrape `/api/scrape` pakai per-route `requireAdminKey`.** Jangan `router.use('*')` (akan blokir semua subroute). Header `x-admin-api-key` = `SCRAPE_API_KEY`.

---

*README ini mencerminkan kode sumber. Skill `manga` (`.opencode/skills/manga/SKILL.md`) adalah sumber kebenaran lengkap untuk AI asisten.*
