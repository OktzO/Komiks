---
name: manga
description: "Use saat kerja di project Manga Platform — baca manga Indonesia dari 4 source independen: Komiku (primary), BacaKomik.my, Thrive.moe, ManhwaIndo.my. Invoke sebelum edit kode, deploy, atau jawab pertanyaan struktur/modul/deploy. Berisi peta lengkap: 3 Worker round-robin (akun-1 fallback + akun-2/3 primary, Hono), Next.js frontend (Pages), 5 package (db/shared/sources/lb/vision), D1 schema + 9 migrations, API endpoints (public/reader/auth/user/identify/scrape/admin-monitoring/admin-lb/admin-merge), secrets, commands, LB auto-provision + multi-account, storage 3-tier (B2-A + B2-B multi-account round-robin + R2 ring fallback + LRU eviction), source aggregation (manga_source_link, auto-index), Google OAuth-only auth (KV-free signed HMAC cookie + D1 revocation), session-based admin (SameSite=None __Host-session), profile + status v2 (BetterStack-style), admin dashboard (/admin, /admin/monitoring, /admin/users, /admin/settings), design tokens OKLCH dark, homepage lazy + content-visibility, mobile navbar zero layout-anim."
---

# Manga Platform — Peta Lengkap untuk AI

Platform baca manga/manhwa/manhua bahasa Indonesia. Sumber: Komiku (primary, scrape HTML) + BacaKomik.my (WordPress) + Thrive.moe (Next.js SSG) + ManhwaIndo.my (WordPress) — semua independen, di-aggregate ke 1 manga canonical. Dibangun di Cloudflare: 1 Worker + 1 Next.js Pages + D1 + KV + R2 (fallback) + Backblaze B2 (primary) + Browser rendering.

**Prinsip kunci:**
- **4 source independen.** Komiku, BacaKomik, Thrive, ManhwaIndo masing-masing adapter `SourceAdapter` sendiri di `packages/sources/`. Semua di-scrape HTML (no MangaDex API — dihapus 2026-08-07). Search/home query 4 source paralel, merge by normalized title → 1 manga dengan badge multi-source.
- **Storage 3-tier (B2-A + B2-B multi-account → R2 ring fallback).** Backblaze B2 multi-account: 2 private bucket (`manga-oktz-assets` B2 akun-1 + `manga-oktz-assets-2` B2 akun-2, region `us-east-005`) = primary storage. Upload round-robin: B2-A (`r2_account_idx=-1`) → B2-B (`-2`) → R2 ring (`>=0`). B2 presigned GET 7 hari (SigV4 query auth). R2 multi-account ring = legacy/fallback. Key deterministik `{source}/{slug}/{chapterId}/{pageNo}` (tanpa ekstensi). Hash ring R2 tetap dari slug (satu sumber: `packages/shared/src/r2-routing.ts`). `resolveB2Accounts()` merge `B2_CONFIG` (legacy single) + `B2_ACCOUNTS` (array) → dedup by keyId.
- **LRU storage eviction.** `chapter_pages.last_access` kolom (migration 0009). `evictStaleStorage(env)` di `lib/storageEviction.ts`: hapus objek B2 yang `last_access > 30 hari` (default `B2_EVICTION_DAYS`) ketika quota > 80% (approx row count D1 × 1.6MB). Trigger: every 100th chapter detail request (`eviction:tick` KV counter). R2: lifecycle rule 30 hari prefix `komiku/` (dashboard).
- **Komiku di-rehost (B2/R2); BacaKomik/Thrive/ManhwaIndo tetap 100% proxy** (tidak pernah disimpan). Cache-aside self-healing.
- **3 Worker round-robin (KV-free auth).** `manga-api` (akun-1, fallback + frontend host), `manga-api-2` (akun-2, **primary**), `manga-api-3` (akun-3, **primary**). Frontend `getAuthApiUrl()` health-check akun-2 → akun-3 → akun-1, sticky `sessionStorage('auth_origin')`. D1 split per-akun (tidak sinkron) → sticky origin mitigates. CSP `connect-src` wajib include ketiga workers.dev domain.
- **Auth KV-free (signed HMAC cookie).** OAuth state via signed cookie `__Host-oauth-state` (HMAC-SHA256, nol KV.put). Session via signed cookie `__Host-session` = `{sid, uid, email, role, iat, exp}` + HMAC sig. D1 `sessions` tabel untuk revocation (lazy check: `getSession(sid).revoked_at`). `createSession()` = 1 D1 INSERT (was 2 KV.puts). `getSessionUser()` = HMAC verify + 1 D1 read. `/logout` = D1 `revokeSession(sid)`. Sessions list/revoke = D1-backed, no KV prefix scan.
- **Google OAuth-only auth.** Password auth dihapus. `AuthForm.tsx` = single Google button, dynamic URL via `getAuthApiUrl()`. `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` set di 3 akun. Google Console redirect URIs: `manga-api.oktz.workers.dev` + `manga-api-2.tzok5555.workers.dev` + `manga-api-3.dwikaoktyffan.workers.dev`.
- **Session cookie cross-origin.** `Set-Cookie: __Host-session=...; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800`. Cookie hidup di origin Worker, bukan frontend. Frontend `req.cookies` tidak pernah lihat cookie → `apps/web/middleware.ts` = no-op pass-through. Page guard pakai `fetch('/api/user/me', {credentials:'include'})`. CSRF: mutasi non-GET dengan `Origin` non-allowlist → 403.
- **Admin auth = session role.** `requireAdminSession` cek signed cookie + D1 `users.role==='admin'`. `ADMIN_EMAILS` secret (comma-separated) → auto-assign `role='admin'` saat login.
- **Dark theme OKLCH.** Palette dari oktz.qzz.io. Nav-island style: fixed, blur 18px saturate 1.8. **Mobile:** blur dimatikan (solid `oklch(14% 0 0 / 0.92)`) — fixed full-width backdrop-filter = repaint per scroll frame di Android Chrome.
- **`next-on-pages` butuh `runtime = 'edge'`.** Dynamic pages butuh `export const runtime = 'edge'` + `revalidate`.
- **`ALLOWED_ORIGINS` penting.** Frontend client-side fetch butuh CORS. Set include domain Pages + wildcard `*.manga-web-d32.pages.dev` + `oktzz.xyz` + `www.oktzz.xyz` + `oktz.xyz`.
- **CSP `connect-src` wajib include 3 Worker domain.** `manga-api.oktz.workers.dev` + `manga-api-2.tzok5555.workers.dev` + `manga-api-3.dwikaoktyffan.workers.dev`. Kalau lupa: `getAuthApiUrl()` health check blocked → fallback ke akun-1 saja.
- **Skill ini sumber kebenaran.** README diupdate parallel.

---

## 1. Arsitektur (Diagram Alur)

```
                    ┌─────────────────────────┐
                    │   Cloudflare CDN/WAF    │
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
   ┌──────▼──────┐      ┌────────▼────────┐    ┌────────▼────────┐
   │ apps/web    │      │ apps/api-cf     │    │ Origin Workers  │
   │ Next.js 14  │─────▶│ Hono Worker     │    │ (3 akun CF)     │
   │ (Pages)     │      │ manga-api       │    │ api1, api2, api3│
   │ dark theme  │      │ akun-1 fallback │    │ akun-2/3 primary│
   └─────────────┘      └────────┬────────┘    └────────┬────────┘
                                 │                      │
                           ┌──────┴──────┐        ┌──────┴──────┐
                           ▼             ▼        ▼             ▼
                     ┌─────────┐  ┌──────────┐ ┌────────┐ ┌───────────┐
                     │ D1 DB   │  │ KV cache │ │ R2     │ │ Browser   │
                     │ (SQLite)│  │          │ │fallback│ │ (Puppeteer│
                     └─────────┘  └──────────┘ └────────┘ │  remote)  │
                                                         └───────────┘
                                  │
                           ┌──────┴──────┐
                           ▼             ▼
                     ┌──────────┐  ┌──────────┐
                     │ Komiku   │  │ BacaKomik│
                     │ (scrape) │  │ (scrape) │
                     └──────────┘  └──────────┘
                     ┌──────────┐  ┌──────────┐
                     │ Thrive   │  │ ManhwaIndo│
                     │ (SSG)    │  │ (scrape) │
                     └──────────┘  └──────────┘

                Storage 3-tier (B2 multi-account → R2 fallback):
                ┌─────────────────────────────┐
                │ B2-A (Backblaze akun-1)      │ presigned GET 7 hari,
                │ manga-oktz-assets (private)  │ SigV4 query auth
                │ region us-east-005           │ r2_account_idx = -1
                └─────────────────────────────┘
                ┌─────────────────────────────┐
                │ B2-B (Backblaze akun-2)      │ presigned GET 7 hari,
                │ manga-oktz-assets-2 (private)│ SigV4 query auth
                │ region us-east-005           │ r2_account_idx = -2
                └─────────────────────────────┘
                ┌─────────────────────────────┐
                │ R2 (Cloudflare) FALLBACK     │ public domain direct,
                │ multi-account, hash ring     │ hash slug → akun
                │ r2_account_idx >= 0          │
                └─────────────────────────────┘
                Upload: B2-A → B2-B → R2 ring (round-robin)
                Eviction: LRU >30d when quota >80% → 70%
```

