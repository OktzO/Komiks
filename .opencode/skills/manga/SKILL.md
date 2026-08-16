# Manga Platform Skill

> Reference for working in the **Manga** project — baca manga Indonesia dari 4 source independen: Komiku (primary), BacaKomik.my, Thrive.moe, ManhwaIndo.my.

Invoke skill ini **sebelum** edit kode, deploy, atau jawab pertanyaan struktur/modul/deploy.

---

## 1. Arsitektur Ringkas

```
3 Cloudflare Worker (round-robin LB)        Next.js Pages (Vercel / Pages)
┌───────────────────────────────────────┐    ┌───────────────────────────────────────┐
│  akun-1  manga-api     (fallback)     │    │  apps/web  manga-web          │
│  akun-2  manga-api-2   (primary)      │◄──►│  pages/, components/, lib/      │
│  akun-3  manga-api-3   (primary)      │    │  @/lib/api.ts (getAuthApiUrl)   │
└───────────────┬───────────────────────┘    └───────────────────────────────────────┘
                │ D1 (3 DB, sharded: chapter_pages by owner chapterId)
                ├─ CACHE_KV (cache layer)
                └─ MY_BROWSER (Cloudflare Browser binding)

packages/
  db/        D1 client + schema + 10 migrations
  shared/    Zod types + r2-routing (murmur3: B2 hash-pick + owner sharding) + http utils
  sources/   4 source adapters (komiku/bacakomik/thrive/manhwaindo)
  lb/        LB account crypto + provision + router
  vision/    pHash + hamming image identify
```

### Source hierarchy
| Priority | Source | Key | Parser | Bot-mitigation |
|----------|--------|-----|--------|----------------|
| primary | Komiku | `komiku` | regex HTML (`api.komiku.org`) | UA-only (DDoS-stall jika UA non-browser) |
| fallback | BacaKomik.my | `bacakomik` | regex HTML | Cloudflare Bot Fight → MY_BROWSER Puppeteer fallback |
| fallback | Thrive.moe | `thrive` | `__NEXT_DATA__` JSON | UA-only (Next.js SSG) |
| fallback | ManhwaIndo.my | `manhwaindo` | regex HTML | Cloudflare Bot Fight → MY_BROWSER fallback |

### Storage B2 multi-account (cache-aside, `apps/api-cf/src/lib/b2Config.ts` + `storageEviction.ts` + `b2Usage.ts`)
- **B2 accounts** = `resolveB2Accounts(B2_CONFIG + B2_ACCOUNTS)` merge, dedup by `keyId`. Urutan = idx: **-1 = B2-A** (akun-1, bucket `manga-oktz-assets`), **-2 = B2-B** (akun-2, `manga-oktz-assets-2`), dst. Region `us-east-005`, host `s3.us-east-005.backblazeb2.com`. **R2 removed** — storage 100% B2 (`r2-routing.ts` hanya berisi `murmur3_32` + `b2KeyFor`).
- **Upload** = hash-pick: `pickB2AccountIdx = murmur3_32(b2Key) % accounts.length` → mulai dari akun terpilih; upload gagal → wrap ke akun berikutnya (`(start+k)%len`). Idempoten (key sama → overwrite). Semua B2 gagal → proxy-only (serve gambar langsung dari source CDN, tanpa simpan).
- **Row cache-aside (`chapter_pages`)** sharded by chapterId → owner D1: `ownerFor = murmur3_32(chapterId) % peers.length`. Row (b2Key + accountIdx) ditulis ke owner: self → local, peer → forward internal `/api/_internal/db/exec`; forward gagal → tulis lokal (row-healing fallback). Read: self → local, peer → `/api/_internal/db/query`.
- **Usage** = KV `b2:usage:{idx}` (bytes, `addB2Usage`). Quota `B2_QUOTA_BYTES` (default 10 GiB).
- **Eviction (usage-based)**: trigger lazy tiap 100th chapter-detail request (`eviction:tick`, TTL 24h) + cron akun-1 (`EVICTION_OWNER=1`, hourly, KV lock `eviction:lock` 10min). Evict objek `last_access > B2_EVICTION_DAYS` (default 30) ketika usage > 80% → turun ke 70%. Sync usage asli dari B2 bucket API (`b2NativeUsage`). Hapus B2 object (`b2DeleteObject`) + clear row di owner D1.

