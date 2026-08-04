# Manga Reader Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build MVP manga reader: Next.js frontend on CF Pages, worker API with MangaDex source adapter + image proxy, D1/DB, KV cache, Lucia auth, bookmark/history, D1 search, and admin load-balancing panel.

**Architecture:** MonowRepo-ish apps `/apps/web`, `/apps/api-cf`, shared packages `/packages/db`, `/packages/lb`, `/packages/sources`, `/packages/shared`. Single canonical D1 schema. Reader endpoints run behind KV-based custom LB router (opsional native CF LB). Images proxied not rehosted.

**Tech Stack:** Next.js 13+ App Router (Pages runtime), Wrangler/Workers, D1, KV, R2, Lucia Auth, Zod, React Query, Tailwind. Tests: vitest (unit), no framework for worker edge unless jest-compatible.

## Global Constraints
- Node 18+, wrangler 3, Next.js App Router
- KV TTL 5-30min, stale-while-revalidate via waitUntil
- MangaDex images NEVER rehosted to R2; proxy-stream only
- LB admin: AES-GCM token encryption, secret key via `wrangler secret`
- CF Worker Cron Trigger min 1 min
- All `/api/admin/lb/*` admin-only + step-up reauth
- No new deps unless stdlib/edge-incompatible can't cover

---

### Task 1: Project scaffolding + tooling
**Files:**
- Create: `package.json` (root, workspaces), `turbo.json`, `/apps/api-cf/package.json`, `/apps/api-cf/tsconfig.json`, `/apps/api-cf/wrangler.toml`, `/apps/web/package.json`, `/apps/web/tsconfig.json`
- Create: `/apps/web/next.config.mjs`, `.dev.vars.example`

**Interfaces:**
- Consumes: none
- Produces: reproducible `turbo run dev:api` / `dev:web` scripts, `wrangler dev` config pointing to bound D1/KV/R2 names

- [ ] Step 1: create root package.json + turbo + ts configs
- [ ] Step 2: create app packages with deps; install
- [ ] Step 3: create `.dev.vars` + `wrangler.toml` with D1/KV/R2 placeholders
- [ ] Step 4: smoke `turbo run dev:api` compiles

### Task 2: D1 schema + migrations + db pkg
**Files:**
- Create: `/packages/db/schema.sql`, `/packages/db/seed.sql`, `/packages/db/index.ts` (query helpers typed)
- Create: `/packages/shared/types.ts` (zod schemas + row types)

**Interfaces:**
- Consumes: schema names from prompt §6
- Produces: `db.client`, helper fns `getSeries`, `getChapter`, etc.; zod `SeriesSchema`

- [ ] Step 1: write schema.sql (series, chapters, chapter_pages, users, bookmarks, reading_history, lb_settings, lb_accounts, lb_origins, lb_audit_log, + FTS5 virtual table `series_search`)
- [ ] Step 2: write /packages/shared/types.ts zod schemas
- [ ] Step 3: write db/index.ts helpers
- [ ] Step 4: create migration script; run locally (sqlite3) test table exists

### Task 3: Core Worker API framework
**Files:**
- Create: `/apps/api-cf/src/index.ts` (router), `src/routes/*.ts` stubs, `src/lib/context.ts` (env+helpers)
- Create: `/apps/api-cf/.dev.vars.example`

**Interfaces:**
- Consumes: `db` pkg, `shared` types
- Produces: typed `Context`, CORS, json helper, 404 fallback

- [ ] Step 1: write Context type with Env (DB, KV, R2, secrets)
- [ ] Step 2: wire `db` import to env.DB
- [ ] Step 3: add json/serialize helper + error handler
- [ ] Step 4: stub `/api/health`, `/api/series`, `/api/search` routes; route dispatch

### Task 4: MangaDex source adapter
**Files:**
- Create: `/packages/sources/mangadex/index.ts`, `/packages/sources/mangadex/client.ts`
- Create: `/packages/sources/index.ts` (router by sourceKey)