**Frontend round-robin:**
```
User ──> Frontend
  │
  ├─ GET /api/origins (main API) → daftar origin sehat
  ├─ Round-robin client-side ke origin (HANYA allowlisted public paths)
  └─ Fallback: origin gagal → retry origin lain → main API
```

**Reader storage-first (B2 primary → R2 fallback → proxy):**
```
User ──> Frontend
  │
  ├─ Chapter detail → pages: [{proxyUrl, b2Url?, r2Url?}] (D1 lookup)
  ├─ Page img src = b2Url ?? r2Url ?? proxyUrl
  │    ├─ b2Url hit  → https://s3.us-east-005.backblazeb2.com/...?X-Amz-Signature=... (langsung B2, no Worker)
  │    ├─ r2Url hit  → https://cdnN.oktz.qzz.io/... (langsung R2 CDN)
  │    └─ miss/error → proxy /api/reader/:source/page/... (Worker)
  │         └─ Worker: proxy upstream → serve + upload B2 (primary, account_idx=-1) → fallback R2 ring
  └─ Setelah upload: touchChapterDetailKv update KV → next request dapat URL langsung
```

---

## 2. Struktur Direktori (Akurat dari Source)

```
manga-platform/
├── apps/
│   ├── api-cf/                          # Worker tunggal (gabung api+data)
│   │   ├── wrangler.toml                 # D1/KV/R2 + [browser] binding — akun-1 (main, fallback)
│   │   ├── wrangler.origin.toml          # Config akun-2 (primary): D1+KV+browser, NO R2
│   │   ├── wrangler.origin3.toml         # Config akun-3 (primary): D1+KV+browser, NO R2
│   │   ├── package.json                  # + build:bundle script
│   │   ├── dist/worker.js                # ESM bundle untuk auto-provision
│   │   └── src/
│   │       ├── index.ts                  # Hono app, CORS, security headers, rateLimit, route mount
│   │   ├── lib/
│   │       │   ├── context.ts            # Env (DB, CACHE_KV, ASSETS_R2, MY_BROWSER, LB_ENCRYPTION_KEY, ALLOWED_ORIGINS, GOOGLE_CLIENT_ID/SECRET, ADMIN_EMAILS, SCRAPE_API_KEY, R2_ACCOUNTS, R2_RING_VNODES, R2_EVICTION_DAYS, B2_CONFIG [legacy], B2_ACCOUNTS [array 2-item], B2_EVICTION_DAYS)
│   │       │   ├── auth.ts               # KV-free signed HMAC cookie (state + session), D1 sessions revocation, requireSession, requireAdminKey, requireAdminSession, isAdminEmail, hashPassword/verifyPassword [unused]
│   │       │   ├── rateLimit.ts          # makeLimiter factory: rateLimit(60/min), rateLimitIdentify(10/min), rateLimitAdmin(600/min)
│   │       │   ├── retry.ts              # retryUpstream (429 backoff)
│   │       │   ├── r2Accounts.ts         # parse R2_ACCOUNTS secret JSON (urutan = index akun)
│   │       │   ├── b2Config.ts           # parse B2_ACCOUNTS array + B2_CONFIG legacy + resolveB2Accounts() merge + b2AccountForIdx()
│   │       │   ├── s3Upload.ts           # SigV4 signed PUT (R2 + B2) + b2PresignedGet (tanpa @aws-sdk)
│   │       │   ├── storageEviction.ts    # LRU eviction: evictStaleStorage(env) — hapus B2 objek >30d ketika quota >80%
│   │       │   ├── dbWrite.ts            # D1 overflow detector (KV usage tracking, threshold 400MB)
│   │       │   └── komikuSlug.ts         # parse slug dari '<slug>-chapter-<num>'
│   │   └── routes/
│   │       ├── health.ts             # GET /api/health
│   │       ├── search.ts             # GET /api/search (multi-source, passive health)
│   │       ├── series.ts             # GET /api/series, /:slug
│   │       ├── reader.ts             # /api/reader/... + cache-aside R2 upload (komiku)
│   │       ├── origins.ts            # GET /api/origins (public, lazy health check)
│   │       ├── manga.ts              # GET /api/manga/:id (D1 + KV cache)
│   │       ├── homepage.ts           # GET /api/homepage (KV-cached feed, TTL 600s) — file ada, NOT mounted di index.ts (dead)
│   │       ├── sourceStatus.ts       # GET /api/source-status (baca D1, no live ping)
│   │       ├── identify.ts            # POST /api/identify (upload image → phash)
│   │       ├── auth.ts               # GET /me, GET /google, GET /google/callback, POST /logout — login/register REMOVED (OAuth-only)
│   │       ├── user.ts               # /api/user/*: PATCH /me, DELETE /me, GET/POST/DELETE /bookmark[/...], GET/POST/DELETE /history
│   │       ├── internal.ts           # POST /api/db/exec — file ada, NOT mounted di index.ts (dead/admin-only hook)
│   │       └── admin/
│   │           ├── monitoring.ts      # 8 GET endpoints: overview/health/db/users/user-detail/usage/jobs/source-detail (requireAdminSession)
│   │           ├── lb.ts             # LB settings/accounts/origins/status + provision + /usage (requireAdminSession, no step-up)
│   │           ├── merge.ts          # /api/admin/merge/{queue,series} — merge queue manual review (requireAdminSession)
│   │           └── scrape.ts         # POST/GET /api/scrape (per-route requireAdminKey; router.use('*') JANGAN — wildcard match semua subroute)
│   │
│   └── web/                              # Frontend Next.js 14
│       ├── app/                          # App Router
│       │   ├── layout.tsx                # Root layout (nav-island, dark theme, fixed header)
│       │   ├── page.tsx                  # Home (hero v2 tanpa mention sumber + marquee + populer carousel + genre + updates; revalidate 300s; source status di footer)
│       │   ├── globals.css               # OKLCH dark palette + .nav-island style + .marquee + .type-badge-glow + admin tokens + mobile menu fix
│       │   ├── search/page.tsx           # runtime=edge, revalidate 60s, searchMerged
│       │   ├── login/page.tsx            # OAuth-only (Google button)
│       │   ├── bookmark/page.tsx
│       │   ├── history/page.tsx
│       │   ├── profile/page.tsx          # Profile + Account + Preferences + Privacy + Admin sections (Sessions REMOVED)
│       │   ├── status/page.tsx           # Source health (passive, BetterStack-style cards + pulse dot + relative-time)
│       │   ├── admin/page.tsx            # Overview dashboard (admin only, runtime=edge)
│       │   ├── admin/monitoring/page.tsx # Live metrics (admin only, runtime=edge)
│       │   ├── admin/users/page.tsx      # User list (admin only, runtime=edge)
│       │   ├── admin/users/[id]/page.tsx # User detail (admin only, runtime=edge)
│       │   ├── admin/settings/page.tsx   # LB + auto-provision (session guard, NO password step-up; renamed dari /admin/load-balancing)
│       │   ├── admin/load-balancing/page.tsx # legacy redirect → /admin/settings
│       │   └── [source]/s/[slug]/
│       │       ├── page.tsx              # Series detail (runtime=edge): Detail Info pola doujin.desu.xxx (Type flag/Status/Source badge/Author/Genre N/A fallback), genre+author aggregate lintas source (timeout 2s), toolbox island (BookmarkButton + Mulai Baca → chapter 1), generateMetadata + JSON-LD Book, SourceSwitcher dropdown; md+ split poster-kiri (pola komikomi.net)
│       │       ├── loading.tsx           # skeleton
│       │       └── [chapterId]/page.tsx # Reader (scroll + page mode) + SourceSwitcher sticky (switch source → chapter yang sama + ?id)
│       ├── components/
│       │   ├── MangaCard.tsx             # multi-source detection + TypeBadge + SourceBadge in cover
│       │   ├── TypeBadge.tsx             # manga/manhwa/manhua badge: flag 🇯🇵🇰🇷🇨🇳 + border hitam + text putih bercahaya (.type-badge-glow); export TYPE_META
│       │   ├── BookmarkButton.tsx        # toggle bookmark kotak (border putih bg hitam, 44px); cek /api/user/me dulu, guest → /login
│       │   ├── ChapterList.tsx           # sort numeric by chapter_number; default Akhir→Awal (ch1 paling akhir)
│       │   ├── Reader.tsx                # lazy image + skeleton slot + next-chapter prefetch
│       │   ├── ReaderShell.tsx           # Reader wrapper (mode='reader') — fixes pre-existing type error
│       │   ├── AuthForm.tsx              # OAuth-only (single Google button)
│       │   ├── SourceBadge.tsx           # icon-only, 4 source, overflow +N; export SOURCE_ORDER
│       │   ├── SourceSwitcher.tsx        # dropdown (detail) + sticky bar (reader), localStorage pref
│       │   ├── Skeleton.tsx              # shimmer: Detail/Reader/Home skeleton
│       │   ├── Synopsis.tsx
│       │   ├── CoverImage.tsx            # https fallback untuk cover
│       │   ├── Avatar.tsx                # user avatar (Google picture + initials fallback)
│       │   ├── ConfirmModal.tsx          # generic confirm dialog
│       │   └── profile/                  # Profile page sub-sections
│       │       ├── Sidebar.tsx           # "Admin setting" link (admin only), role label (Member/Admin)
│       │       ├── MobileTabs.tsx
│       │       ├── ProfileSection.tsx
│       │       ├── AccountSection.tsx
│       │       ├── PreferencesSection.tsx
│       │       ├── PrivacySection.tsx
│       │       └── AdminSection.tsx      # link ke /admin/settings
│       ├── lib/api.ts                    # API client + round-robin failover (reader/series/manga TIDAK di-failover — main only) + apiGet + roleLabel
│       ├── middleware.ts                 # NO-OP pass-through (cookie di API origin, bukan frontend origin)
│       ├── next.config.mjs               # CSP allows cloudflareinsights.com
│       └── tailwind.config.ts            # OKLCH color tokens + font-display
│
├── packages/
│   ├── db/                               # D1 schema + query helpers
│   │   ├── schema.sql                    # base schema (15 tabel + FTS5 + triggers)
│   │   ├── migrations/0001_manga_data.sql
│   │   ├── migrations/0002_r2_storage.sql   # r2_key, r2_last_access, lb_usage
│   │   ├── migrations/0003_drop_mangadex.sql # hapus data mangadex
│   │   ├── migrations/0004_aggregation.sql   # manga_source_link, manga_merge_queue, alt_titles
│   │   ├── migrations/0005_user_profile.sql  # users: display_name, avatar_url, bio, preferences (commit 342090d)
│   │   ├── migrations/0006_admin_monitoring.sql # users.last_login_at, provider_accounts, scrape_jobs_log, db_usage_snapshot
│   │   ├── migrations/0007_relax_chapter_pages_fk.sql # drop FK chapter_pages.chapter_id → chapters(id) supaya cache-aside upload marker (B2/R2) bisa persist walau chapter row belum ada di D1
│   │   ├── migrations/0008_sessions.sql              # sessions table — KV-free signed-cookie auth revocation
│   │   ├── migrations/0009_chapter_pages_last_access.sql # chapter_pages.last_access + index — LRU eviction
│   │   ├── src/matching.ts               # normalizeTitle + levenshtein + jaroWinkler + matchCandidate (pure)
│   │   ├── test/matching.test.mjs
│   │   ├── seed.sql
│   │   └── index.ts                      # db(d1) factory + 40+ typed helpers (termasuk updateUserProfile, deleteUserAccount, clearUserHistory, clearUserBookmarks, listUserSessions, revokeUserSession — commit 342dd87)
│   ├── shared/
│   │   ├── types.ts                      # Zod schemas (+ SourceLink, MergeQueueItem)
│   │   └── src/r2-routing.ts             # MurmurHash3 + consistent-hash ring (Worker + frontend)
│   ├── sources/                          # Source adapter registry
│   │   ├── index.ts                      # getAdapter(sourceKey, env?) — SourceKey = komiku|bacakomik|thrive|manhwaindo
│   │   ├── komiku/                       # Komiku (fetch+regex, NO Puppeteer)
│   │   │   ├── client.ts                 # KOMIKU_BASE = 'https://komiku.org'
│   │   │   ├── selectors.ts              # KOMIKU_SELECTORS
│   │   │   └── index.ts                  # adapter: search/getSeries/listChapters/fetchPageUrls/scrapeUrl
│   │   ├── bacakomik/                    # WordPress komikcast6; CF Bot Fight → hybrid MY_BROWSER fallback
│   │   │   ├── client.ts                 # BACA_BASE='https://bacakomik.my', fetchHtml hybrid
│   │   │   └── index.ts                  # search(q:'')=homepage listing, .animepost cards
│   │   ├── thrive/                       # Next.js SSG; __NEXT_DATA__ parsing; no bot block
│   │   │   ├── client.ts                 # THRIVE_BASE='https://thrive.moe', parseNextData
│   │   │   └── index.ts                  # search(q:'')=homepage cards; images cdn.thrive.moe/data/{prefix}/{f}
│   │   ├── manhwaindo/                   # WordPress mangareader; CF Bot Fight → hybrid fallback
│   │   │   ├── client.ts                 # MANHWA_BASE='https://www.manhwaindo.my'
│   │   │   └── index.ts                  # .bsx cards, /series/<slug>/, #readerarea imgs
│   │   └── test/{thrive,bacakomik,manhwaindo}.test.mjs  # fixture-based, no network
│   ├── lb/                               # Load balancing
│   │   ├── crypto.ts                     # AES-GCM encrypt/decrypt
│   │   ├── accounts.ts                   # verifyAccountToken, createAccount
│   │   ├── router.ts                     # getLbSettings, getHealthyOrigin
│   │   ├── provision.ts                  # CF API client: auto-provision D1/KV/Worker
│   │   └── test/provision.test.mjs
│   └── vision/                           # Image identification
│       ├── phash.ts
│       ├── hamming.ts
│       └── identify.ts
│
├── scripts/
│   ├── build-worker-bundle.mjs           # esbuild → apps/api-cf/dist/worker.js + seed KV instructions
│   ├── deploy-worker-api.sh              # helper deploy via `wrangler deploy --env akun1|akun2` (commit ff5759c)
│   ├── setup-r2-account.mjs              # panduan akun R2 baru + remap report
│   ├── smoke-db.mjs
│   ├── smoke-data-db.mjs
│   ├── smoke-r2-db.mjs                   # smoke test R2 multi-account
│   └── smoke-user.mjs                    # smoke test /api/user/* (profile, sessions, clear)
│
├── docs/
│   ├── DEPLOY.md
│   ├── ADDING-ACCOUNT.md                 # tambah akun R2 + origin (CORS checklist)
│   └── superpowers/{specs,plans}/        # Design specs + implementation plans
│
├── package.json                          # Root workspace (dev:api, dev:web, build)
├── turbo.json                            # dev:api, dev:web, build (no dev:data)
└── README.md                             # ⚠️ outdated, lihat skill ini
```

