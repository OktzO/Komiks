# Komiks — Platform Baca Komik Indonesia

> Platform baca manga/manhwa/manhua multi-source, di-backbone oleh 4 Cloudflare Workers (round-robin load balancing), D1 sharded, dan storage Backblaze B2 multi-account. Frontend Next.js 16 yang di-deploy sebagai Cloudflare Worker via OpenNext.

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Hono](https://img.shields.io/badge/Hono-3-E36002)
![Backblaze B2](https://img.shields.io/badge/Storage-Backblaze_B2-E21E29?logo=backblaze&logoColor=white)

**Live:** [oktzz.xyz](https://oktzz.xyz)

---

## Daftar Isi

- [Dokumentasi](#dokumentasi)
- [Fitur](#fitur)
- [URL Kanonik](#url-kanonik)
- [Arsitektur](#arsitektur)
- [API Endpoints](#api-endpoints)
- [Quick Start](#quick-start)
- [Testing](#testing)
- [Deploy](#deploy)
- [Struktur Repo](#struktur-repo)
- [Perubahan Terbaru](#perubahan-terbaru)
- [Gotchas](#gotchas)

## Dokumentasi

Semua dokumen project — dikurasi supaya gampang dicari.

| Dokumen | Jenis | Isi |
|---|---|---|
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Ops | Panduan deploy lengkap: D1/KV, secrets, migrations, deploy Worker API + web, domain/WAF, catatan operasional |
| [`docs/ADDING-ACCOUNT.md`](docs/ADDING-ACCOUNT.md) | Ops | Menambah akun B2 + akun Worker API baru (bucket, app key, provisioning) |
| [`docs/TOS-REVIEW.md`](docs/TOS-REVIEW.md) | Ops | Checklist review ToS/AUP Cloudflare sebelum production live |
| [`docs/2026-08-19-frontend-audit.md`](docs/2026-08-19-frontend-audit.md) | Internal | Audit frontend: dead-code, bundle/perf, memory-leak |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Internal | 20 design docs — satu per fitur besar, format `YYYY-MM-DD-<fitur>-design.md` |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Internal | 14 implementation plans (checkbox task-by-task) |
| [`.opencode/skills/manga/SKILL.md`](.opencode/skills/manga/SKILL.md) | AI | Skill reference untuk AI assistant — arsitektur, modul, deploy, gotchas |

> Spec terbaru: [`2026-09-08-canonical-typed-streaming-design.md`](docs/superpowers/specs/2026-09-08-canonical-typed-streaming-design.md) — URL kanonik typed + streaming detail page.

## Fitur

### Pembaca

| Fitur | Detail |
|---|---|
| Multi-source | 5 source independen: **Komiku** (primary), BacaKomik.my, Thrive.moe, Shinigami, ManhwaIndo.my — failover otomatis |
| URL kanonik typed | `/manga/{slug}`, `/manhwa/{slug}`, `/manhua/{slug}` — shell dirender dulu, daftar chapter + pemilih source di-streaming via Suspense |
| Auto default source | Sistem pilih source dengan chapter terbanyak (tie-break: scrape terbaru → weight prioritas); user override tersimpan |
| Pemilih source | Lihat + pindah source lain dari halaman detail, dengan counter chapter per source |
| Reader | Mode scroll + paged, lazy-load gambar, prefetch chapter berikutnya, windowed chapter list |
| Search | FTS5 + LIKE fallback di D1, digabung live search ke 5 source |
| Homepage | Hero spotlight, bento grid, trending, marquee update, genre pills, lanjut baca — feed 5 source dengan cache 12 jam |
| Bookmark & history | Multi-source, guest-friendly (tampil walau belum login), sinkron antar perangkat saat login |
| Login | Google OAuth + Cloudflare Turnstile captcha |
| Status source | Halaman `/status` — passive health + latency per source |
| Identify | Cari judul dari upload cover (perceptual hash, hamming ≤ 8) |

### Infrastruktur

| Fitur | Detail |
|---|---|
| Round-robin LB | 4 API worker di 4 akun Cloudflare, failover + circuit breaker di client |
| D1 sharded | `chapter_pages` shard by chapterId, `sessions` shard by user_id — owner routing via murmur3, row-healing fallback |
| Storage B2 multi-account | Hash-pick akun by key, quota-aware eviction (evict > 30 hari saat usage > 80%), 100% B2 (R2 dihapus) |
| Image proxy B2-first | `/img/*` — serve dari B2 server-side (SigV4), edge-cache immutable 1 tahun, SSRF allowlist, hotlink guard |
| Admin dashboard | Storage trend, source health, request stats, security events, moderasi user, LB settings, merge queue |
| Read-through cache | Two-tier KV (fresh 10 min + stale 24 jam) + stampede protection + peer KV fallback |
| Cron otomatis | Outbox flush, eviction, usage snapshot, homepage feed refresh + push ke peer |

## URL Kanonik

Satu-satunya format URL halaman. URL lama `/{source}/s/{slug}` sudah **dihapus total** (404).

```
/manga/{slug}              → halaman detail (URL kanonik)
/manhwa/{slug}
/manhua/{slug}
/{type}/{slug}/{chapterId} → halaman baca
```

- API `GET /api/resolve/:slug` memetakan slug kanonik → source + `recommendedSource` + daftar source lain.
- Salah type di URL → `permanentRedirect` otomatis ke type yang benar.
- Semua link internal (homepage, search, bookmark, history, reader) dibangun via helper `typedUrl` / `typedChapterUrl` + `safeType` di `apps/web/lib/api.ts`.

## Arsitektur

```
4 Cloudflare Worker (round-robin LB)        Cloudflare Worker (OpenNext)
┌───────────────────────────────────────┐    ┌───────────────────────────────────────┐
│  akun-1  manga-api     (fallback)     │    │  apps/web  manga-web                  │
│  akun-2  manga-api-2   (primary)      │◄──►│  pages/, components/, lib/            │
│  akun-3  manga-api-3   (primary)      │    │  lib/api.ts (getAuthApiUrl, RR)       │
│  akun-4  manga-api-4   (primary)      │    └───────────────────────────────────────┘
└───────────────────────────────────────┘
                │ D1 (4 DB, sharded: chapter_pages by owner chapterId)
                ├─ CACHE_KV (cache layer)
                └─ Backblaze B2 (multi-account, hash-pick)

packages/
  db/        D1 client + schema + 18 migrations + 1 backfill
  shared/    Zod types + murmur3/B2 key routing + HTTP utils
  sources/   5 source adapters (komiku/bacakomik/thrive/shinigami/manhwaindo)
  lb/        LB account crypto + provision + router
  vision/    pHash + hamming image identify
```

- **Akun-1 sengaja minim secret** — ia juga nopang web, jadi dijaga hemat. Request auth/B2 yang kena akun-1 akan failover ke worker lain (by design, lihat `docs/DEPLOY.md` §8).
- **Cron** jalan di akun-1 (hourly): outbox flush → eviction → usage snapshot → homepage refresh + peer push.
- **Rate limiting** 6 tier in-memory (global 60/min, identify 10/min, admin 600/min, bookmark mutation 60/hr, img 300/min, internal 300/min).

## API Endpoints

Ringkasan — semua JSON, base URL salah satu worker (client pilih via round-robin, `GET /api/origins`).

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| GET | `/api/health` | — | Health check |
| GET | `/api/series` · `/api/series/:slug` · `/api/series/:slug/:chapterId` | — | Katalog D1 |
| GET | `/api/search?q=` | — | FTS5 + LIKE + live merge 5 source |
| GET | `/api/homepage` | — | Feed merged 5 source (KV 12 jam) |
| GET | `/api/resolve/:slug` | — | Slug kanonik → source + recommended |
| GET | `/api/reader/:source/series/:sourceId/detail` | — | Series + chapters konsolidasi (cache two-tier) |
| GET | `/api/reader/:source/series/:sourceId/sources` | — | Agregasi source + recommendedSource |
| GET | `/api/reader/:source/chapter/:chapterId` | — | Chapter + page URLs |
| GET | `/img/:source/:chapterId/:pageNo` | — | Image proxy B2-first (edge-cached) |
| GET | `/api/origins` · `/api/source-status` · `/api/manga/:id` | — | LB origins, health source, meta |
| GET | `/api/auth/google` → callback · `/api/auth/me` · POST `/logout` | — | Google OAuth + Turnstile gate |
| POST | `/api/identify` | — | pHash cover match (10/min) |
| POST/GET/DELETE | `/api/bookmark` · `/api/bookmarks` | session | Bookmark CRUD (mutation 60/hr) |
| POST/GET/DELETE | `/api/history` · `/api/me` · `/api/sessions` | session | History, profil, session mgmt |
| GET/PATCH | `/api/admin/*` | admin session | Dashboard, monitoring, LB, merge |
| POST | `/api/_internal/db/exec` · `db/query` · `kv/put` · `kv/get` | header key | Forwarding antar worker (allowlist tabel + prefix KV) |

## Quick Start

```bash
git clone git@github.com:OktzO/Komiks.git && cd Komiks
npm install                    # npm workspaces

npm run dev:api                # Worker API → http://localhost:8787
npm run dev:web                # Next.js    → http://localhost:3000
```

Setup pertama kali (D1, KV, secrets, migrations) → lihat [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Testing

```bash
# Unit — node:test + tsx (16 file di apps/api-cf, sisanya di packages/*)
npx tsx apps/api-cf/test/resolve.test.mjs
npx tsx packages/db/test/matching.test.mjs

# Web — bun
bun apps/web/test/round-robin.test.ts
bun apps/web/test/canonical-url.test.ts

# Typecheck
cd apps/web     && npx tsc --noEmit
cd apps/api-cf  && npx tsc --noEmit

# E2E (butuh dev server + API)
npx playwright test apps/web/e2e/
```

Total: **33 test file** di repo (api-cf 16, sources 5, db 4, lb 3, web 2, e2e 1, shared 1, vision 1).

## Deploy

```bash
# API worker (4 akun) — wrangler 3.114 dari root, WAJIB (wrangler 4 + compat lama = error 1042)
node scripts/build-worker-bundle.mjs
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy --config apps/api-cf/wrangler.toml          # akun-1
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy --config apps/api-cf/wrangler.origin.toml   # akun-2 (primary)
# idem wrangler.origin3.toml (akun-3), wrangler.origin4.toml (akun-4)

# Web — Node 22 + wrangler 4 (OpenNext → Cloudflare Worker)
cd apps/web && npx opennextjs-cloudflare build && npx wrangler deploy

# Migrations ke semua 4 D1
./scripts/migrate-all-4.sh       # CF_TOKEN_AKUN1..4 di env
```

Mapping config: `wrangler.toml` = akun-1 · `wrangler.origin.toml` = akun-2 · `wrangler.origin3.toml` = akun-3 · `wrangler.origin4.toml` = akun-4. Token di root `.env` (gitignored). Detail + gotchas token `cfut_` → [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Struktur Repo

```
Komiks/
├── apps/
│   ├── api-cf/           # Worker API (Hono) — routes/, lib/, test/ (16 file)
│   └── web/              # Next.js 16 App Router — (canon)/, components/, lib/
├── packages/
│   ├── db/               # D1 client + schema + migrations
│   ├── shared/           # Zod types, murmur3, B2 key routing
│   ├── sources/          # 5 source adapters
│   ├── lb/               # Load-balancer crypto + provision
│   └── vision/           # pHash image identify
├── scripts/              # build-worker-bundle, migrate-all-4.sh, smoke-*
├── docs/                 # DEPLOY, ADDING-ACCOUNT, TOS-REVIEW, superpowers/{specs,plans}
└── .opencode/skills/     # manga skill (AI assistant reference)
```

## Perubahan Terbaru

**2026-09-10 — Era URL kanonik typed** ([spec](docs/superpowers/specs/2026-09-08-canonical-typed-streaming-design.md), commit `641a835`):

- URL halaman satu-satunya: `/manga|manhwa|manhua/{slug}` — route lama `/{source}/s/*` **dihapus total** (404).
- Halaman detail streaming: shell render dulu, chapter + source di-stream via Suspense; auto default source.
- Endpoint baru `GET /api/resolve/:slug` (KV two-tier + enrich background 4s budget + singleflight pages).
- Semua link internal typed (`typedUrl`/`typedChapterUrl`/`safeType`); query `?id=`/`?mangaId=` dihapus.
- Turnstile login gate (widget explicit render + `onload=` param; verify server-side di `GET /auth/google`).
- API `GET /history` kini menyertakan `type` per row.

**2026-09-09 — Stabilisasi deploy 4 worker**: semua worker di kode yang sama, secret `TURNSTILE_SECRET_KEY` 4/4 akun, web pindah penuh ke OpenNext Worker (Node 22 + wrangler 4).

**Sebelumnya**: B2 expansion akun-4, data-quality rework, D1 sharding + B2 full storage, bookmark multi-source, reader prefetch + homepage 12h, landing page polish — design docs di [`docs/superpowers/specs/`](docs/superpowers/specs/).

## Gotchas

Penting yang sering kejadian — daftar lengkap di skill reference:

- Deploy API worker **wajib wrangler 3.114** (root `node_modules`). Wrangler 4 + compatibility date lama = worker 500 (error 1042). Web sebaliknya: **Node 22 + wrangler 4**.
- Setelah deploy web, cache key worker berubah — `Set-Cookie`/`Authorization` auto-bypass; route auth/user/admin wajib `no-store` (Workers Cache aktif).
- Redirect di server component **jangan dibungkus try/catch** — `NEXT_REDIRECT` adalah throw yang harus propagate.
- Script Turnstile explicit render **wajib** param `&onload=onTurnstileLoad` di URL — tanpa itu widget tidak pernah muncul.
- Token Cloudflare tipe `cfut_` tidak bisa POST (termasuk `wrangler secret put`) — set secret via raw `PUT /workers/scripts/{name}/secrets` (upsert).
- Dashboard chart kosong ~2 jam pertama setelah deploy (`db_usage_snapshot` butuh ≥ 2 titik cron).