**Interfaces:**
- Consumes: MangaDex public API; env `MANGADEX_API_KEY` optional (rate limit)
- Produces: `getAdapter('mangadex')` returning `{ search, listChapters, getChapter, fetchPageUrl }`. Returns image URLs (not fetched).

- [ ] Step 1: write `client.ts` typed fetch wrappers for /manga, /chapter, /at-home/server
- [ ] Step 2: implement metadata list (map MangaDex fields to shared Series)
- [ ] Step 3: implement chapter pages resolver (decode at-home with token fetch)
- [ ] Step 4: wire router `/packages/sources/index.ts` + unit test against fixture

### Task 5: Image proxy endpoint (server-side stream, not rehost)
**Files:**
- Create: `/apps/api-cf/src/routes/reader.ts`

**Interfaces:**
- Consumes: source adapter `fetchPageUrl`
- Produces: `GET /api/reader/:source/:chapterId/:pageNo` — streams external image to client w/ CF cache header

- [ ] Step 1: route parse source/chapterId/pageNo
- [ ] Step 2: call adapter to resolve fresh image URL + token
- [ ] Step 3: forward-fetch + pipe Response to client, cache-control short TTL
- [ ] Step 4: 403/404 pass-through; test via `curl -I`

### Task 6: Reader endpoints
**Files:**
- Create: `/apps/api-cf/src/routes/reader.ts` (extend Task 5)

**Interfaces:**
- Consumes: adapter search/listChapters/getChapter + KV helpers
- Produces: `GET /api/reader/:source/s/:slug`, `/api/reader/:source/chapter/:chapterId` (with page URL list for client)

- [ ] Step 1: series detail by slug (KV cache stale-while-revalidate)
- [ ] Step 2: chapter list w/ page URL placeholders resolved via image-proxy path
- [ ] Step 3: chapter detail returns pages array of `{proxyUrl, originalUrl}`
- [ ] Step 4: hit test via curl

### Task 7: Frontend — pages skeleton + dark theme
**Files:**
- Create: `/apps/web/app/layout.tsx`, `/apps/web/app/(reader)/[source]/s/[slug]/page.tsx`, `[chapter]/page.tsx`, `/admin/settings/load-balancing/page.tsx`
- Create: `/apps/web/styles/globals.css` (spec tokens), `/apps/web/lib/api.ts` (typed fetch)

**Interfaces:**
- Consumes: `/api/reader/*` + `/api/user/*`
- Produces: themed shell, reader skeleton

- [ ] Step 1: globals.css + tailwind config
- [ ] Step 2: layout w/ providers + skeleton
- [ ] Step 3: /s/[slug] detail page + SSR fetch series
- [ ] Step 4: [chapter] page w/ image gallery (page mode + scroll mode toggle, lazy img)

### Task 8: Search + discovery endpoints
**Files:**
- Create/Modify: `/apps/api-cf/src/routes/search.ts`

**Interfaces:**
- Consumes: KV + D1 FTS5
- Produces: `GET /api/search?q=...`

- [ ] Step 1: parse q, hash, KV cache; fall back D1 FTS5 query
- [ ] Step 2: map results to shared Series type
- [ ] Step 3: write to KV short TTL
- [ ] Step 4: test query matches fixture

### Task 9: Auth (Lucia — email+Google) + sessions in KV
**Files:**
- Create: `/apps/api-cf/src/routes/auth.ts`, `/apps/web/app/(auth)/login/page.tsx`, `register`, etc.

**Interfaces:**
- Consumes: D1 users table, KV `session:{token}`, secret `AUTH_SECRET` / Google client
- Produces: login/register/google callback, `GET /api/me`

- [ ] Step 1: lucia + better-sqlite3 adapter → D1-compatible adapter (raw)
- [ ] Step 2: session store KV (`session:{id}` with expiry)
- [ ] Step 3: login/register/google OAuth + CSRF cookie
- [ ] Step 4: `/api/me` + web middleware protect `/admin`

### Task 10: Bookmark + reading history
**Files:**
- Create: `/apps/api-cf/src/routes/user.ts`

**Interfaces:**
- Consumes: requires session (user_id)
- Produces: `POST/GET /api/bookmark`, `POST /api/history` (last_page), `GET /api/history`