---

## 3. Modul Detail

### `apps/api-cf` (Worker Tunggal — manga-api)
**Entry:** `src/index.ts`. Hono app, CORS middleware (allowlist `ALLOWED_ORIGINS`), rateLimit global, route mount `/api/*`. Export `fetch` saja (no cron).

**Env (`lib/context.ts`):** `DB`, `CACHE_KV`, `ASSETS_R2`, `MY_BROWSER` (Fetcher), `LB_ENCRYPTION_KEY` (HMAC sign key), `SCRAPE_API_KEY`, `ALLOWED_ORIGINS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS`, `R2_ACCOUNTS` (secret JSON array), `R2_RING_VNODES` (default 32), `R2_EVICTION_DAYS` (default 30), `B2_CONFIG` (legacy single JSON), `B2_ACCOUNTS` (secret JSON array 2-item: `[{name, keyId, appKey, bucket, region}]`), `B2_EVICTION_DAYS` (default 30). `resolveB2Accounts()` merge `B2_CONFIG` + `B2_ACCOUNTS` → dedup by keyId.

**Lib:**
- `context.ts` — `Env`, `getDb(c)`, `json()`, `parseAllowedOrigins()`, `sha256Hex()`.
- `auth.ts` — **KV-free signed HMAC cookie auth.** `createSession(c, userId, {email, role})` = sign payload `{sid, uid, email, role, iat, exp}` + HMAC-SHA256 + D1 INSERT `sessions`. `getSessionUser(c)` = verify HMAC sig + cek expiry + D1 `getSession(sid).revoked_at` (lazy revocation, 1 D1 read). `setStateCookie`/`verifyStateCookie` = signed OAuth state (nol KV). `requireSession`, `requireAdminKey` (`x-admin-api-key`), `requireAdminSession` (session role check). `hashPassword`/`verifyPassword` tetap ada tapi UNUSED.
- `rateLimit.ts` — `makeLimiter(limit, window)` factory. Export: `rateLimit` (60/min), `rateLimitIdentify` (10/min), `rateLimitAdmin` (600/min).
- `retry.ts` — `retryUpstream()`, 3 attempt, exponential backoff on 429.

**Routes:** lihat section API Endpoints.

### `apps/web` (Next.js 14 Frontend)
**Dark theme OKLCH** (dari oktz.qzz.io reference). Nav-island style: fixed top, `max-width: 1024px`, `rounded-2xl`, `backdrop-filter: blur(18px) saturate(1.8)`, bg `oklch(0 0 0 / 0.66)`.

**Pages:** home, search, login, register, bookmark, history, status, admin LB, series detail, reader. Runtime edge untuk dynamic pages (`runtime = 'edge'` + `revalidate = 60`).

**`lib/api.ts`** — API client + round-robin failover + auth API + R2 direct:
- `API_URL` dari `NEXT_PUBLIC_API_URL` (akun-1 fallback)
- `AUTH_API_URL` = `NEXT_PUBLIC_AUTH_API_URL` (akun-2 primary), `AUTH_FALLBACK` = `NEXT_PUBLIC_AUTH_FALLBACK` (akun-3)
- `getAuthApiUrl()` — health-check round-robin akun-2 → akun-3 → akun-1, sticky `sessionStorage('auth_origin')` 60s TTL
- `setAuthOrigin(origin)` — set sticky origin setelah login
- `fetchMe`/`logout`/`patchMe`/`deleteMe`/`listSessions`/`revokeSession`/`clearHistory`/`clearBookmarks` — pakai `getAuthApiUrl()` (sticky origin)
- `apiGet` — admin monitoring (pakai `API_URL` main)
- `getOrigins()` → fetch `/api/origins`, cache sessionStorage 60s
- `apiWithFailover<T>(path)` — round-robin origin dengan circuit breaker (skip 60s setelah 2 gagal, retry max 2, allowlist path publik)
- `r2UrlFor(slug, chapterId, pageNo)` — URL R2 langsung (ring dari `NEXT_PUBLIC_R2_DOMAINS`)