### Auth — KV-free signed HMAC cookie
- **Google OAuth-only** — tidak ada password login. `apps/api-cf/src/lib/auth.ts`
- Cookie: `__Host-session` (signed HMAC-SHA256, payload `.`-separated b64url: `{sid,uid,email,role,iat,exp}.{sig}`)
- `SameSite=None; Secure; HttpOnly` — cross-origin antara frontend domain dan API domain
- D1 `sessions` table (migration 0008) = revocation list: row ada + `revoked_at IS NULL` = valid. Lazy check di `getSessionUser`.
- `getSessionUser` → verify HMAC → check expiry dari payload → 1 D1 read `sessions(sid)` untuk revocation check
- State cookie: `__Host-oauth-state` (signed, 10min TTL) — ganti KV-based OAuth state

---

## 2. Worker API (`apps/api-cf`)

### Entry & middleware
`apps/api-cf/src/index.ts`: Hono app, pipeline:
1. `securityHeadersMw` — nosniff, DENY, no-referrer, COOP=same-origin
2. `corsMw` — fail-closed origin check via `ALLOWED_ORIGINS`; credentials only when origin match
3. `rateLimit` (60/min global) — semua request
4. Route mounts under `/api`

### Rate-limit tiers (`apps/api-cf/src/lib/rateLimit.ts`)
In-memory Map per Worker isolate (bukan KV — KV GET+PUT per request cepat habis kuota):
```ts
export const rateLimit        = makeLimiter(60, 60);       // global: 60 req/min
export const rateLimitIdentify = makeLimiter(10, 60);      // /api/identify: 10/min
export const rateLimitAdmin    = makeLimiter(600, 60);     // /api/admin/*: 600/min
export const rateLimitMutate   = makeLimiter(60, 3600);    // /bookmark POST/DELETE: 60/hr
```
- `makeLimiter(limit, window)` — bucket key `${ip}:${floor(now/window)*window}`, auto-GC tiap 10s
- **Bug fix penting**: GET `/bookmark/:slug` + GET `/bookmarks` **tidak** rate-limit — hanya POST/DELETE `/bookmark` yang memakai `rateLimitMutate`. Global `rateLimit` (60/min) cukup ketat untuk GET; `rateLimitMutate` (60/3600) hanya untuk mutations. Ini mencegah 429 pada saat user membuka halaman bookmark berkali-kali.

### Routes
| Route prefix | File | Auth | Rate-limit | Keterangan |
|-------------|------|------|-----------|------------|
| `/api/health` | `routes/health.ts` | — | — | `{status:'ok'}` |
| `/api/series` | `routes/series.ts` | — | rateLimit | list/detail/chapter (KV cache) |
| `/api/search` | `routes/search.ts` | — | rateLimit | FTS5 + live source search |
| `/api/homepage` | `routes/homepage.ts` | — | rateLimit | merged feed |
| `/api/reader/*` | `routes/reader.ts` | — | rateLimit | series detail, chapter, image proxy |
| `/api/identify` | `routes/identify.ts` | — | rateLimitIdentify (10/min) | pHash manga cover |
| `/api/origins` | `routes/origins.ts` | — | rateLimit | publik origin list (no live ping) |
| `/api/auth/*` | `routes/auth.ts` | — | rateLimit | Google OAuth login/logout |
| `/api/user/*` | `routes/user.ts` | `requireSession` | per-route | bookmark/history/profile/session |
| `/api/admin/*` | `routes/admin/monitoring.ts` | `requireAdminSession` | rateLimitAdmin | overview/providers/scrape-jobs/db-usage/users |
| `/api/admin/lb/*` | `routes/admin/lb.ts` | `requireAdminSession` | rateLimitAdmin | LB settings/accounts/origins/provision |
| `/api/admin/merge/*` | `routes/admin/merge.ts` | `requireAdminKey` | rateLimitAdmin | merge queue |
| `/api/admin/scrape/*` | `routes/admin/scrape.ts` | `requireAdminKey` | rateLimitAdmin | scrape jobs |
| `/api/_internal/db/exec` | `routes/internal.ts` | `x-db-forward-key`/`x-db-mirror-key` | rateLimit | cross-account D1 write forwarding (allowlist tabel; tolak DROP/ALTER/TRUNCATE) |
| `/api/_internal/db/query` | `routes/internal.ts` | sama | rateLimit | SELECT-only owner read (sharded `chapter_pages`; `internalQuery`) |
| `/api/_internal/kv/get` | `routes/internal.ts` | sama | rateLimit | KV peer-read cache fallback (`peerKvGet`), key-prefix allowlist `series:detail:`, `series:full:`, `chapters:list:`, `chapter:detail:` |

