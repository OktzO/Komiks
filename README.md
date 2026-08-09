# 📚 Manga Reader Platform

Platform baca manga/manhwa/manhua bahasa Indonesia yang menggabungkan 4 source independen: Komiku, BacaKomik, Thrive, dan ManhwaIndo. Dibangun di Cloudflare: 1 Worker API (Hono) + Next.js (Pages) + D1 + KV + R2 + Browser binding.

![Status](https://img.shields.io/badge/status-live-green) ![License](https://img.shields.io/badge/license-MIT-blue) ![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)

## 📋 Daftar Isi

- [Fitur](#-fitur)
- [Tech Stack](#-tech-stack)
- [Struktur Proyek](#-struktur-proyek)
- [API Endpoints](#-api-endpoints)
- [Database Schema (D1)](#-database-schema-d1)
- [Environment Variables](#-environment-variables)
- [Local Development](#-local-development)
- [Deploy ke Production](#-deploy-ke-production)
- [Design Tokens](#-design-tokens)
- [Keamanan](#-keamanan)
- [Legal](#-legal)

---

## ✨ Fitur

### Reader
- ✅ Baca manga dari 4 source (Komiku, BacaKomik, Thrive, ManhwaIndo)
- ✅ Mode scroll (panels menyatu tanpa gap) & mode halaman
- ✅ Lazy load + virtualized window (hanya render viewport + buffer)
- ✅ R2-first untuk Komiku: cache-aside, hash ring multi-account, proxy fallback self-healing
- ✅ Source lain 100% proxy (tidak pernah di-rehost)
- ✅ Next-chapter prefetch

### Discovery
- ✅ Home page live feed: ticker update terbaru, source rail (status per sumber), Populer Hari Ini, filter genre, Update Terbaru, Semua Komik
- ✅ Search multi-source, merge by normalized title (levenshtein + Jaro-Winkler)
- ✅ Series detail: cover, synopsis, author, genres, chapter list, source switcher (dropdown + sticky di reader)
- ✅ Badge multi-source (ikon 4 source, overflow +N)
- ✅ Aggregation: 1 manga canonical (series) dari banyak source link, auto-index dari aktivitas user
- ✅ Passive health: `source_health` dicatat saat user search/reader (tanpa cron)

### User
- ✅ Auth email + password (PBKDF2 hash via Web Crypto)
- ✅ Google OAuth (verify via Google tokeninfo, avatar dari `gUser.picture`)
- ✅ Session di KV (TTL 7 hari, HttpOnly cookie)
- ✅ Bookmark series
- ✅ Reading history (auto-save posisi halaman)
- ✅ Profile page (`/profile`): Profile, Account, Preferences, Privacy, Sessions, Admin sections
- ✅ Multi-device session list + per-session revoke + revoke-all
- ✅ Clear history / clear bookmarks
- ✅ Hapus akun permanen (`DELETE /api/user/me` dengan body `{confirm:'DELETE'}`)

### Identifikasi Gambar
- ✅ `/api/identify`: upload gambar → phash 64-bit → match series dari D1

### Admin
- ✅ Panel `/admin/load-balancing` (step-up auth, direname dari `/admin/settings/load-balancing`)
- ✅ Auto-provision akun baru: CF API token → create D1 + KV + R2 (opsional) + deploy Worker dari KV bundle
- ✅ Origin pool (priority, weight, enable/disable), steering failover / round-robin / weighted
- ✅ Quota per origin per hari (D1 `lb_usage`)
- ✅ Merge queue `manga_merge_queue` + resolve (merge/reject) + manual merge 2 series
- ✅ Scrape jobs via adapter (`/api/scrape`)
- ✅ Audit log
- ✅ Auto-role admin via secret `ADMIN_EMAILS` (comma-separated) saat register/login

### Security
- ✅ Rate limiting berjenjang: public 60/min, identify 10/min, admin 600/min
- ✅ CORS origin allowlist
- ✅ Admin step-up (LB) + admin key (scrape), constant-time compare
- ✅ Token pihak ketiga AES-GCM encrypted at-rest, tidak pernah ke client

---

## 🛠 Tech Stack

| Layer | Teknologi |
|-------|-----------|
| Frontend | Next.js 14 (App Router, runtime edge), React 18, Tailwind CSS |
| Backend | Cloudflare Workers (Hono), bundle ESM ~107 KB |
| Database | Cloudflare D1 (SQLite, FTS5) |
| Cache | Cloudflare KV |
| Storage | Cloudflare R2 (multi-account, hash ring MurmurHash3) |
| Rendering | Browser binding (Puppeteer remote) untuk BacaKomik & ManhwaIndo (CF Bot Fight) |
| Auth | Custom (PBKDF2 + Web Crypto, session KV) |
| Search | 4 source aggregation + dedup matching |
| Load Balancing | Custom router + auto-provision (Cloudflare API) |
| Encryption | AES-GCM via Web Crypto (LB token) |
| Deployment | Cloudflare Pages (web) + Workers (API) |
| Package Manager | npm workspaces + Turbo |
| Language | TypeScript (strict mode) |

---

## 📁 Struktur Proyek

```
manga-platform/
├── apps/
│   ├── api-cf/                          # 1 Worker tunggal (manga-api)
│   │   ├── wrangler.toml                # D1/KV/R2 + browser binding (akun-1, no cron)
│   │   ├── wrangler.origin.toml         # Config akun-2 origin (D1+KV+browser, NO R2)
│   │   ├── src/
│   │   │   ├── index.ts                 # Hono app, CORS, security headers, rate limit, mount routes
│   │   │   ├── lib/
│   │   │   │   ├── context.ts           # Env type, getDb, json, allowed origins
│   │   │   │   ├── auth.ts              # PBKDF2, session, admin key, step-up, Google OAuth verify
│   │   │   │   ├── rateLimit.ts         # makeLimiter factory (60/10/600 per min)
│   │   │   │   ├── retry.ts             # retryUpstream (429 backoff)
│   │   │   │   ├── r2Accounts.ts        # parse R2_ACCOUNTS secret (urutan = index)
│   │   │   │   ├── s3Upload.ts          # SigV4 signed PUT ke R2 akun lain
│   │   │   │   ├── dbWrite.ts           # D1 overflow detector (KV usage tracking, threshold 400MB)
│   │   │   │   └── komikuSlug.ts        # parse slug dari '<slug>-chapter-<num>'
│   │   │   └── routes/
│   │   │       ├── health.ts            # GET /api/health
│   │   │       ├── search.ts            # GET /api/search (multi-source + cache KV)
│   │   │       ├── series.ts            # GET /api/series, /:slug
│   │   │       ├── manga.ts             # GET /api/manga/:id (D1 + KV)
│   │   │       ├── reader.ts            # chapter/page + cache-aside R2 (komiku)
│   │   │       ├── origins.ts           # GET /api/origins (lazy health, cache 30s)
│   │   │       ├── sourceStatus.ts      # GET /api/source-status (D1 passive)
│   │   │       ├── identify.ts          # POST /api/identify (phash → series)
│   │   │       ├── auth.ts              # register/login/logout/me + Google OAuth
│   │   │       ├── user.ts              # /api/user/* (profile, sessions, bookmarks, history)
│   │   │       └── admin/
│   │   │           ├── lb.ts            # settings/accounts/provision/origins/status/usage
│   │   │           ├── scrape.ts        # scrape jobs
│   │   │           └── merge.ts         # merge queue + manual merge
│   │   └── dist/worker.js               # ESM bundle (auto-provision seed)
│   │
│   └── web/                             # Next.js frontend (Cloudflare Pages)
│       ├── app/
│       │   ├── layout.tsx               # Root layout (nav-island, dark theme)
│       │   ├── page.tsx                 # Home: hero, ticker, source rail, populer, genre, updates, grid
│       │   ├── globals.css              # OKLCH tokens, nav-island, marquee, skeleton
│       │   ├── search/                  # Search (merge 4 source)
│       │   ├── login/ register/ bookmark/ history/
│       │   ├── profile/                 # Profile (sections: Profile, Account, Preferences, Privacy, Sessions, Admin)
│       │   ├── status/                  # Source health passive — BetterStack-style cards v2
│       │   ├── admin/load-balancing/    # LB + auto-provision (rename dari /admin/settings/load-balancing)
│       │   └── [source]/s/[slug]/
│       │       ├── page.tsx             # Series detail + SourceSwitcher
│       │       └── [chapterId]/page.tsx # Reader (scroll + page mode)
│       ├── components/
│       │   ├── MangaCard.tsx / CoverImage.tsx / Avatar.tsx / ConfirmModal.tsx
│       │   ├── ChapterList.tsx / Synopsis.tsx / SourceBadge.tsx / SourceSwitcher.tsx
│       │   ├── Reader.tsx / ReaderShell.tsx  # virtualized, R2-first, retry proxy
│       │   ├── Skeleton.tsx / AuthForm.tsx
│       │   ├── Navbar.tsx               # scroll island + hamburger menu (Profile/Load Balancing)
│       │   └── profile/                 # Profile sub-sections (Sidebar, MobileTabs, sections)
│       ├── lib/api.ts                   # API client + round-robin failover + R2 URL + profile helpers
│       └── next.config.mjs / tailwind.config.ts
│
├── packages/
│   ├── db/                              # D1 schema + query helpers
│   │   ├── schema.sql                   # base: 10 tabel + FTS5 + triggers
│   │   ├── migrations/                  # 0001 data, 0002 r2, 0003 drop mangadex, 0004 aggregation, 0005 user_profile
│   │   ├── src/matching.ts              # normalize + levenshtein + jaroWinkler (pure)
│   │   ├── test/matching.test.mjs
│   │   └── index.ts                     # db(d1) factory + 40+ typed helpers (termasuk updateUserProfile, listUserSessions, dll)
│   ├── shared/
│   │   ├── types.ts                     # Zod schemas
│   │   └── src/r2-routing.ts            # hash ring (Worker + frontend, satu sumber)
│   ├── sources/                         # Source adapter registry
│   │   ├── index.ts                     # getAdapter(sourceKey, env?)
│   │   ├── komiku/                      # fetch+regex, NO Puppeteer
│   │   ├── bacakomik/                   # WordPress, hybrid MY_BROWSER fallback
│   │   ├── thrive/                      # Next.js SSG, __NEXT_DATA__
│   │   ├── manhwaindo/                  # WordPress, hybrid MY_BROWSER fallback
│   │   └── test/                        # fixture-based (thrive, bacakomik, manhwaindo)
│   ├── lb/                              # Load balancing
│   │   ├── crypto.ts / accounts.ts / router.ts / provision.ts
│   │   └── test/                        # crypto, accounts, provision
│   └── vision/                          # phash + hamming + identify
│
├── scripts/
│   ├── build-worker-bundle.mjs          # esbuild → dist/worker.js
│   ├── deploy-worker-api.sh             # helper deploy akun1|akun2 (token Workers Scripts:Edit)
│   ├── setup-r2-account.mjs             # panduan akun R2 baru + remap report
│   ├── smoke-db.mjs / smoke-data-db.mjs / smoke-r2-db.mjs / smoke-user.mjs
│
├── docs/
│   ├── DEPLOY.md                        # Panduan deploy production
│   └── ADDING-ACCOUNT.md                # tambah akun R2 + origin (CORS checklist)
│
├── package.json / turbo.json / README.md
```

---

## 🔌 API Endpoints

### Public
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/health` | Health check (`{status:"ok", ts}`) |
| GET | `/api/search?q=<q>` | Search 4 source + merge; `q` kosong = homepage feed; cache KV 120s |
| GET | `/api/series?genre=&page=&limit=` | List series (D1) |
| GET | `/api/series/:slug` | Series detail by slug (D1 + KV) |
| GET | `/api/manga/:id` | Manga meta by slug (D1 + KV 3600s) |
| GET | `/api/source-status` | Passive health 4 source dari D1 (no live ping) |
| GET | `/api/origins` | Daftar origin sehat (lazy health check, cache 30s) |

### Reader
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/reader/:source/series/:sourceId` | Series dari source (KV 600s) |
| GET | `/api/reader/:source/series/:sourceId/chapters?lang=id` | Chapter list (KV 300s) |
| GET | `/api/reader/:source/series/:sourceId/sources` | Aggregated sources: D1 link → live-resolve + auto-index persist (KV 600s) |
| GET | `/api/reader/:source/chapter/:chapterId` | Chapter + proxy page URLs (KV 300s) |
| GET | `/api/reader/:source/page/:chapterId/:pageNo` | Image proxy; Komiku: Referer + upload R2 background; source lain: stream |

### Auth
| Method | Path | Deskripsi |
|--------|------|-----------|
| POST | `/api/auth/register` | `{email,password}` → session cookie (admin role jika email di `ADMIN_EMAILS`) |
| POST | `/api/auth/login` | `{email,password}` → session cookie |
| POST | `/api/auth/logout` | Hapus session |
| GET | `/api/auth/me` | Current user (redirect jika guest) |
| GET | `/api/auth/google` | Redirect ke Google OAuth consent |
| GET | `/api/auth/google/callback` | OAuth callback → simpan `avatar_url` dari `gUser.picture` |

### User (auth required, kecuali GET `/user/me` = guest-friendly)
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/user/me` | Current user; `{data:null}` jika guest |
| PATCH | `/api/user/me` | Update `{display_name?, bio?, preferences?, avatar_url?}` |
| DELETE | `/api/user/me` | Hapus akun permanen. Body `{confirm:'DELETE'}` |
| POST/DELETE | `/api/user/bookmark` `/api/user/bookmark/:slug` | Bookmark series |
| GET | `/api/user/bookmarks` | List bookmark |
| DELETE | `/api/user/bookmarks` | Clear all |
| POST/GET | `/api/user/history` | Save / list reading history |
| DELETE | `/api/user/history` | Clear all |
| GET | `/api/user/sessions` | List active sessions (current + others) |
| DELETE | `/api/user/sessions/:token` | Revoke specific session |
| POST | `/api/user/sessions/revoke-all` | Revoke semua kecuali current → `{revoked:N}` |

### Identify (rate limit 10/min)
| Method | Path | Deskripsi |
|--------|------|-----------|
| POST | `/api/identify` | Upload gambar → phash → match series. Max 10 MB |

### Scrape (admin key `x-admin-api-key`, rate 600/min)
| Method | Path | Deskripsi |
|--------|------|-----------|
| POST/GET | `/api/scrape` | Buat job / list job (adapter source) |
| GET | `/api/scrape/:job_id` | Status job |

### Admin LB (step-up `x-admin-stepup`)
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET/PUT | `/api/admin/lb/settings` | Mode, implementation, steering |
| GET/POST | `/api/admin/lb/accounts` | List / tambah akun |
| POST | `/api/admin/lb/accounts/provision` | Auto-provision D1+KV+Worker baru |
| GET | `/api/admin/lb/accounts/:id/provision-status` | Poll status job |
| DELETE | `/api/admin/lb/accounts/:id` | Hapus akun |
| POST | `/api/admin/lb/accounts/:id/test` | Test koneksi |
| GET/POST/PUT | `/api/admin/lb/origins` | Origin pool CRUD |
| GET | `/api/admin/lb/status` | Status realtime per origin |
| GET | `/api/admin/lb/usage` | Aggregate LB usage dari D1 `lb_usage` |

### Admin Merge (key + step-up)
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/admin/merge/queue?status=pending` | List queue |
| POST | `/api/admin/merge/queue/:id` | `{action:'merge'\|'reject', targetMangaId?}` |
| POST | `/api/admin/merge/series` | Manual merge 2 series |

---

## 🗄 Database Schema (D1)

Base di `packages/db/schema.sql` (10 tabel) + 5 migrasi incremental (jangan edit schema untuk kolom baru, buat migration baru).

```sql
-- Konten
series (id, slug UNIQUE, external_id, source, title, synopsis, type manga|manhwa|manhua,
        status ongoing|completed|hiatus|cancelled, author, artist, cover_image, genres, tags, created_at, updated_at)
chapters (id TEXT PK '<external_id>@<lang>', series_slug FK, chapter_number, volume, title, language, pages_count, published_at)
chapter_pages (id, chapter_id, page_number, image_url, r2_key, r2_account_idx)  -- r2 via 0002

-- User
users (id, email UNIQUE, password_hash, role, created_at,
       display_name, avatar_url, bio, preferences JSON)   -- 0005 user_profile
bookmarks (user_id, series_slug)              -- PK: (user_id, series_slug)
reading_history (user_id, chapter_id, last_page, updated_at)

-- Load balancing
lb_settings / lb_accounts (encrypted_token BLOB) / lb_origins / lb_audit_log

-- Aggregation (0004)
manga_source_link (manga_id FK, source, source_slug, has_chapter_list, chapter_count, last_scraped_at, UNIQUE(source,source_slug))
manga_merge_queue (source, source_slug, title, candidate_ids JSON, confidence, status pending|merged|rejected)

-- Lainnya
series_search (FTS5, shadow via triggers)
image_hashes / scrape_jobs / source_health      (0001)
r2_last_access / lb_usage (origin_url, date_key) (0002)
series.alt_titles, series.source_url            (0001)
```

---

## 🔐 Environment Variables

### `apps/api-cf/.dev.vars` (local, gitignored)
```env
LB_ENCRYPTION_KEY=<32-byte random>
ADMIN_PASSWORD_HASH=<password step-up admin>
ALLOWED_ORIGINS=http://localhost:3000
```

### Production (via `wrangler secret put`)
```bash
LB_ENCRYPTION_KEY     # AES-GCM key token LB
ADMIN_PASSWORD_HASH   # step-up admin LB
ADMIN_EMAILS          # comma-separated; auto-role admin saat register/login
SCRAPE_API_KEY        # admin key /api/scrape
ALLOWED_ORIGINS       # comma-separated, contoh: https://oktzz.xyz,http://localhost:3000
R2_ACCOUNTS           # JSON: [{"account_id","access_key_id","secret_access_key","public_domain","bucket?"}]
                      # urutan = index akun (identitas hash ring), 1 secret untuk semua akun
GOOGLE_CLIENT_ID      # OAuth (optional)
GOOGLE_CLIENT_SECRET  # OAuth (optional)
```

Env tambahan (wrangler.toml / default): `R2_RING_VNODES` (default 32), `R2_EVICTION_DAYS` (default 30), binding `DB`, `CACHE_KV`, `ASSETS_R2`, `MY_BROWSER` (browser binding remote).

### Frontend (`apps/web/.env.production`)
```env
NEXT_PUBLIC_API_URL=https://manga-api.oktz.workers.dev
NEXT_PUBLIC_DATA_API_URL=https://manga-api.oktz.workers.dev
NEXT_PUBLIC_R2_DOMAINS=https://cdn1.oktz.qzz.io   # urutan = index akun, sama dengan R2_ACCOUNTS
NEXT_PUBLIC_R2_VNODES=32
```

---

## 🚀 Local Development

### Prasyarat
- Node 18+, npm 10+

### Setup
```bash
git clone <repo-url> && cd manga-platform
npm install
cp apps/api-cf/.dev.vars.example apps/api-cf/.dev.vars

# Setup D1 lokal
npx wrangler d1 execute manga-db --local --file=packages/db/schema.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0001_manga_data.sql
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0002_r2_storage.sql
```

### Run
```bash
# Terminal 1: API (port 8787)
cd apps/api-cf && npx wrangler dev --port 8787 --local

# Terminal 2: Web (port 3000)
cd apps/web && npx next dev --port 3000
```

Buka http://localhost:3000

### Test
```bash
node scripts/smoke-db.mjs                       # D1 schema smoke
node packages/db/test/matching.test.mjs         # dedup matching
node packages/sources/test/thrive.test.mjs      # fixture, no network
node packages/sources/test/bacakomik.test.mjs
node packages/sources/test/manhwaindo.test.mjs
node packages/lb/test/crypto.test.mjs           # AES-GCM roundtrip
node packages/lb/test/provision.test.mjs

# Type check
npx tsc --noEmit -p apps/api-cf -p apps/web -p packages/db -p packages/shared -p packages/sources -p packages/lb -p packages/vision

# Web build
cd apps/web && npx next build && npx next-on-pages
```

---

## 🌐 Deploy ke Production

### Worker (manga-api)
```bash
export CLOUDFLARE_API_TOKEN="<token>"
npx wrangler deploy --config apps/api-cf/wrangler.toml

# Secrets
echo -n "<value>" | npx wrangler secret put ALLOWED_ORIGINS --config apps/api-cf/wrangler.toml
echo -n "<value>" | npx wrangler secret put SCRAPE_API_KEY --config apps/api-cf/wrangler.toml
echo -n "<value>" | npx wrangler secret put ADMIN_PASSWORD_HASH --config apps/api-cf/wrangler.toml
echo -n "<value>" | npx wrangler secret put LB_ENCRYPTION_KEY --config apps/api-cf/wrangler.toml
echo -n '<R2_ACCOUNTS-JSON>' | npx wrangler secret put R2_ACCOUNTS --config apps/api-cf/wrangler.toml
```

### Frontend (Pages)
```bash
cd apps/web
rm -rf .next .vercel
NEXT_PUBLIC_API_URL=https://manga-api.oktz.workers.dev \
NEXT_PUBLIC_DATA_API_URL=https://manga-api.oktz.workers.dev \
npx next build && npx next-on-pages
npx wrangler pages deploy .vercel/output/static --project-name manga-web --branch main
```

### Migrasi D1 remote
```bash
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0002_r2_storage.sql
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0003_drop_mangadex.sql
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0004_aggregation.sql
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0005_user_profile.sql
```

### Akun-2 (origin LB) deploy
```bash
# Token akun-2 harus punya Workers Scripts:Edit
CLOUDFLARE_API_TOKEN=<token-akun2> CLOUDFLARE_ACCOUNT_ID=6a0bdfb8bccff744bd738a57502d0380 \
  ./scripts/deploy-worker-api.sh akun2

# Migrasi D1 akun-2 (D1 ID beda)
CLOUDFLARE_API_TOKEN=<token-akun2> CLOUDFLARE_ACCOUNT_ID=6a0bdfb8bccff744bd738a57502d0380 \
  npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0005_user_profile.sql
```

### Seed bundle auto-provision (KV)
```bash
node scripts/build-worker-bundle.mjs
base64 -w0 apps/api-cf/dist/worker.js > /tmp/bundle.b64
npx wrangler kv key put --namespace-id=<KV_ID> "worker-bundle:latest" --path=/tmp/bundle.b64
npx wrangler kv key put --namespace-id=<KV_ID> "provision:schema:latest" --path=packages/db/schema.sql
npx wrangler kv key put --namespace-id=<KV_ID> "provision:migration:latest" --path=packages/db/migrations/0001_manga_data.sql
```

### Akun R2 / origin baru
```bash
node scripts/setup-r2-account.mjs    # panduan manual + remap report
# Lifecycle eviction (prefix komiku/, Days = R2_EVICTION_DAYS):
npx wrangler r2 bucket lifecycle set manga-images --file - <<'EOF'
{ "Rules": [ { "ID": "evict-komiku", "Status": "Enabled", "Filter": { "Prefix": "komiku/" }, "Expiration": { "Days": 30 } } ] }
EOF
```

Lihat [docs/DEPLOY.md](docs/DEPLOY.md) dan [docs/ADDING-ACCOUNT.md](docs/ADDING-ACCOUNT.md) untuk detail.

### Verifikasi post-deploy
- `GET /api/health` → `{status:"ok"}`
- `GET /api/search?q=` → feed 4 source (~60 item, badge multi-source)
- `GET /api/search?q=naruto` → hasil merged
- `GET /api/origins` → daftar origin
- `/status` → passive health 4 source (BetterStack-style: pulse dot + relative time + latency grade)

---

## 🎨 Design Tokens

Dark theme OKLCH (di `apps/web/app/globals.css`), referensi oktz.qzz.io:
```css
--bg-base: oklch(8% 0 0);          /* background utama */
--bg-elevated: oklch(12% 0 0);     /* navbar, elevated */
--bg-card: oklch(12% 0 0);         /* card, input */
--bg-secondary: oklch(18% 0 0);    /* hover */
--border-subtle: oklch(100% 0 0 / 0.08);
--border-default: oklch(100% 0 0 / 0.14);
--text-primary: oklch(98% 0 0);
--text-secondary: oklch(70% 0 0);
--text-muted: oklch(50% 0 0);
--accent: oklch(98% 0 0);          /* putih, monochrome */
--success / --error: oklch(65% 0.18 145 / 27)
--radius: 12px;
--glass-surface: oklch(14% 0 0 / 0.62);
```

- **Nav-island**: fixed top, max-width berubah saat scroll (rest → 1120px), `rounded-2xl`/pill, `backdrop-filter: blur(18px) saturate(180%)`
- Home: hero glow + rise-in, ticker marquee (CSS-only, pause on hover, `prefers-reduced-motion` dihormati), chip status source, footer
- Reader: panel menyatu (tanpa gap antar halaman), skeleton slot, R2-first

---

## 🔒 Keamanan

- **Rate limiting**: public 60/min, identify 10/min, admin 600/min per-IP via KV
- **CORS**: origin allowlist dari `ALLOWED_ORIGINS`
- **Admin step-up**: `x-admin-stepup` untuk mutation LB; **admin key**: `x-admin-api-key` untuk scrape. Keduanya constant-time compare
- **Token encryption**: AES-GCM (Web Crypto), layout `[12-byte iv | ciphertext+tag]`
- **Password hash**: PBKDF2 (100k iter, SHA-256), format `pbkdf2:<iter>:<hex-salt>:<hex-hash>`
- **Session**: KV `session:{token}`, TTL 7 hari, HttpOnly + SameSite=Lax
- **Image proxy**: allowlist host per source + blokir private IP (SSRF guard); Referer header per source; Komiku butuh `Referer: https://komiku.org/`
- **R2 upload**: SigV4 signed PUT, kredensial hanya di secret `R2_ACCOUNTS`; key deterministik `komiku/{slug}/{chapterId}/{pageNo}`, hash = slug manga
- **Round-robin client-side** dengan circuit breaker: skip origin 60s setelah 2 gagal beruntun, retry max 2, fallback main API; endpoint admin tidak pernah dipanggil dari klien

---

## ⚖️ Legal

Konten bersumber dari 4 situs publik: Komiku, BacaKomik, Thrive, ManhwaIndo. Platform ini:
- ✅ **Reader saja** untuk BacaKomik/Thrive/ManhwaIndo (proxy stream, tidak disimpan)
- ✅ **Rehost** hanya untuk Komiku: R2 cache-aside dengan lifecycle eviction (30 hari)

Pengguna platform bertanggung jawab atas kepatuhan hukum di yurisdiksi masing-masing.

---

## 📝 Lisensi

MIT