**R2 cache-aside (di `routes/reader.ts`):** saat page komiku diproxy → `upstream.clone().body` di-upload ke R2 via `s3PutObject` di background (request tetap diserve). Key `komiku/{slug}/{chapterId}/{pageNo}`, hash slug → akun via `accountFor`. Idempoten (key sama → overwrite, race aman). Slug resolve: D1 `getChapter` dulu → cache KV 1 jam → fallback `parseSlugFromChapterId`. **Clone stream SEBELUM `new Response(upstream.body)`** — setelahnya stream terkunci (`ReadableStream locked`).

### `packages/db`
`schema.sql` = base schema. **Migrasi = incremental** (`0001_manga_data.sql`, `0002_r2_storage.sql`, `0003_drop_mangadex.sql`, `0004_aggregation.sql`) — jangan edit schema.sql untuk kolom baru, buat migration baru. `index.ts` = factory `db(d1)` return 40+ method (series CRUD, user, bookmark, history, LB settings/accounts/origins/audit, upsertSeries, image hash, scrape job, source health, **upsertSourceLink, getSourceLinksByManga, getMangaBySource, getAllSeriesTitles, listMergeQueue, addMergeQueue, resolveMergeQueue, mergeSeries, getSeriesById**) + `markPageR2Uploaded()` + `incrementLbUsage()`.

**Matching (`src/matching.ts`):** pure functions `normalizeTitle` (strip noise: komik/comic/manga/season/chapter/vol + trailing chapter number; preserve Korean/Japanese), `levenshtein`, `jaroWinkler` (threshold 0.92), `matchCandidate` → `exact` | `fuzzy` | `queue` (ambiguous, top-2 gap ≤0.05) | `new`.

### `packages/sources`
**Registry (`index.ts`):** `SourceKey = 'komiku' | 'bacakomik' | 'thrive' | 'manhwaindo'`. `getAdapter(sourceKey, env?)` → adapter atau null. `AdapterEnv = { MY_BROWSER?: Fetcher }`.

**Komiku adapter (`komiku/`):** **NO Puppeteer**. Fetch HTML + regex parse. Domain `https://komiku.org`. Search via `api.komiku.org/?s=<q>&post_type=manga`. Type detection dari `.tpe1_inf > b` (manga/manhwa/manhua). Image dari `img.komiku.org` (butuh Referer header). `search({q:''})` = popular listing.

**BacaKomik adapter (`bacakomik/`):** WordPress komikcast6, domain `https://bacakomik.my`. **CF Bot Fight** → `fetchHtml` hybrid: plain fetch, 403/`Just a moment` → fallback `MY_BROWSER.newPage()` Puppeteer. `search({q:''})` = homepage `/` (cards `.animepost`, cover `data-lazy-src`). Detail `/komik/<slug>/`: H1 `.entry-title` (strip "Komik "), `.spe` label pairs, genres `.genre-info a`, chapter `#chapter_list li` (`.lchx` + `.dt` relative date). Chapter page: `#anjay_ini_id_kh img` (single-quote src, rotating CDN: imageainewgeneration.lol/himmga.lat/gaimgame.pics/komikcdn.me). Search URL `/?s=<q>`.

**Thrive adapter (`thrive/`):** Next.js SSG, domain `https://thrive.moe`. **No bot block** (UA cukup). Semua data di `__NEXT_DATA__` (`parseNextData` helper). Detail `/title/<uuid>`: pageProps (title, desc_ID, image, status, author[], tags[], chapterlist[]). Chapter `/read/<uuid>`: pageProps.prefix + image[] → `https://cdn.thrive.moe/data/{prefix}/{f}`. **No server-side search** (`?route=` client-only) → `search({q:''})` = homepage cards (`.line-clamp-2` + `/title/<uuid>` + cover); query non-empty = crawl genre pages + match title.

**ManhwaIndo adapter (`manhwaindo/`):** WordPress mangareader, domain `https://www.manhwaindo.my`. **CF Bot Fight** → hybrid fallback sama BacaKomik. `search({q:''})` = homepage (`.bs .bsx` cards, `typename` class, `data-src` cover). Detail `/series/<slug>/`: H1 `.entry-title`, `.alternative` alt title, `.mgen a` genres, `.imptdt` label pairs (Status/Type), chapter `#chapterlist li[data-num]` (`.chapternum` + `.chapterdate` "6 Agustus 2026"). Chapter page: `#readerarea` imgs (noscript single-quote src).

### `packages/lb`
- `crypto.ts` — AES-GCM 256. `encryptToken()`, `decryptToken()`.
- `accounts.ts` — `verifyAccountToken()`, `createAccount()`.
- `router.ts` — `getLbSettings()`, `getHealthyOrigin()`.
- `provision.ts` — **CF API client untuk auto-provision.** `provisionAccount(env, input)` → verify token, create D1, run migration, create KV, create R2 bucket `ASSETS_R2` (optional, via CF API — gagal → skip, Worker jalan tanpa R2), deploy Worker (ESM bundle dari KV), enable subdomain, set secrets, encrypt+store token, add origin. `checkProvisionStatus(env, jobId)` → job status dari KV. Catatan: R2 **storage** multi-account (`manga-images` + token S3) TIDAK auto-provision — S3 API token cuma dari dashboard.

### `packages/vision`
pHash 64-bit via OffscreenCanvas. `identifyImage()` match hash → series dari D1.

---

## 4. Database Schema (D1 — SQLite)

**15 tabel + 1 FTS5 shadow + sessions.** File: `packages/db/schema.sql` (base) + `migrations/0001_manga_data.sql` + `0002_r2_storage.sql` + `0003_drop_mangadex.sql` + `0004_aggregation.sql` + `0005_user_profile.sql` + `0006_admin_monitoring.sql` + `0007_relax_chapter_pages_fk.sql` + `0008_sessions.sql` (sessions table untuk KV-free auth revocation) + `0009_chapter_pages_last_access.sql` (last_access kolom untuk LRU eviction).

**Tabel utama:** series, chapters, chapter_pages, users, bookmarks, reading_history, lb_settings, lb_accounts, lb_origins, lb_audit_log, image_hashes, scrape_jobs, source_health, r2_last_access, lb_usage, manga_source_link, manga_merge_queue, series_search (FTS5), **sessions** (0008).

**Aggregation (dari `0004_aggregation.sql`):** `series.alt_titles` (JSON, kolom sudah ada sejak 0001); `manga_source_link(manga_id FK→series, source, source_slug, has_chapter_list, chapter_count, last_scraped_at, UNIQUE(source,source_slug))`; `manga_merge_queue(source, source_slug, title, candidate_ids JSON, confidence, status pending|merged|rejected)`.

**Kolom/tabel R2 (dari `0002_r2_storage.sql`):** `chapter_pages.r2_key` + `chapter_pages.r2_account_idx`; `r2_last_access(r2_key, account_idx, last_viewed, created_at)` (last-view per object, granularity chapter); `lb_usage(origin_url, date_key, req_count, updated_at)` (quota per origin per hari, composite PK `(origin_url, date_key)`).

**Enum:** `SeriesType = manga|manhwa|manhua`. `SeriesStatus = ongoing|completed|hiatus|cancelled`. `UserRole = user|admin`. `LbProvider = cloudflare|vercel`.

---

## 5. API Endpoints (Worker Tunggal — manga-api)

**Public:**
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/health` | `{status:"ok", ts}` |
| GET | `/api/search?q=<q>` | Search multi-source (**4 source**: Komiku+BacaKomik+Thrive+ManhwaIndo), merge by normalized title → badge multi-source; empty q = homepage feed (live listing + local D1), passive health record, KV cache 300s |
| GET | `/api/series?genre=&page=&limit=` | List series (D1) |
| GET | `/api/series/:slug` | Detail by slug (D1 + KV) |
| GET | `/api/manga/:id` | Manga meta by slug (D1 + KV 3600s) |
| GET | `/api/source-status` | Baca D1 passive health (komiku, bacakomik, thrive, manhwaindo), no live ping |
| GET | `/api/origins` | Daftar origin sehat (lazy health check 5s, KV cache 30s) |

**Reader:**
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/reader/:source/series/:sourceId` | Series dari source (KV 600s) |
| GET | `/api/reader/:source/series/:sourceId/chapters?lang=id` | Chapter list (KV 300s) |
| GET | `/api/reader/:source/series/:sourceId/sources` | **Aggregated sources**: D1 `manga_source_link` → live-resolve fallback (search title di source lain, exact match preferred) + **auto-index persist D1 background**. KV 600s. |
| GET | `/api/reader/:source/chapter/:chapterId` | Chapter + proxy page URLs (KV 300s) |
| GET | `/api/reader/:source/page/:chapterId/:pageNo` | Image proxy (Komiku: +Referer header + upload R2 background; source lain: stream, no rehost) |