### DB write strategy (`apps/api-cf/src/lib/dbWrite.ts`)
akun-2 = primary storage. akun-1 = fallback + mirror.
1. `writeWithFallback` coba forward ke peer (`DB_FORWARD_ENDPOINT` + `DB_FORWARD_KEY`)
2. Track size di KV (`d1:usage`, 7d TTL). Threshold 400MB.
3. Peer sukses → return. Peer gagal (timeout/overflow/503) → local write
4. Local write berhasil → `mirrorToPeer` async (bukan loop: `x-db-mirror:1` header)

### Image proxy SSRF guard (`routes/reader.ts`)
`isAllowedImageUrl` — allowlist `ALLOWED_IMAGE_HOSTS` (komiku.org, img.komiku.org, i*.wp.com, dll). Blok RFC1918/loopback. Cloudflare Cache API (`cacheEverything: true, cacheTtl: 3600`) + manual `cache.put`.

---

## 3. Frontend (`apps/web`)

### Struktur routes (App Router)
```
apps/web/app/
  page.tsx                                    — homepage (stream + marquee + lazy manga list)
  search/page.tsx                             — search (server-rendered)
  bookmark/page.tsx                           — guest-friendly (GET /me → {data:null})
  history/page.tsx                            — guest-friendly
  login/page.tsx                              — AuthForm
  profile/page.tsx                            — fetchMe + role gate
  status/page.tsx                             — source health
  admin/                                      — require session.role===admin (client-side gate)
    page.tsx, monitoring/, load-balancing/, settings/, users/[id]/
  [source]/s/[slug]/page.tsx                  — detail komik (BookmarkButton DI SINI SAJA)
  [source]/s/[slug]/[chapterId]/page.tsx      — reader

components/
  BookmarkButton.tsx                          — login detect via GET /api/user/me
  MangaCard.tsx                               — bookmarkable prop (default false, NOT used on homepage)
  ReaderShell.tsx / Reader.tsx                — immersive reader (GPU transform-only animations)
  SourceSwitcher.tsx                          — 2 modes: 'detail' + 'reader'
  Navbar.tsx                                  — scroll-triggered island
  AuthForm.tsx                                — Google OAuth button
```

### `BookmarkButton` — detail page only
- **Hanya** di `apps/web/app/[source]/s/[slug]/page.tsx:235` — **bukan** homepage (MangaCard.tsx punya import tapi `bookmarkable=false` default, tidak dipakai homepage)
- Login detect: `GET /api/user/me` via `getAuthApiUrl()` → `{data:null}` = guest. Jika belum login, klik tombol redirect ke `/login`
- Optimistic toggle: POST `/api/user/bookmark` (body: `{seriesSlug, source, source_url}`) atau DELETE `/api/user/bookmark/:slug`
- `source`/`source_url` kirim ke API untuk multi-source bookmark (migration 0010)

### `getAuthApiUrl` — sticky origin, bukan round-robin
`apps/web/lib/api.ts`:
```ts
const AUTH_API_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || API_URL;
const AUTH_CACHE_KEY = 'auth_origin';

async getAuthApiUrl(): Promise<string> {
  // 1. sessionStorage cache (sticky) — setelah login, semua req ikut origin ini
  // 2. fallback ke AUTH_API_URL (akun-2 primary)
  const cached = sessionStorage.getItem(AUTH_CACHE_KEY);
  if (cached) return cached;
  return candidate;
}

setAuthOrigin(origin: string): void  // dipanggil AuthForm setelah login sukses
```
- **Tidak** round-robin — cookies SameSite=None hanya valid untuk origin yang set. Jika origin ganti, cookie tidak terbawa → 401. Sticky via sessionStorage mencegah ini.
- `AuthForm.tsx` memanggil `setAuthOrigin` setelah `getAuthApiUrl` resolve.

