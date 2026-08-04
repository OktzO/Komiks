# 📚 Manga Reader Platform

Platform baca manga/manhwa/manhua bahasa Indonesia dengan sumber dari MangaDex API. Dibangun dengan Next.js (Cloudflare Pages) + Cloudflare Workers + D1 + KV + R2.

![Status](https://img.shields.io/badge/status-MVP-green) ![License](https://img.shields.io/badge/license-MIT-blue) ![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)

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
- ✅ Baca manga Indonesia dari MangaDex (scanlation fan-translation)
- ✅ Image proxy server-side (tidak rehost, ToS MangaDex compliant)
- ✅ Mode scroll & mode halaman (toggle di reader)
- ✅ Lazy load gambar
- ✅ KV cache dengan stale-while-revalidate

### Discovery
- ✅ Home page: 24 manga Indonesia populer (sort by followedCount)
- ✅ Search manga by title
- ✅ Series detail: cover, synopsis, author, genres, chapter list
- ✅ Chapter list filter by language (id)

### User
- ✅ Auth email + password (PBKDF2 hash via Web Crypto)
- ✅ Session di KV (TTL 7 hari, HttpOnly cookie)
- ✅ Bookmark series
- ✅ Reading history (auto-save posisi halaman)

### Admin — Load Balancing
- ✅ Panel `/admin/settings/load-balancing` (step-up auth)
- ✅ Toggle mode on/off
- ✅ Multi-akun provider (Cloudflare + Vercel)
- ✅ Token AES-GCM encrypted at-rest
- ✅ Origin pool (priority, weight, enable/disable)
- ✅ Steering policy (failover / round-robin / weighted)
- ✅ Health check cron (tiap 1 menit)
- ✅ Status dashboard realtime
- ✅ Audit log

### Security
- ✅ Rate limiting per-IP (60 req/min via KV)
- ✅ CORS middleware
- ✅ Admin step-up re-auth untuk LB mutations
- ✅ Token pihak ketiga tidak pernah dikirim ke client
- ✅ Constant-time password compare

---

## 🛠 Tech Stack

| Layer | Teknologi |
|-------|-----------|
| Frontend | Next.js 14 (App Router), React 18, Tailwind CSS |
| Backend | Cloudflare Workers (Hono framework) |
| Database | Cloudflare D1 (SQLite) |
| Cache | Cloudflare KV |
| Storage | Cloudflare R2 |
| Auth | Custom (PBKDF2 + Web Crypto, session KV) |
| Search | MangaDex API + KV cache |
| Load Balancing | Custom router (KV-based) + opsi Native CF LB |
| Encryption | AES-GCM via Web Crypto |
| Deployment | Cloudflare Pages (web) + Workers (API) |
| Package Manager | npm workspaces + Turbo |
| Language | TypeScript (strict mode) |

---

## 📁 Struktur Proyek

```
manga-platform/
├── apps/
│   ├── api-cf/                          # Cloudflare Worker API
│   │   ├── src/
│   │   │   ├── index.ts                 # App entry (Hono app + cron handler)
│   │   │   ├── lib/
│   │   │   │   ├── context.ts           # Env type, getDb, json helper, CORS
│   │   │   │   ├── auth.ts              # PBKDF2 hash, session, cookie
│   │   │   │   └── rateLimit.ts         # Per-IP rate limit middleware (KV)
│   │   │   └── routes/
│   │   │       ├── health.ts            # GET /api/health
│   │   │       ├── search.ts            # GET /api/search
│   │   │       ├── series.ts            # GET /api/series, /api/series/:slug
│   │   │       ├── reader.ts            # GET /api/reader/:source/...
│   │   │       ├── auth.ts              # POST /api/auth/{register,login,logout}, GET /api/auth/me
│   │   │       ├── user.ts              # POST /api/user/bookmark, GET /api/user/{bookmarks,history}
│   │   │       └── admin/
│   │   │           └── lb.ts            # LB settings, accounts, origins, status
│   │   ├── wrangler.toml                # Worker config (D1/KV/R2 bindings, cron)
│   │   ├── .dev.vars                    # Local secrets (gitignored)
│   │   ├── .dev.vars.example            # Template secrets
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/                             # Next.js frontend
│       ├── app/
│       │   ├── layout.tsx               # Root layout (nav bar, dark theme)
│       │   ├── page.tsx                 # Home (popular manga Indonesia)
│       │   ├── globals.css              # Tailwind + dark theme tokens
│       │   ├── search/
│       │   │   └── page.tsx             # Search page
│       │   ├── login/
│       │   │   └── page.tsx             # Login page
│       │   ├── register/
│       │   │   └── page.tsx             # Register page
│       │   ├── bookmark/
│       │   │   └── page.tsx             # Bookmark list
│       │   ├── history/
│       │   │   └── page.tsx             # Reading history
│       │   ├── admin/settings/
│       │   │   └── load-balancing/
│       │   │       └── page.tsx         # LB admin panel
│       │   └── [source]/s/[slug]/
│       │       ├── page.tsx             # Series detail
│       │       └── [chapterId]/
│       │           └── page.tsx         # Reader page
│       ├── components/
│       │   ├── MangaCard.tsx            # Manga card (cover + title + link)
│       │   ├── ChapterList.tsx          # Chapter list (links to reader)
│       │   ├── Reader.tsx               # Reader (scroll + page mode, lazy img)
│       │   └── AuthForm.tsx             # Login/register form (client)
│       ├── lib/
│       │   └── api.ts                   # API client (typed fetch helpers)
│       ├── next.config.mjs
│       ├── tailwind.config.ts
│       ├── postcss.config.mjs
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── db/                              # D1 schema + query helpers
│   │   ├── schema.sql                   # 10 tabel + FTS5 + triggers
│   │   ├── seed.sql                     # Sample data (One Piece, Solo Leveling)
│   │   ├── index.ts                     # db(d1) factory + typed helpers
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── shared/                          # Shared types (zod schemas)
│   │   ├── types.ts                     # Series, Chapter, User, LB types
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── sources/                         # Source adapter registry
│   │   ├── index.ts                     # getAdapter(sourceKey, env?)
│   │   ├── mangadex/
│   │   │   ├── client.ts                # MangaDex API fetch wrappers
│   │   │   └── index.ts                 # Adapter (search, getSeries, chapters, pages)
│   │   ├── test/
│   │   │   └── mapping.test.mjs         # Fixture-based self-check
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── lb/                              # Load balancing logic
│       ├── crypto.ts                    # AES-GCM encrypt/decrypt (Web Crypto)
│       ├── accounts.ts                  # verifyAccountToken, createAccount
│       ├── router.ts                    # getLbSettings, getHealthyOrigin
│       ├── test/
│       │   ├── crypto.test.mjs
│       │   └── accounts.test.mjs
│       ├── package.json
│       └── tsconfig.json
│
├── scripts/
│   └── smoke-db.mjs                     # D1 schema smoke test (node:sqlite)
│
├── docs/
│   ├── DEPLOY.md                        # Panduan deploy production
│   └── superpowers/
│       ├── specs/                       # Design specs
│       └── plans/                       # Implementation plans
│
├── .gitignore
├── package.json                         # Root workspace
├── turbo.json                           # Turbo pipeline
└── README.md
```

---

## 🔌 API Endpoints

### Public
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/health` | Health check (`{status:"ok", ts}`) |
| GET | `/api/search?q=<query>` | Search manga (MangaDex + KV cache 120s) |
| GET | `/api/series?genre=&page=&limit=` | List series (D1) |
| GET | `/api/series/:slug` | Series detail by slug (D1 + KV) |
| GET | `/api/series/:slug/:chapterId` | Chapter detail (D1) |

### Reader (MangaDex)
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/reader/:source/series/:sourceId` | Series detail from source (KV 600s) |
| GET | `/api/reader/:source/series/:sourceId/chapters?lang=id` | Chapter list (KV 300s) |
| GET | `/api/reader/:source/chapter/:chapterId` | Chapter detail + proxy page URLs (KV 300s) |
| GET | `/api/reader/:source/page/:chapterId/:pageNo` | **Image proxy** — stream external image (no rehost) |

### Auth
| Method | Path | Deskripsi |
|--------|------|-----------|
| POST | `/api/auth/register` | Register `{email, password}` → session cookie |
| POST | `/api/auth/login` | Login `{email, password}` → session cookie |
| POST | `/api/auth/logout` | Hapus session |
| GET | `/api/auth/me` | Current user dari session |

### User (auth required)
| Method | Path | Deskripsi |
|--------|------|-----------|
| POST | `/api/user/bookmark` | Bookmark series `{seriesSlug}` |
| DELETE | `/api/user/bookmark/:slug` | Hapus bookmark |
| GET | `/api/user/bookmarks` | List bookmark |
| POST | `/api/user/history` | Save reading position `{chapterId, lastPage}` |
| GET | `/api/user/history` | List reading history |

### Admin — Load Balancing (step-up auth: `x-admin-stepup` header)
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/api/admin/lb/settings` | LB settings (mode, implementation, steering) |
| PUT | `/api/admin/lb/settings` | Update settings |
| GET | `/api/admin/lb/accounts` | List akun (token omitted) |
| POST | `/api/admin/lb/accounts` | Tambah akun (verify + encrypt + insert) |
| DELETE | `/api/admin/lb/accounts/:id` | Hapus akun |
| POST | `/api/admin/lb/accounts/:id/test` | Test koneksi ulang |
| GET | `/api/admin/lb/origins` | List origin pool |
| POST | `/api/admin/lb/origins` | Tambah origin |
| PUT | `/api/admin/lb/origins/:id` | Update origin (priority/weight/enabled) |
| GET | `/api/admin/lb/status` | Status realtime tiap origin |

---

## 🗄 Database Schema (D1)

### Tabel Konten
```sql
series (id, slug, external_id, source, title, synopsis, type, status, author, artist, cover_image, genres, tags, created_at, updated_at)
chapters (id, series_slug, chapter_number, volume, title, language, pages_count, published_at, created_at)
chapter_pages (id, chapter_id, page_number, image_url)
```

### Tabel User
```sql
users (id, email, name, password_hash, role, created_at)
bookmarks (user_id, series_slug, created_at)  -- PK: (user_id, series_slug)
reading_history (user_id, chapter_id, last_page, updated_at)  -- PK: (user_id, chapter_id)
```

### Tabel Load Balancing
```sql
lb_settings (id PK CHECK(id=1), mode, implementation, steering_policy, health_check_interval_sec, health_check_timeout_ms, failure_threshold)
lb_accounts (id TEXT PK, provider, label, account_ref, encrypted_token BLOB, token_last4, status, created_by, created_at)
lb_origins (id TEXT PK, account_id, origin_url, priority, weight, enabled, last_health_status, last_checked_at, created_at)
lb_audit_log (id, account_id, origin_id, action, user_id, created_at)
```

### FTS5 Search
```sql
series_search (title, description)  -- shadow table via triggers, synopsis → description
```

---

## 🔐 Environment Variables

### `apps/api-cf/.dev.vars` (local, gitignored)
```env
LB_ENCRYPTION_KEY=<32-byte random string>
ADMIN_PASSWORD_HASH=<password admin untuk step-up>
MANGADEX_API_KEY=<MangaDex personal API token>
ALLOWED_ORIGINS=http://localhost:3000
GOOGLE_CLIENT_ID=              # opsional
GOOGLE_CLIENT_SECRET=          # opsional
```

### Production (via `wrangler secret put`)
```bash
wrangler secret put LB_ENCRYPTION_KEY
wrangler secret put ADMIN_PASSWORD_HASH
wrangler secret put MANGADEX_API_KEY
```

### Frontend (`apps/web/.env.local`)
```env
NEXT_PUBLIC_API_URL=https://manga-api.<sub>.workers.dev
```

---

## 🚀 Local Development

### Prasyarat
- Node 18+
- npm 10+

### Setup
```bash
# 1. Clone
git clone <repo-url>
cd manga-platform

# 2. Install dependencies
npm install

# 3. Copy secrets template
cp apps/api-cf/.dev.vars.example apps/api-cf/.dev.vars
# Edit .dev.vars: isi MANGADEX_API_KEY

# 4. (Opsional) Setup local D1
npx wrangler d1 execute manga-db --local --file=packages/db/schema.sql
npx wrangler d1 execute manga-db --local --file=packages/db/seed.sql
```

### Run
```bash
# Terminal 1: API (port 8787)
cd apps/api-cf
npx wrangler dev --port 8787 --local

# Terminal 2: Web (port 3000)
cd apps/web
npx next dev --port 3000
```

Buka http://localhost:3000

### Test
```bash
# D1 schema smoke test
node scripts/smoke-db.mjs

# MangaDex adapter self-check
node packages/sources/test/mapping.test.mjs

# LB crypto roundtrip
node packages/lb/test/crypto.test.mjs

# Type check
npx tsc --noEmit -p apps/api-cf
npx tsc --noEmit -p apps/web
npx tsc --noEmit -p packages/db
npx tsc --noEmit -p packages/shared
npx tsc --noEmit -p packages/sources
npx tsc --noEmit -p packages/lb

# Web build
cd apps/web && npx next build
```

---

## 🌐 Deploy ke Production

Lihat [docs/DEPLOY.md](docs/DEPLOY.md) untuk panduan lengkap.

### Quick deploy
```bash
# 1. Buat resources CF
npx wrangler d1 create manga-db
npx wrangler kv namespace create CACHE_KV
npx wrangler r2 bucket create manga-assets

# 2. Update wrangler.toml dengan ID asli

# 3. Simpan secrets
cd apps/api-cf
npx wrangler secret put LB_ENCRYPTION_KEY
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put MANGADEX_API_KEY

# 4. Migrasi D1
npx wrangler d1 execute manga-db --file=../../packages/db/schema.sql --remote

# 5. Deploy API
npx wrangler deploy

# 6. Deploy Web
cd ../web
echo "NEXT_PUBLIC_API_URL=https://manga-api.xxx.workers.dev" > .env.local
npx next build && npx next-on-pages
npx wrangler pages deploy .vercel/output/static --project-name manga-web
```

---

## 🎨 Design Tokens

Dark theme ala Vercel (di `apps/web/app/globals.css`):
```css
--bg-base: #0a0a0a;        /* background utama */
--bg-elevated: #111111;    /* navbar, elevated */
--bg-card: #161616;        /* card, input */
--border-subtle: #232323;  /* border tipis */
--border-default: #333333; /* border default */
--text-primary: #ededed;   /* text utama */
--text-secondary: #a1a1a1; /* text sekunder */
--text-muted: #666666;     /* text muted */
--accent: #ffffff;         /* accent */
--success: #22c55e;        /* success */
--error: #ef4444;          /* error */
--radius: 8px;             /* border radius */
--font-sans: 'Geist Sans', 'Inter', system-ui, sans-serif;
```

Layout: minimalis, border tipis 1px (bukan shadow tebal), skeleton loading untuk grid.

---

## 🔒 Keamanan

- **Rate limiting**: 60 req/min per-IP via KV counter
- **CORS**: origin allowlist dari `ALLOWED_ORIGINS`
- **Admin step-up**: header `x-admin-stepup` === `ADMIN_PASSWORD_HASH` untuk semua mutation LB
- **Token encryption**: AES-GCM (Web Crypto), key dari Worker secret `LB_ENCRYPTION_KEY`
- **Token tidak pernah ke client**: `listAccounts` omit `encrypted_token`, UI hanya lihat `token_last4`
- **Password hash**: PBKDF2 (100k iter, SHA-256, 16-byte salt), constant-time compare
- **Session**: KV `session:{token}`, TTL 7 hari, HttpOnly + SameSite=Lax cookie
- **Image proxy**: URL dari adapter saja (no SSRF), User-Agent header, cache 300s
- **WAF + Bot Fight Mode**: aktifkan di Cloudflare dashboard (production)

---

## ⚖️ Legal

Konten dari MangaDex = **scanlation fan-translation**, mayoritas tanpa lisensi resmi. Platform ini:
- ✅ **Reader saja** — tidak menyimpan/hosting gambar sendiri
- ✅ **Proxy stream** — Worker fetch URL sementara MangaDex@Home, stream ke browser
- ✅ **Tidak rehost** — R2 tidak menyimpan gambar MangaDex (ToS compliant)
- ✅ **Attribution** — metadata dari MangaDex API

Pengguna platform bertanggung jawab atas kepatuhan hukum di yurisdiksi masing-masing.

---

## 📝 Lisensi

MIT