**Auth (OAuth-only, password removed):**
| Method | Path | Deskripsi |
|--------|------|-----------|
| POST | `/api/auth/logout` | Hapus session |
| GET | `/api/auth/google` | Redirect ke Google OAuth consent screen |
| GET | `/api/auth/google/callback` | OAuth callback → `avatar_url` dari `gUser.picture`; update `users.last_login_at`; auto-assign `role='admin'` jika email di `ADMIN_EMAILS`. |
| ~~POST~~ | ~~`/api/auth/register`~~ | REMOVED (commit b2b9866) |
| ~~POST~~ | ~~`/api/auth/login`~~ | REMOVED (commit b2b9866) |

**User (auth required, kecuali GET `/me`):**
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/user/me` | Current user; **guest-friendly** return `{data:null}` (commit edc813d). Tanpa session guard. |
| PATCH | `/api/user/me` | Update profile `{display_name?, bio?, preferences?, avatar_url?}` (commit 4e008ed) |
| DELETE | `/api/user/me` | Hapus akun permanen. Body `{confirm:'DELETE'}` literal (commit 4e008ed) |
| POST | `/api/user/bookmark` | `{seriesSlug}` |
| DELETE | `/api/user/bookmark/:slug` | Hapus bookmark |
| GET | `/api/user/bookmarks` | List |
| DELETE | `/api/user/bookmarks` | Clear all |
| POST | `/api/user/history` | `{chapterId,lastPage}` |
| GET | `/api/user/history` | List history |
| DELETE | `/api/user/history` | Clear all |
| GET | `/api/user/sessions` | List active sessions (current + others) |
| DELETE | `/api/user/sessions/:token` | Revoke specific session |
| POST | `/api/user/sessions/revoke-all` | Revoke semua kecuali current → `{revoked:N}` |

**Identify (rate limit 10/min):**
| Method | Path | Deskripsi |
|--------|------|-----------|
| POST | `/api/identify` | Upload gambar → phash → match series. Max 10MB. |

**Scrape (admin key `x-admin-api-key`, rate 600/min):**
| Method | Path | Deskripsi |
|--------|------|-----------|
| POST | `/api/scrape` | `{source, url?, query?}`. Buat job, jalankan adapter. |
| GET | `/api/scrape` | List scrape jobs. |
| GET | `/api/scrape/:job_id` | Status job. |

**Admin LB (`requireAdminSession` — session role check, NO password step-up):**
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET/PUT | `/api/admin/lb/settings` | Mode, implementation, steering |
| GET/POST | `/api/admin/lb/accounts` | List / tambah akun manual |
| POST | `/api/admin/lb/accounts/provision` | **Auto-provision** D1+Worker baru. Body: `{label, cfApiToken, workerName?}`. Return `{job_id}`. |
| GET | `/api/admin/lb/accounts/:id/provision-status` | Poll status provision job |
| DELETE | `/api/admin/lb/accounts/:id` | Hapus akun |
| POST | `/api/admin/lb/accounts/:id/test` | Test koneksi |
| GET/POST | `/api/admin/lb/origins` | List / tambah origin |
| PUT | `/api/admin/lb/origins/:id` | Update |
| GET | `/api/admin/lb/status` | Status realtime per origin |
| GET | `/api/admin/lb/usage` | Aggregate LB usage dari `lb_usage` D1 |

**Admin Monitoring (`requireAdminSession`, rate limit 600/min):**
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/admin/overview` | Stats ringkas: user count, chapter count, source health summary, recent jobs |
| GET | `/api/admin/health` | Health detail semua origin + adapter |
| GET | `/api/admin/db` | D1 size, row counts per table, last vacuum |
| GET | `/api/admin/users` | List users (paginated, search by email/name) |
| GET | `/api/admin/users/:id` | User detail (profile + bookmarks + history + sessions) |
| GET | `/api/admin/usage` | Aggregate LB usage + R2 storage breakdown |
| GET | `/api/admin/jobs` | Scrape jobs log (last N, filter by status) |
| GET | `/api/admin/source-detail/:source` | Per-source detail: chapters, health history, recent errors |

**Admin Merge (`requireAdminSession`):**
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/admin/merge/queue?status=pending` | List `manga_merge_queue` |
| POST | `/api/admin/merge/queue/:id` | `{action:'merge'\|'reject', targetMangaId?}` — merge pindahkan link+chapters ke target, reject tutup |
| POST | `/api/admin/merge/series` | `{targetSlug, sourceSlug}` — manual merge 2 series |

---

## 6. Environment Variables & Secrets

### Production (via `wrangler secret put` — set di 3 akun)
**manga-api (akun-1) + manga-api-2 (akun-2) + manga-api-3 (akun-3):**
- `LB_ENCRYPTION_KEY` — HMAC sign key untuk session/state cookie (32-byte random hex)
- `GOOGLE_CLIENT_ID` — `552946613891-hcc6nh35d52tfjfsr7ijcigkoqbinhl9.apps.googleusercontent.com`
- `GOOGLE_CLIENT_SECRET` — `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`
- `ALLOWED_ORIGINS` — `https://oktzz.xyz,https://www.oktzz.xyz,https://oktz.xyz,https://manga-web-d32.pages.dev,https://*.manga-web-d32.pages.dev,http://localhost:3000`
- `ADMIN_EMAILS` — comma-separated email yang auto-dapat role admin
- `SCRAPE_API_KEY` — admin API key untuk `/scrape`
- `B2_ACCOUNTS` — JSON array 2-item: `[{"name":"b2-a","keyId":"005336d7589ff330000000002","appKey":"***REMOVED***","bucket":"manga-oktz-assets","region":"us-east-005"},{"name":"b2-b","keyId":"005b86aeb2be76b0000000004","appKey":"***REMOVED***","bucket":"manga-oktz-assets-2","region":"us-east-005"}]`
- `R2_ACCOUNTS` — JSON array akun R2: `[{"account_id","access_key_id","secret_access_key","public_domain","bucket?"}]` (akun-1 only, R2 butuh CC verif)
- `R2_RING_VNODES` — vnode hash ring (default 32)
- `R2_EVICTION_DAYS` — TTL lifecycle R2 (default 30, prefix `komiku/`)
- `B2_EVICTION_DAYS` — LRU eviction threshold days (default 30)
- (No `MANGADEX_API_KEY` — dihapus 2026-08-07.)

### Frontend (`apps/web/.env.production`)
```env
NEXT_PUBLIC_API_URL=https://manga-api.oktz.workers.dev
NEXT_PUBLIC_DATA_API_URL=https://manga-api.oktz.workers.dev
NEXT_PUBLIC_AUTH_API_URL=https://manga-api-2.tzok5555.workers.dev
NEXT_PUBLIC_AUTH_FALLBACK=https://manga-api-3.dwikaoktyffan.workers.dev
NEXT_PUBLIC_SITE_URL=https://manga-web-d32.pages.dev
NEXT_PUBLIC_R2_DOMAINS=https://cdn1.oktz.qzz.io   # urutan = index akun, sama dengan R2_ACCOUNTS
NEXT_PUBLIC_R2_VNODES=32
```

### Wrangler bindings (`apps/api-cf/wrangler.toml` — akun-1)
- `DB` → D1 `manga-db` (id: `76606365-0fa5-4c1e-9b55-18a8366ef92a`)
- `CACHE_KV` → KV (id: `6205fceab7b64f9d80f6f67e4189316b`)
- `ASSETS_R2` → R2 `manga-assets`
- `MY_BROWSER` → Browser binding (`remote = true`)
- **No cron** (dihapus)

### Wrangler bindings (`apps/api-cf/wrangler.origin.toml` — akun-2)
- `DB` → D1 `manga-db` (id: `61cbf1b1-508e-4b00-a0e6-dd68528e54ba`)
- `CACHE_KV` → KV (id: `cf560313c1204ec08f174c8924ad3118`)
- `MY_BROWSER` → Browser binding (`remote = true`)
- NO R2 (akun-2 tidak punya R2, by design)

### Wrangler bindings (`apps/api-cf/wrangler.origin3.toml` — akun-3)
- `DB` → D1 `manga-db` (id: `160d0a4f-fcc1-4cb6-89e2-c65bcc93a340`)
- `CACHE_KV` → KV (id: `0412740b508240e99f9b68dd51f3fba3`)
- `MY_BROWSER` → Browser binding (`remote = true`)
- NO R2 (akun-3 butuh CC verif, skip)

### KV keys penting
- `worker-bundle:latest` — base64 ESM bundle untuk auto-provision (seed via `npm run build:bundle` + `wrangler kv key put`)
- `provision:{jobId}` — status job provision (TTL 3600s)
- `origins:healthy` — cache daftar origin sehat (TTL 30s)
- `search:{hash}` — cache search result (TTL 120s)
- `series:detail:{source}:{id}` — cache series detail (TTL 600s)
- `source:health:{source}` — cache passive health (TTL 60s)

---

## 7. Deploy ke Production

**Prasyarat:** Cloudflare account, `CLOUDFLARE_API_TOKEN` env var, Node 18+.

### Deploy Worker (3 akun)
```bash
# Akun-1 (main, fallback)
CLOUDFLARE_API_TOKEN="***REMOVED***" npx wrangler deploy --config apps/api-cf/wrangler.toml
# Akun-2 (primary)
CLOUDFLARE_API_TOKEN="***REMOVED***" npx wrangler deploy --config apps/api-cf/wrangler.origin.toml
# Akun-3 (primary)
CLOUDFLARE_API_TOKEN="***REMOVED***" npx wrangler deploy --config apps/api-cf/wrangler.origin3.toml
```