### API URL config
```ts
export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';
export const DATA_API_URL = process.env.NEXT_PUBLIC_DATA_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';
```
`apiWithFailover` untuk path publik di-allowlist (`ORIGIN_PATH_ALLOWLIST`): `/api/reader/`, `/api/series`, `/api/search`, `/api/health`, `/api/source-status`. **Reader ikut round-robin** — `chapter_pages` shard-readable dari worker mana pun via owner forwarding (lihat §6). Health-aware circuit breaker: 2 gagal beruntun → skip origin 60s. Cursor `rr_index` di sessionStorage. Auth paths **tidak** di sini — sticky ke auth origin (cookie + D1 split).

### Runtime & build
- **next-on-pages**: halaman dynamic (semua di `/app/`, kecuali homepage yang pure static) butuh `export const runtime = 'edge'` + `export const revalidate` (bisa `false` untuk no cache). Tanpa ini, next-on-pages build gagal karena function default ke nodejs runtime yang tidak tersedia di Pages Functions.
- Homepage (`app/page.tsx`) + search (`app/search/page.tsx`) sudah punya `runtime='edge'`. Periksa semua dynamic route baru punya ini.
- `next.config.mjs`: `transpilePackages: ['@manga-platform/shared']`, `images: { unoptimized: true }` (semua gambar pakai `<img>` langsung, bukan next/image — CDN B2 tidak kompatibel dengan next/image optimizer)
- Build: `npx next-on-pages --skip-build` (asumsi `next build` sudah jalan)

### Design tokens (OKLCH dark)
`apps/web/app/globals.css` — semua warna pakai `oklch()` via CSS vars. `--bg-base: oklch(8% 0 0)` (hampir hitam), `--accent`, `--success`, `--error`. `.nav-island` pakai `backdrop-filter: blur(18px)` di desktop, solid di mobile (hindari repaint scroll di Android).

---

## 4. Bookmark multi-source (2026-08-15)

### Migration `packages/db/migrations/0010_bookmark_source.sql`
```sql
ALTER TABLE bookmarks ADD COLUMN source TEXT;       -- komiku|bacakomik|thrive|manhwaindo (NULL = legacy → resolve ke komiku)
ALTER TABLE bookmarks ADD COLUMN source_url TEXT;   -- upstream URL asli
CREATE INDEX idx_bookmarks_source ON bookmarks (source, created_at DESC);
```
- Backward compatible: existing rows `source=NULL`. Convention resolve → `'komiku'`.
- Apply ke semua 3 D1 (akun-1/2/3).

### DB layer (`packages/db/index.ts`)
```ts
addBookmark({ userId, seriesSlug, source?, source_url? })   // INSERT OR IGNORE — idempotent
removeBookmark({ userId, seriesSlug })                        // DELETE by slug (source-agnostic)
isBookmarked({ userId, seriesSlug }) → boolean
listBookmarks(userId) → Series[]   // JOIN series + bookmarks, exposes bookmark_source/source_url/created_at
clearUserBookmarks(userId) → {deleted: N}
```
`listBookmarks` query:
```sql
SELECT s.*, b.source AS bookmark_source, b.source_url AS bookmark_url,
       b.created_at AS bookmark_created_at
FROM bookmarks b JOIN series s ON s.slug = b.series_slug
WHERE b.user_id = ?1 ORDER BY b.created_at DESC
```

### API routes (`apps/api-cf/src/routes/user.ts`)
```
POST   /api/user/bookmark       requireSession + rateLimitMutate(60/3600)
DELETE /api/user/bookmark/:slug requireSession + rateLimitMutate(60/3600)
GET    /api/user/bookmark/:slug requireSession  (NO rateLimitMutate — hanya global 60/min)
GET    /api/user/bookmarks      requireSession  (NO rateLimitMutate)
DELETE /api/user/bookmarks      requireSession + rateLimitMutate
```
- **Fix 429 bug**: GET /bookmark/:slug + GET /bookmarks tidak pakai `rateLimitMutate`. Hanya POST/DELETE yang rate-limit ketat (60/3600). Global `rateLimit` (60/min) tetap berlaku di middleware Hono untuk semua route.

---

## 5. Deploy & secrets