- [ ] Step 1: bookmark endpoints + dedupe on DB
- [ ] Step 2: history upsert (PK user_id,chapter_id)
- [ ] Step 3: auto-save last_page on page view (client)
- [ ] Step 4: web bookmark toggle + history page

### Task 11: Load balancing — settings + accounts (encrypted tokens)
**Files:**
- Create: `/packages/lb/crypto.ts`, `/packages/lb/accounts.ts`, `/packages/lb/router.ts`, `/apps/api-cf/src/routes/admin/lb.ts`

**Interfaces:**
- Consumes: env secret `LB_ENCRYPTION_KEY`, D1 lb_* tables
- Produces: AES-GCM encrypt/decrypt helpers + CRUD akun + native-vs-custom mode

- [ ] Step 1: `lb/crypto.ts` AES-GCM using Web Crypto
- [ ] Step 2: `lb/accounts.ts` add/verify/test-account (CF token verify, Vercel user)
- [ ] Step 3: admin routes w/ admin gate + step-up reauth (password re-prompt via header)
- [ ] Step 4: audit log insert on changes; unit test crypto roundtrip

### Task 12: Origin pool + health check + dashboard status
**Files:**
- Modify: `/packages/lb/router.ts`, `/apps/api-cf/src/routes/admin/lb.ts`, add cron handler

**Interfaces:**
- Consumes: KV `lb:origin_status` (short TTL), D1 lb_origins
- Produces: `GET /api/admin/lb/origins`, `GET /api/admin/lb/status`, `GET /api/health`

- [ ] Step 1: `GET /api/health` basic liveness + origin identity
- [ ] Step 2: router.ts `getHealthyOrigin()` reads KV; fallback first enabled
- [ ] Step 3: `GET /api/admin/lb/status` aggregate KV + DB; `GET /api/admin/lb/origins` list
- [ ] Step 4: Cron Trigger every minute: loop origins, fetch `/api/health`, write status; test local schedule

### Task 13: Admin LB panel (UI) + native-mode stub
**Files:**
- Modify: `/apps/web/app/admin/settings/load-balancing/page.tsx`

**Interfaces:**
- Consumes: `/api/admin/lb/*`
- Produces: toggle mode, account table+form, origin pool editor, steering select, status dashboard

- [ ] Step 1: mode toggle (fetch/update settings)
- [ ] Step 2: accounts table + add (masked token via token_last4) + edit/test/delete
- [ ] Step 3: origin pool (priority/weight/enabled) + auto-detect from Vercel button
- [ ] Step 4: status dashboard live polling `/api/admin/lb/status`

### Task 14: Rate limiting + security hardening
**Files:**
- Modify: `/apps/api-cf/src/lib/context.ts`, add `src/middleware/rateLimit.ts`

**Interfaces:**
- Consumes: KV `ratelimit:{ip}:{endpoint}`
- Produces: per-IP 60 req/min ceiling + admin step-up for LB

- [ ] Step 1: KV counter + 429 after threshold
- [ ] Step 2: global rate-limit middleware + admin routes require admin+step-up
- [ ] Step 3: CF WAF recommended (doc). `wrangler secret` for keys
- [ ] Step 4: load test via `ab` returns 429 past ceiling

### Task 15: Deploy + smoke
**Files:**
- Create: `.github/workflows/deploy.yml` (optional), docs notes

**Interfaces:**
- Consumes: tasks 1-14 working locally
- Produces: deployed staging; smoke test passes

- [ ] Step 1: `wrangler d1 create` + migrations apply
- [ ] Step 2: create KV + R2 bindings in wrangler.toml
- [ ] Step 3: store all secrets (`LB_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID/SECRET`, `MANGADEX_API_KEY`)
- [ ] Step 4: `wrangler deploy` + `vercel deploy` web. Smoke test reader + admin.

## Self-review notes
- Spec coverage: semua MVP items §Akhir spec cover Tasks 1-15.
- Types: `Series`, `Chapter` shapes consistent between adapter, DB schema, frontend.
- Token encryption in crypto.ts only; frontend never sees raw token.