### Deploy Frontend (Pages)
```bash
cd apps/web
rm -rf .next .vercel
NEXT_PUBLIC_API_URL=https://manga-api.oktz.workers.dev \
NEXT_PUBLIC_DATA_API_URL=https://manga-api.oktz.workers.dev \
NEXT_PUBLIC_AUTH_API_URL=https://manga-api-2.tzok5555.workers.dev \
NEXT_PUBLIC_AUTH_FALLBACK=https://manga-api-3.dwikaoktyffan.workers.dev \
npx next-on-pages
CLOUDFLARE_API_TOKEN="<token-akun-1>" npx wrangler pages deploy .vercel/output/static --project-name manga-web --branch main
```

### Build + seed worker bundle (untuk auto-provision)
```bash
node scripts/build-worker-bundle.mjs   # → apps/api-cf/dist/worker.js
export CLOUDFLARE_API_TOKEN="<token>"
base64 -w0 apps/api-cf/dist/worker.js > /tmp/opencode/bundle.b64
npx wrangler kv key put --namespace-id=6205fceab7b64f9d80f6f67e4189316b "worker-bundle:latest" --path=/tmp/opencode/bundle.b64
npx wrangler kv key put --namespace-id=6205fceab7b64f9d80f6f67e4189316b "provision:schema:latest" --path=packages/db/schema.sql
npx wrangler kv key put --namespace-id=6205fceab7b64f9d80f6f67e4189316b "provision:migration:latest" --path=packages/db/migrations/0001_manga_data.sql
```
(Bundle base64 ~143KB — jangan via argumen shell, pakai `--path=`.)

### Set secrets
```bash
export CLOUDFLARE_API_TOKEN="<token>"
echo -n "<password>" | npx wrangler secret put ADMIN_PASSWORD_HASH --config apps/api-cf/wrangler.toml
echo -n "<key>" | npx wrangler secret put SCRAPE_API_KEY --config apps/api-cf/wrangler.toml
echo -n "<32-byte>" | npx wrangler secret put LB_ENCRYPTION_KEY --config apps/api-cf/wrangler.toml
echo -n '<R2_ACCOUNTS-JSON>' | npx wrangler secret put R2_ACCOUNTS --config apps/api-cf/wrangler.toml
echo -n "https://manga-web-d32.pages.dev,http://localhost:3000" | npx wrangler secret put ALLOWED_ORIGINS --config apps/api-cf/wrangler.toml
```

### Migrasi D1 remote (setelah deploy schema baru)
```bash
export CLOUDFLARE_API_TOKEN="<token>"
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0002_r2_storage.sql
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0003_drop_mangadex.sql
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0004_aggregation.sql
# Akun-2 (origin LB): tambah CLOUDFLARE_ACCOUNT_ID=6a0bdfb8bccff744bd738a57502d0380 + token akun-2
```

### Verifikasi post-deploy
- `GET /api/health` → `{status:"ok"}`
- `GET /api/origins` → daftar origin
- `GET /api/search?q=naruto` → hasil 4 source (komiku, bacakomik, thrive, manhwaindo)
- `GET /api/search?q=` → homepage feed 4 source (~60 item, multi-source badges)
- `GET /api/source-status` → passive health 4 source
- `/admin/settings/load-balancing` → panel LB + auto-provision

---

## 8. Security

- **Rate limiting:** public 60/min, identify 10/min, scrape 600/min, admin 600/min. Per-IP via KV counter.
- **CORS:** allowlist `ALLOWED_ORIGINS` — support wildcard subdomain `https://*.manga-web-d32.pages.dev` (CF Pages preview/hash domain). Match logic di `lib/context.ts` `allowedOriginFor` + `originMatches` (entry `://*.`). **Worker 500/exception → response tanpa CORS header → browser menampilkan "TypeError: Failed to fetch"** (bukan 5xx). Kalau user lihat error ini di halaman client-fetch (admin, reader), cek dulu origin domain ≠ allowlist. Bug umum: domain frontend ada tapi subdomain (`www.`) atau domain lama (`oktz.xyz` vs `oktzz.xyz`) terlewat → tambah semua variant ke secret.
- **Admin auth = session role.** `requireAdminSession` cek session KV + D1 `users.role==='admin'`. TIDAK ada password step-up. `ADMIN_PASSWORD_HASH` secret tetap di wrangler tapi unused (jangan pakai).
- **Admin key (scrape):** `x-admin-api-key` === `SCRAPE_API_KEY`. Constant-time compare. PER-ROUTE middleware (bukan `router.use('*')` — wildcard match semua subroute dan blok endpoint lain).
- **Token encryption:** AES-GCM 256. Layout BLOB: `[12-byte iv | ciphertext+tag]`.
- **Password hash:** PBKDF2 (100k iter, SHA-256). Format: `pbkdf2:<iter>:<hex-salt>:<hex-hash>`. **UNUSED** — auth sekarang OAuth-only. Jangan tambah endpoint password.
- **Session:** **KV-free signed HMAC cookie.** Cookie `__Host-session` = `{sid, uid, email, role, iat, exp}` base64url + HMAC-SHA256 sig (key: `LB_ENCRYPTION_KEY`). D1 `sessions` tabel untuk revocation (lazy check: `getSession(sid).revoked_at IS NULL`). TTL 7 hari fix di payload `exp`. `createSession()` = 1 D1 INSERT (was 2 KV.puts). `getSessionUser()` = HMAC verify + 1 D1 read. `listSessionsForUser`/`revokeSessionForUser` = D1-backed, no KV. Cross-origin (frontend oktzz.xyz ↔ Worker manga-api-*.workers.dev).
- **Image proxy:** Komiku butuh `Referer: https://komiku.org/` (CDN 403 tanpa itu). BacaKomik/ManhwaIndo image butuh Referer base-nya. Stream. SSRF guard: allowlist host per source (`img.komiku.org`, `i0-3.wp.com`, `imageainewgeneration.lol`, `himmga.lat`, `gaimgame.pics`, `komikcdn.me`, `kacu.gmbr.pro`, `upload.gmbr.pro`, `cdn.thrive.moe`, `backup.thrive.moe`, `kuma.thrive.moe`) + blokir private IP (`10.*`, `192.168.*`, `127.*`, `169.254.169.254`, localhost). **No uploads.mangadex.org** (mangadex dihapus).
- **R2 upload (komiku saja):** SigV4 signed PUT ke bucket akun lain, tanpa @aws-sdk (bundle Worker batas 3MB gzip, dan bundle di-deploy ke banyak akun). Token R2 **Object Read & Write** cukup (bukan Admin). Kredensial hanya di secret `R2_ACCOUNTS` — jangan pernah di commit atau di env frontend. **Source lain (BacaKomik/Thrive/ManhwaIndo) 100% proxy, tidak di-rehost.**
- **R2-first, proxy fallback:** frontend coba URL R2 langsung; error → proxy Worker (yang sekaligus upload) → self-healing, request berikutnya dari R2 lagi.
- **Auto-provision:** CF API token di-encrypt sebelum store. Worker baru set `ALLOWED_ORIGINS` = domain frontend. Origin akun-2: D1+KV saja, R2 binding di-skip (akun tanpa R2) — tapi deploy bundle + B2_CONFIG secret agar serve storage URLs dari chapter detail.
- **B2 (Backblaze) multi-account primary storage.** 2 private bucket: `manga-oktz-assets` (B2 akun-1, keyId `005336d7...`) + `manga-oktz-assets-2` (B2 akun-2, keyId `005b86ae...`), region `us-east-005`. Upload round-robin: B2-A (`r2_account_idx=-1`) → B2-B (`-2`) → R2 ring (`>=0`). Presigned GET 7 hari via SigV4 query auth. `B2_ACCOUNTS` secret JSON array 2-item. `resolveB2Accounts()` merge `B2_CONFIG` (legacy) + `B2_ACCOUNTS` (new) → dedup by keyId. LRU eviction: `evictStaleStorage()` hapus objek `last_access > 30d` ketika quota > 80% (approx row count × 1.6MB). Trigger: every 100th chapter detail request.
- **B2 upload idempotent + race aman** (key sama → overwrite). Background upload di `waitUntil` — response user tidak tunggu. Failed B2-A → B2-B → R2 ring (silent fallback).

---

## 9. Commands

### Local dev
```bash
# Worker (port 8787)
cd apps/api-cf && npx wrangler dev --port 8787 --local

# Web (port 3000)
cd apps/web && npx next dev --port 3000
```

### Setup D1 local
```bash
npx wrangler d1 execute manga-db --local --file=packages/db/schema.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0001_manga_data.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0002_r2_storage.sql
```

### Setup akun R2 baru
```bash
# Panduan langkah manual + remap report (key yang pindah akun)
node scripts/setup-r2-account.mjs

# Lifecycle rule per akun R2 (prefix komiku/, Days = R2_EVICTION_DAYS)
npx wrangler r2 bucket lifecycle set manga-images --file - <<'EOF'
{ "Rules": [ { "ID": "evict-komiku", "Status": "Enabled",
    "Filter": { "Prefix": "komiku/" },
    "Expiration": { "Days": 30 } } ] }
EOF
```

### Typecheck
```bash
npx tsc --noEmit -p apps/api-cf    # pre-existing error auth.ts/crypto.ts/caches.default OK
npx tsc --noEmit -p apps/web
npx tsc --noEmit -p packages/db
npx tsc --noEmit -p packages/sources
npx tsc --noEmit -p packages/lb
npx tsc --noEmit -p packages/vision
```