### wrangler.toml variants (`apps/api-cf/`)
| File | Worker name | Account | D1 | KV |
|------|------------|---------|-----|-----|
| `wrangler.toml` | `manga-api` | akun-1 (`4ce21aec...`) | `manga-db` (`76606365-...`) | `6205fceab...` |
| `wrangler.origin.toml` | `manga-api-2` | akun-2 (`6a0bdfb8...`) | `manga-db` (`61cbf1b1-...`) | `cf560313...` |
| `wrangler.origin3.toml` | `manga-api-3` | akun-3 (`ddc6f352...`) | `manga-db` (`160d0a4f-...`) | `0412740b...` |

Semua punya `[[browser]]` binding `MY_BROWSER remote=true`. **Tidak ada** binding R2 (`ASSETS_R2` dihapus — storage 100% B2).

**`[vars]` di ketiga toml (bukan secret — harus konsisten antar file):**
```toml
PEER_URLS    = "https://manga-api.oktz.workers.dev,https://manga-api-2.tzok5555.workers.dev,https://manga-api-3.dwikaoktyffan.workers.dev"
PEER_INDEX   = "0"   # akun-1 (wrangler.toml)
PEER_INDEX   = "1"   # akun-2 (wrangler.origin.toml)
PEER_INDEX   = "2"   # akun-3 (wrangler.origin3.toml)
EVICTION_OWNER = "1" # HANYA akun-1 (cron eviction hourly ada di wrangler.toml [triggers])
```
> ⚠️ Jaga PEER vars di toml tetap sinkron dengan yang ter-deploy. Kasus nyata (2026-08-16):
> `wrangler.toml` akun-1 tidak punya PEER vars (hanya di-set via `--var` saat deploy)
> → kalau akun-1 di-deploy ulang dari file, `getPeers` kosong → `ownerFor` fallback self
> → sharding chapter_pages rusak silent. Sudah diperbaiki: PEER vars masuk `[vars]` ke-3 toml.

### Secrets (via `scripts/sync-secrets.sh` → akun-2 + akun-3)
```
GOOGLE_CLIENT_ID     Google OAuth
GOOGLE_CLIENT_SECRET Google OAuth
LB_ENCRYPTION_KEY    AES-GCM token encrypt (lb/crypto.ts)
ALLOWED_ORIGINS      Comma-separated, contoh: https://oktzz.xyz,https://*.manga-web-d32.pages.dev
ADMIN_EMAILS         Comma-separated admin emails (role=admin auto-assign)
B2_ACCOUNTS          JSON array: [{name,bucket,keyId,appKey,region,host}] — B2-B (akun-2) dst, urutan = idx -1/-2/...
R2_ACCOUNTS          LEGACY/removed (R2 tidak dipakai lagi — bisa dihapus dari secret)
SCRAPE_API_KEY       admin scrape auth
ADMIN_PASSWORD_HASH  (legacy, unused — OAuth-only now)
DB_FORWARD_ENDPOINT  (cross-account write forward)
DB_FORWARD_KEY       (cross-account write auth — header `x-db-forward-key`, internal /db/exec + /db/query + /kv/get)
DB_MIRROR_ENDPOINT   (cross-account read mirror)
DB_MIRROR_KEY        (mirror auth)
B2_EVICTION_DAYS     (optional, default 30)
B2_QUOTA_BYTES       (optional, default 10 GiB per akun)
```
`PEER_URLS`/`PEER_INDEX`/`EVICTION_OWNER` → **`[vars]` toml** (bukan secret), lihat atas.
akun-1 juga dapat `B2_CONFIG` (single legacy secret) yang di-merge dengan `B2_ACCOUNTS` via `resolveB2Accounts`.

### Frontend Pages (`apps/web`)
Deploy via `npx next-on-pages` → Vercel Pages. `manga-web` project. Env vars:
```
NEXT_PUBLIC_API_URL          = akun-1 worker URL (fallback + dev)
NEXT_PUBLIC_AUTH_API_URL     = akun-2 worker URL (primary auth origin, sticky)
NEXT_PUBLIC_SITE_URL         = frontend canonical URL (default https://manga-web-d32.pages.dev)
```
`NEXT_PUBLIC_R2_DOMAINS` / `NEXT_PUBLIC_AUTH_FALLBACK` — legacy, tidak dibaca kode (R2 removed).