### Build
```bash
# Worker bundle (untuk auto-provision)
npx esbuild apps/api-cf/src/index.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=apps/api-cf/dist/worker.js --minify --tsconfig=apps/api-cf/tsconfig.json

# Web (Pages)
cd apps/web && npx next build && npx next-on-pages
```

---

## 10. Gotchas & Hal Penting

- **1 Worker, bukan 2.** `apps/data-api` sudah dihapus, digabung ke `apps/api-cf`. Tidak ada cron.
- **Dead routes (intentional, jangan mount).** `apps/api-cf/src/routes/homepage.ts` dan `internal.ts` ada di disk tapi **tidak di-mount** di `index.ts`. Homepage feed served via `search.ts` (`q=""`). Internal untuk hook admin-only via CF API langsung. Kalau mau aktifkan: tambah `app.route('/api/homepage', homepageRouter)` di `index.ts`.
- **Komiku no Puppeteer.** Adapter pakai fetch HTML + regex. Domain `komiku.org` (bukan `.id`). Search via `api.komiku.org`. Image butuh Referer header.
- **Komiku type detection.** Search: `.tpe1_inf > b` (manga/manhwa/manhua). Detail: row `Tipe:` sering noise double-label `<td>Tipe:</td><td>Tema:</td>` → parser hanya terima value eksplisit manga/manhwa/manhua + fallback regex cover horizontal `manga_img_horizontal-{Type}-` (mis. `...-Manhua-Magic-Emperor.png`). Detail page komiku TIDAK selalu punya tipe yang benar (solo-leveling → fallback 'manga').
- **Status page v2** (`apps/web/app/status/page.tsx`): BetterStack-style — pulse dot + relative time + latency grade (good<1500ms, mid<3500ms, bad≥3500ms) + chevron. `revalidate=30s` (sebelumnya 60s). Stale detection: relative time >1 jam → label merah.
- **Passive health.** `source_health` dicatat saat user search/reader. No cron, no dedicated ping. `last_checked_at` = aktivitas terakhir.
- **LB auto-provision.** Admin input CF API token → auto-create D1+KV+Worker + R2 bucket `ASSETS_R2` (optional, via CF API). **R2 storage multi-account (`manga-images` + S3 token) TIDAK bisa auto-provision** — R2 S3 API token cuma dari dashboard → setup manual via `scripts/setup-r2-account.mjs`. Worker bundle dibaca dari KV `worker-bundle:latest`. Subdomain `workers.dev` auto-enable via API.
- **Round-robin client-side + circuit breaker.** Frontend `apiWithFailover()`: skip origin 60s setelah 2 gagal beruntun (429/5xx/timeout), retry max 2, fallback main API. Hanya path publik (allowlist) yang dipanggil ke origin; endpoint admin/scrape tidak pernah dari klien. Cache origin list 60s sessionStorage.
- **Komiku di-rehost R2, source lain (BacaKomik/Thrive/ManhwaIndo) 100% proxy** (keputusan user 2026-08-07). Jangan upload page non-Komiku ke R2.
- **Auto-index aggregation.** Saat user buka manga, `/sources` live-resolve (search title di source lain, exact match preferred) + persist D1 background (`waitUntil` upsert series + manga_source_link) → indeks terbangun dari aktivitas user tanpa scrape manual. Cache KV 600s per (source, sourceId).
- **Key R2 deterministik, tanpa ekstensi:** `komiku/{slug}/{chapterId}/{pageNo}`. Hash = **slug manga** → semua page 1 series ke 1 akun (satu hit hash per series). Urutan `R2_ACCOUNTS` == `NEXT_PUBLIC_R2_DOMAINS` **wajib sama** — index = identitas akun.
- **Hash ring shared** (`packages/shared/src/r2-routing.ts`): MurmurHash3 pure JS, deterministik Worker+browser (satu sumber kebenaran, jangan duplikasi). Bangun ring sekali per request/halaman, jangan per key. Nambah/kurang akun meremap ~1/N key → self-healing via cache-aside.
- **Clone stream SEBELUM `new Response(upstream.body)`** — setelah Response dibuat, stream terkunci (`ReadableStream locked to a reader`). Upload R2 idempoten (key sama → overwrite, race 2 request aman).
- **S3 SignedHeaders urutan alfabetis** (`content-type;host;x-amz-content-sha256;x-amz-date`), canonical request wajib cocok — salah urutan → `403 SignatureDoesNotMatch`.
- **R2 API token dashboard-only** (tidak lewat CF API) + akun tanpa kartu kredit (CC) tidak bisa R2 → cukup D1+KV+Worker (origin API round-robin). Connect custom domain = `POST /domains/custom` body `{domain, enabled, zoneId}`.
- **Eviction R2 = lifecycle age-based** (prefix `komiku/`, Days = `R2_EVICTION_DAYS`); r2.dev rate-limited → custom domain wajib. Tidak ada delete via Worker.
- **Quota LB di D1 (`lb_usage`)** — KV cuma 1.000 writes/day, tidak cukup buat hit counter per origin.
- **Dark theme OKLCH.** Palette: bg `oklch(8%)`, card `oklch(12%)`, border putih 8-14%. Nav-island: fixed, blur 18px saturate 1.8. **At-rest mobile = tepel full-width, scrolled desktop (md+) = pill island.** Lihat gotcha mobile shape-change.
- **`next-on-pages` butuh `runtime = 'edge'`.** Dynamic pages (search, series detail) butuh `export const runtime = 'edge'` + `revalidate`. Jangan pakai `force-dynamic` (konflik).
- **`ALLOWED_ORIGINS` penting.** Frontend client-side fetch butuh CORS. Set include domain Pages + wildcard `*.manga-web-d32.pages.dev` (preview URL per deploy). Kalau lupa: admin page → "TypeError: Failed to fetch".
- **Worker bundle size.** ~65KB minified. Seed ke KV manual setelah build.
- **Deploy helper `scripts/deploy-worker-api.sh`** (commit ff5759c): build bundle + `wrangler deploy --env akun1|akun2`. Token harus punya scope `Workers Scripts:Edit` — account-scoped token (role Super Admin) bisa wrangler deploy, tapi user-scoped token (template `Edit Cloudflare Workers`) perlu script:edit permission. Token di script hardcode — rotasi dulu kalau di-share.
- **Google OAuth.** `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` set di 3 akun (sama). Google Console redirect URIs: `https://manga-api.oktz.workers.dev/api/auth/google/callback` + `https://manga-api-2.tzok5555.workers.dev/api/auth/google/callback` + `https://manga-api-3.dwikaoktyffan.workers.dev/api/auth/google/callback`. OAuth state via signed cookie `__Host-oauth-state` (HMAC, nol KV). Callback: verify state cookie → exchange code → upsert user → D1 INSERT session → set signed session cookie → redirect ke frontend.
- **Admin role auto-assign.** Email yang ada di secret `ADMIN_EMAILS` (comma-separated) otomatis dapat `role='admin'` saat register/login. Tidak perlu SQL manual.
- **Profile page sections** (`/profile`): Sidebar desktop + MobileTabs untuk section Profile/Account/Preferences/Privacy/Admin (admin-only section hidden untuk non-admin). **Sessions section REMOVED** (commit 2e8c179). Hamburger navbar expose "Profile" untuk semua user, "Admin setting" admin-only (was "Load Balancing").
- **Navbar mobile fix** (commit 2e8c179): full-width drawer, body scroll lock (`document.body.style.overflow='hidden'` toggle), ESC handler, 40px min-height untuk touch targets, 16px font (no iOS zoom). Struktur desktop **TIDAK DIUBAH** — user directive: "navbar jangan kau otakatik sama sekali".
- **`apps/web/middleware.ts` no-op** (commit 7229658): cookie session ada di Worker origin (`manga-api.oktz.workers.dev`), bukan frontend (`oktzz.xyz`). `req.cookies` di frontend tidak pernah lihat cookie → middleware pass-through. Page guard pakai `fetch('/api/user/me', {credentials:'include'})`. Jangan tambah logic di middleware.
- **D1 origin terpisah.** Worker auto-provision punya D1 sendiri (tidak share). Data tidak sinkron. Frontend fallback ke main API kalau origin error.
- **`requireAdminKey` per-route.** `router.use('*', requireAdminKey)` WILDCARD MATCH semua subroute di router dan blok endpoint `/api/admin/scrape-jobs`. Pakai `app.post('/scrape', requireAdminKey, ...)` + `app.get('/scrape', requireAdminKey, ...)` di route definition (lihat `routes/admin/scrape.ts`).

---

## 11. Quick Reference — Ubah Kode Di Mana?

| Mau ubah... | Edit file ini |
|-------------|---------------|
| Endpoint public (search, reader, origins, manga, source-status) | `apps/api-cf/src/routes/*.ts` |
| Endpoint admin LB + auto-provision | `apps/api-cf/src/routes/admin/lb.ts` |
| Endpoint admin monitoring (8 GET) | `apps/api-cf/src/routes/admin/monitoring.ts` |
| Endpoint admin merge queue | `apps/api-cf/src/routes/admin/merge.ts` |
| Endpoint scrape | `apps/api-cf/src/routes/admin/scrape.ts` |
| Endpoint identify | `apps/api-cf/src/routes/identify.ts` |
| Endpoint user profile / bookmark / history / clear | `apps/api-cf/src/routes/user.ts` |
| Auth (KV-free signed HMAC cookie, D1 sessions revocation, Google OAuth) | `apps/api-cf/src/lib/auth.ts` |
| D1 overflow detector (KV tracking) | `apps/api-cf/src/lib/dbWrite.ts` |
| Env type Worker | `apps/api-cf/src/lib/context.ts` |
| Rate limit | `apps/api-cf/src/lib/rateLimit.ts` |
| D1 schema | `packages/db/schema.sql` |
| D1 query helpers (12 admin monitoring helpers + 40+ base) | `packages/db/index.ts` |
| User profile migration (avatar/bio/prefs) | `packages/db/migrations/0005_user_profile.sql` |
| Admin monitoring migration (last_login_at, provider_accounts, scrape_jobs_log, db_usage_snapshot) | `packages/db/migrations/0006_admin_monitoring.sql` |
| Drop FK chapter_pages → chapters (cache-aside upload marker) | `packages/db/migrations/0007_relax_chapter_pages_fk.sql` |
| Sessions table (KV-free auth revocation) | `packages/db/migrations/0008_sessions.sql` |
| chapter_pages.last_access (LRU eviction) | `packages/db/migrations/0009_chapter_pages_last_access.sql` |
| Profile page (profile, account, prefs, privacy, admin) | `apps/web/app/profile/page.tsx` |
| Profile sub-sections (sidebar/tabs) | `apps/web/components/profile/*.tsx` |
| Admin LB page (no password step-up) | `apps/web/app/admin/settings/page.tsx` |
| Admin overview / monitoring / users page | `apps/web/app/admin/{page.tsx,monitoring/page.tsx,users/page.tsx,users/[id]/page.tsx}` |
| Status page (BetterStack-style cards) | `apps/web/app/status/page.tsx` |
| Hash ring R2 (shared, jangan duplikasi) | `packages/shared/src/r2-routing.ts` |
| R2 account config (secret JSON) | `apps/api-cf/src/lib/r2Accounts.ts` |
| B2 config parse (B2_ACCOUNTS array + B2_CONFIG legacy + resolveB2Accounts merge) | `apps/api-cf/src/lib/b2Config.ts` |
| S3 SigV4 upload (R2 + B2) + B2 presigned GET | `apps/api-cf/src/lib/s3Upload.ts` |
| Storage LRU eviction (evictStaleStorage) | `apps/api-cf/src/lib/storageEviction.ts` |
| Parse slug dari chapterId | `apps/api-cf/src/lib/komikuSlug.ts` |
| Cache-aside storage upload (B2-A → B2-B → R2 round-robin) + touch KV + LRU touch | `apps/api-cf/src/routes/reader.ts` |
| Frontend API client + auth round-robin (getAuthApiUrl) + R2 direct + apiGet | `apps/web/lib/api.ts` |
| Setup akun R2 baru | `scripts/setup-r2-account.mjs` + `docs/ADDING-ACCOUNT.md` |
| Migrasi D1 (r2_key, lb_usage) | `packages/db/migrations/0002_r2_storage.sql` |
| Shared types (Zod) | `packages/shared/types.ts` |
| Tambah source baru | `packages/sources/<name>/` + daftar di `packages/sources/index.ts` |
| Komiku adapter (search, parse, selectors) | `packages/sources/komiku/{index,client,selectors}.ts` |
| BacaKomik adapter | `packages/sources/bacakomik/{index,client}.ts` |
| Thrive adapter | `packages/sources/thrive/{index,client}.ts` |
| ManhwaIndo adapter | `packages/sources/manhwaindo/{index,client}.ts` |
| Source registry + SourceKey | `packages/sources/index.ts` |
| Manga dedup matching | `packages/db/src/matching.ts` |
| Aggregation migration | `packages/db/migrations/0004_aggregation.sql` |
| Sources endpoint + auto-index | `apps/api-cf/src/routes/reader.ts` |
| Admin merge queue | `apps/api-cf/src/routes/admin/merge.ts` |
| Source badge icons | `apps/web/public/sources/*.png` |
| Source badge component | `apps/web/components/SourceBadge.tsx` |
| Type badge (flag + glow, border hitam) | `apps/web/components/TypeBadge.tsx` + `.type-badge-glow` di `globals.css` |
| Bookmark toggle (toolbox) | `apps/web/components/BookmarkButton.tsx` |
| Detail Info + toolbox island (detail page) | `apps/web/app/[source]/s/[slug]/page.tsx` |
| Chapter list (sort numeric) | `apps/web/components/ChapterList.tsx` |
| Source switcher (dropdown/sticky) | `apps/web/components/SourceSwitcher.tsx` |
| Skeleton loading | `apps/web/components/Skeleton.tsx` + `app/**/loading.tsx` |
| LB token encrypt | `packages/lb/crypto.ts` |
| LB routing logic | `packages/lb/router.ts` |
| LB auto-provision | `packages/lb/provision.ts` |
| Image phash | `packages/vision/phash.ts` |
| Image identify | `packages/vision/identify.ts` |
| Frontend page | `apps/web/app/<path>/page.tsx` |
| Frontend component | `apps/web/components/*.tsx` |
| API client + round-robin | `apps/web/lib/api.ts` |
| Design tokens (OKLCH dark) | `apps/web/app/globals.css` |
| Tailwind config | `apps/web/tailwind.config.ts` |
| Navbar (nav-island + mobile menu fix) | `apps/web/components/Navbar.tsx` + `apps/web/app/layout.tsx` |
| Frontend middleware (NO-OP) | `apps/web/middleware.ts` |
| Worker config (akun-1, fallback + frontend host) | `apps/api-cf/wrangler.toml` |
| Worker config (akun-2, primary, no R2) | `apps/api-cf/wrangler.origin.toml` |
| Worker config (akun-3, primary, no R2) | `apps/api-cf/wrangler.origin3.toml` |
| Worker bundle build | `scripts/build-worker-bundle.mjs` |
| Deploy helper (akun1/akun2/akun3) | `scripts/deploy-worker-api.sh` + `scripts/sync-secrets.sh` |
| Deploy docs | skill ini |

---

## 12. Akun Cloudflare + B2 (referensi internal — JANGAN commit, .opencode/ di-gitignore)

| | Akun 1 (main/fallback) | Akun 2 (primary) | Akun 3 (primary) |
|---|---|---|---|
| Email | Oktzoffc@gmail.com | tzok5555@gmail.com | dwikaoktyffan@gmail.com |
| Account ID | `4ce21aec2dd478bf380b7b59990a9165` | `6a0bdfb8bccff744bd738a57502d0380` | `ddc6f3527032c6e929fddb587f438ca4` |
| Subdomain workers.dev | `oktz` | `tzok5555` | `dwikaoktyffan` |
| Worker | `manga-api` (fallback + frontend host) | `manga-api-2` (**primary**) | `manga-api-3` (**primary**) |
| D1 | `manga-db` (76606365-...) | `manga-db` (61cbf1b1-...) | `manga-db` (160d0a4f-...) |
| KV | `6205fceab7b64f9d80f6f67e4189316b` | `cf560313c1204ec08f174c8924ad3118` | `0412740b508240e99f9b68dd51f3fba3` |
| R2 | `manga-assets` (ASSETS_R2) | ❌ TIDAK ADA | ❌ TIDAK ADA (butuh CC) |
| Browser | MY_BROWSER binding | MY_BROWSER binding | MY_BROWSER binding |
| Origin URL | https://manga-api.oktz.workers.dev | https://manga-api-2.tzok5555.workers.dev | https://manga-api-3.dwikaoktyffan.workers.dev |
| CF API Token | `***REMOVED***` | `***REMOVED***` | `***REMOVED***` |

### B2 (Backblaze) accounts

| | B2 Akun 1 | B2 Akun 2 |
|---|---|---|
| keyID | `005336d7589ff330000000002` | `005b86aeb2be76b0000000004` |
| appKey | `***REMOVED***` | `***REMOVED***` |
| keyName | Komik | Komik |
| bucket | `manga-oktz-assets` | `manga-oktz-assets-2` |
| region | `us-east-005` | `us-east-005` |
| r2_account_idx | -1 (B2-A) | -2 (B2-B) |

**Token scope:** Workers Scripts:Edit + D1 + KV + Pages (akun-1), Workers + D1 + KV (akun-2/3).

**Deploy 3 akun:**
```bash
# Akun-1 (main)
CLOUDFLARE_API_TOKEN="***REMOVED***" npx wrangler deploy --config apps/api-cf/wrangler.toml
# Akun-2 (primary)
CLOUDFLARE_API_TOKEN="***REMOVED***" npx wrangler deploy --config apps/api-cf/wrangler.origin.toml
# Akun-3 (primary)
CLOUDFLARE_API_TOKEN="***REMOVED***" npx wrangler deploy --config apps/api-cf/wrangler.origin3.toml
```

**Migrasi D1 3 akun:** via CF REST API `POST /accounts/{id}/d1/database/{dbId}/query` dengan `{"sql": "<file content>"}`. Apply `0008_sessions.sql` + `0009_chapter_pages_last_access.sql` ke 3 D1.

**Sync secrets 3 akun:** `scripts/sync-secrets.sh` — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, LB_ENCRYPTION_KEY, ALLOWED_ORIGINS, B2_ACCOUNTS, dll via `wrangler secret put`.