### Commands
```bash
# Dev
npm run dev:api    # turbo → apps/api-cf (wrangler dev, :8787)
npm run dev:web    # turbo → apps/web (next dev, :3000)

# Build worker bundle (esbuild ESM)
npm run build:bundle   # scripts/build-worker-bundle.mjs → apps/api-cf/dist/worker.js

# Deploy worker
npx wrangler deploy --config apps/api-cf/wrangler.toml          # akun-1
npx wrangler deploy --config apps/api-cf/wrangler.origin.toml    # akun-2
npx wrangler deploy --config apps/api-cf/wrangler.origin3.toml   # akun-3

# Sync secrets ke akun-2/3
./scripts/sync-secrets.sh

# Deploy frontend (Pages)
npm run build && npx next-on-pages

# DB migrations (apply ke SEMUA 3 D1 — jangan lupa akun-2/3!)
npx wrangler d1 execute manga-db --file packages/db/migrations/0010_bookmark_source.sql --config apps/api-cf/wrangler.toml        # akun-1
npx wrangler d1 execute manga-db --file packages/db/migrations/0010_bookmark_source.sql --config apps/api-cf/wrangler.origin.toml  # akun-2
npx wrangler d1 execute manga-db --file packages/db/migrations/0010_bookmark_source.sql --config apps/api-cf/wrangler.origin3.toml # akun-3
```

> **⚠️ Migrasi HARUS ke semua 3 D1.** D1 tidak pakai `d1_migrations` tracking —
> migration dijalankan manual via `--file`. Kasus nyata (2026-08-16):
> `0007_relax_chapter_pages_fk` hanya diterapkan ke akun-1. Akun-2/3 masih enforce FK
> `chapter_pages.chapter_id → chapters(id)` → `markPageB2Uploaded` (cache-aside row)
> gagal **silent** (`catch(()=>{})` / `success:false`) → upload B2 sukses tapi row D1
> tidak pernah tertulis → tiap 5min re-download + re-upload dari source. Verifikasi:
> setelah upload, cek row muncul di owner D1.
>
> ✅ Sudah difix + diverifikasi (2026-08-16): 0007 dijalankan ke akun-2 & akun-3,
> tes tulis FK-orphan via `/api/_internal/db/exec` sukses di kedua akun, row `chapter_pages`
> p3 landing di owner dengan `r2_account_idx` benar. Periksa FK setiap akun baru
> di-provision: `SELECT ... FROM chapter_pages WHERE chapter_id='<id-tanpa-row-chapters>'`.

---

## 6. Cross-account DB (LB multi-akun)

### 3 Worker round-robin
- **akun-1** (`manga-api`): fallback. Jika akun-2 overload/503, LB router (`packages/lb/router.ts`) melewati traffic ke akun-1.
- **akun-2** (`manga-api-2`): primary. `NEXT_PUBLIC_AUTH_API_URL` → akun-2 URL.
- **akun-3** (`manga-api-3`): primary. Deploy via `provisionAccount` (auto-provision baru) atau manual wrangler.

### LB auto-provision (`packages/lb/provision.ts`)
Admin di `/admin/load-balancing` → POST `/api/admin/lb/accounts/provision`:
1. Verify CF API token
2. Create D1 database → run `schema.sql` + `0001_manga_data.sql` (embedded di KV, bukan fetch dari GitHub — SSRF/integrity risk)
3. Create KV namespace
4. Deploy Worker ESM bundle (`dist/worker.js` — dibuild via `build-worker-bundle.mjs`) — **tanpa binding R2/B2 bucket** (storage 100% B2 via secret)
5. Set secrets (inherit dari parent env: `ALLOWED_ORIGINS`, `SCRAPE_API_KEY`, `ADMIN_PASSWORD_HASH`, `LB_ENCRYPTION_KEY`)
6. Encrypt + store token di D1 `lb_accounts` (AES-GCM, `packages/lb/crypto.ts`)
7. Add origin row di D1 `lb_origins`

### Storage routing (shared lib)
`packages/shared/src/r2-routing.ts` — satu sumber mutlak untuk hash. Jangan re-implement di Worker atau frontend.
```ts
murmur3_32(key: string, seed=0): number       // pure JS, deterministik
b2KeyFor(source, slug, chapterId, pageNo): string  // {source}/{slug}/{chapterId}/{pageNo}
```
`buildRing`/`accountFor`/`r2KeyFor` (R2 ring) **dihapus** — R2 removed. Hash dipakai untuk:
1. **B2 hash-pick**: `pickB2AccountIdx = murmur3_32(b2Key) % accounts.length` (`lib/b2Config.ts`)
2. **Owner sharding**: `ownerFor(chapterId) = murmur3_32(chapterId) % peers.length` (`lib/peers.ts`)

B2 key format `komiku/{slug}/...` identik dengan format lama — kompatibel penuh, key existing tetap valid.

### Cross-account sharding (`apps/api-cf/src/lib/peers.ts`)
- `getPeers(env)` parse `PEER_URLS` (comma-separated, ordered) + `PEER_INDEX` → array `{url,index,self}`.
- `ownerFor(env, chapterId)` → owner worker. Self → operasi local; peer → forward HTTP.
- `internalExec(env, url, {sql,params,table})` → POST `/api/_internal/db/exec` (header `x-db-forward-key`, timeout 8s, return `res.ok`).
- `internalQuery(env, url, sql, params, table)` → POST `/api/_internal/db/query` (SELECT-only).
- `peerKvGet(env, key)` → GET `/api/_internal/kv/get` tiap non-self peer, first-non-null.
- Reader flows (routes/reader.ts):
  - `upsertPageRow` — row `chapter_pages` ke owner; forward gagal → tulis lokal (row-healing).
  - `readStoredPageRows` — baca row dari owner; kosong → frontend fallback ke proxy (re-upload + heal).
  - `touchOwnerPage` — LRU touch last_access ke owner (best-effort).
  - `touchChapterDetailKv` — injeksi `b2Url` ke KV `chapter:detail:` setelah upload (TTL 300s).

---

## 7. Source aggregation (multi-source)

### `manga_source_link` table (migration 0004)
```sql
CREATE TABLE manga_source_link (
  id INTEGER PRIMARY KEY, manga_id INTEGER REFERENCES series,
  source TEXT, source_slug TEXT, has_chapter_list INTEGER,
  chapter_count INTEGER, last_scraped_at INTEGER,
  UNIQUE (source, source_slug)
);
```

### `manga_merge_queue` table (migration 0004)
```sql
-- Manual merge review ketika fuzzy match ambigu (top-2 within 0.05 Jaro-Winkler gap)
```

### Auto-index (lazy, background)
`/api/reader/:source/series/:sourceId/sources` — ketika aggregation kosong:
1. Cari `manga_source_link` by (source, source_slug)
2. Fallback: live-resolve — search semua source lain dengan title dari source aktif (exact normalized title match, prefix fallback)
3. **Auto-index**: `c.executionCtx.waitUntil()` upsert `series` + `manga_source_link` ke D1 (best-effort, tidak blocking response)
4. Index chapterId→slug ke KV (`slug:{chapterId}`) untuk 50 chapter pertama (kurangi KV writes ~75% untuk series besar)

### Title matching (`packages/db/src/matching.ts`)
Pure fonksional, unit-testable:
- `normalizeTitle` — lowercase, strip noise (`season`, `chapter`, `vol`, dll), strip trailing chapter number
- `jaroWinkler` — similarity 0..1
- `matchCandidate` — exact → fuzzy (threshold 0.92) → queue (ambiguitas gap 0.05) → new

---

## 8. Image identify (`packages/vision`)

`/api/identify` (multipart upload) → pHash compare:
1. Buffer body → upload ke B2 `uploads/{uuid}` (lifecycle rule hapus setelah 1h; `pickB2Account` hash-pick)
2. Load `image_hashes` snapshot dari KV (`identify:hashes:snapshot`, 5min TTL — hindari O(n) D1 scan per request)
3. `identifyImage(bytes, hashes)` — 64-bit pHash (OffscreenCanvas 32x32 → 8x8 DCT → median threshold), Hamming distance ≤ 8 = match
4. Cache result di KV (`identify:{hashPrefix}`, 10min TTL)

---

## 9. CSP & security penting

### `ALLOWED_ORIGINS` (Worker)
- **Wajib** set di semua Worker. Fail-closed: kalau unset, CORS tidak mengizinkan origin apapun. Frontend akan dapat error `NS_ERROR_FAILURE` / CORS.
- Format: `https://oktzz.xyz,https://*.manga-web-d32.pages.dev` (`*.` prefix = wildcard subdomain — untuk CF Pages preview URLs)
- `allowedOriginFor(env, requestOrigin)` — match exact atau wildcard. Fail-closed design.

### CSP (Next.js `next.config.mjs`)
```
default-src 'self'
img-src 'self' data: https: <semua API worker URLs>
style-src 'self' 'unsafe-inline'
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com
connect-src 'self' <semua API worker URLs> https://cloudflareinsights.com
font-src 'self' data:
object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```
- Worker API tidak mengizinkan `unsafe-inline` script — CSP API agresif. Jika deploy URL baru, **harus** update CSP di `next.config.mjs` + `ALLOWED_ORIGINS` di semua Worker.
- `images: { unoptimized: true }` — semua gambar pakai `<img src>` langsung, bukan next/image. B2 presigned URL tidak kompatibel dengan next/image optimizer proxy.

### Middleware (bukan gate auth)
`apps/web/middleware.ts` — pass-through. Session cookie `__Host-session` berada di API origin (bukan frontend domain), jadi `req.cookies` di frontend tidak bisa lihat. Auth gate dilakukan client-side via `fetchMe()`. Jangan tambahkan cookie-check ke sini — akan salah redirect admin yang sudah login.

### SSRF guard (`routes/reader.ts`)
`ALLOWED_IMAGE_HOSTS` allowlist — wajib update ketika source nambah host gambar. Blok semua private IP (RFC1918, loopback, metadata `169.254.169.254`).

---

## 10. Environment variables penting

### Worker (`apps/api-cf/wrangler.toml`)
| Secret | Required | Keterangan |
|--------|----------|------------|
| `GOOGLE_CLIENT_ID` | ✅ | OAuth |
| `GOOGLE_CLIENT_SECRET` | ✅ | OAuth |
| `LB_ENCRYPTION_KEY` | ✅ | AES-GCM token encrypt |
| `ALLOWED_ORIGINS` | ✅ | CORS fail-closed |
| `ADMIN_EMAILS` | ✅ | Google email → role=admin |
| `SCRAPE_API_KEY` | ✅ | /api/scrape auth |
| `B2_CONFIG` | akun-1 saja | Legacy single B2 account (B2-A, merge dengan B2_ACCOUNTS) |
| `B2_ACCOUNTS` | akun-2/3 | JSON array B2 (B2-B + lanjutan), urutan = idx -1/-2/... |
| `R2_ACCOUNTS` | — | **Legacy/removed** (R2 tidak dipakai) |
| `B2_QUOTA_BYTES` | opsional | default 10 GiB per akun |
| `B2_EVICTION_DAYS` | opsional | default 30 |
| `PEER_URLS` | `[vars]` toml | comma-separated 3 worker URLs (owner sharding) |
| `PEER_INDEX` | `[vars]` toml | 0/1/2 — index worker ini di PEER_URLS |
| `EVICTION_OWNER` | `[vars]` akun-1 | `"1"` → akun-1 jalankan cron eviction |
| `DB_FORWARD_KEY` | ✅ secret | internal `/api/_internal` (owner D1) |

### Frontend (`apps/web`)
| Env var | Required | Keterangan |
|---------|----------|------------|
| `NEXT_PUBLIC_API_URL` | dev | `http://localhost:8787` |
| `NEXT_PUBLIC_AUTH_API_URL` | prod | akun-2 worker URL (primary auth, sticky) |
| `NEXT_PUBLIC_SITE_URL` | prod | canonical URL |

---

## 11. Testing

```bash
# DB + matching
cd packages/db && tsx test/matching.test.mjs && tsx test/user-profile.test.mjs

# Sources (pakai fixture HTML/JSON)
cd packages/sources && tsx test/thrive.test.mjs && tsx test/bacakomik.test.mjs && tsx test/manhwaindo.test.mjs

# B2 routing (murmur3 hash-pick + b2KeyFor deterministik)
cd packages/shared && tsx test/r2-routing.test.mjs

# LB crypto + provision
cd packages/lb && tsx test/crypto.test.mjs && tsx test/provision.test.mjs

# Vision
cd packages/vision && tsx test/phash.test.mjs

# Web (Playwright)
cd apps/web && npx playwright test
```
