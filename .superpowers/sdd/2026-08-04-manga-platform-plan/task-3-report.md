# Task 3 Report — Core Worker API framework

## Status
**Complete.** `apps/api-cf` core Worker scaffold replaced with a typed Hono app: `Env`/`Context` + helpers (`getDb`, `json`, `parseAllowedOrigins`, `sha256Hex`) in `src/lib/context.ts`, a custom CORS middleware, an `onError` 500 handler and a `notFound` 404 fallback, and three route modules (`health`, `series`, `search`) mounted under `/api`. `tsc --noEmit` (strict) exits 0; `wrangler dev` smoke confirms `/api/health` → 200, OPTIONS preflight → 204 with correct CORS headers, and unknown path → 404. DB-backed reads return 500 under `wrangler dev` as expected (no local D1 tables).

## Commit
`54a61c5` — *feat(task3): api-cf core worker API framework (Hono app, CORS, routes, typed context)*
(branch `sdd/manga-platform`, on top of BASE `a686c2b`).

## Files
- **Created**
  - `apps/api-cf/src/lib/context.ts` — `Env` interface (DB/KV/R2 + secrets + `[k:string]:unknown`), `Context` type alias, `getDb(c)` → `db(c.env.DB)`, `json` helper, `parseAllowedOrigins`, `sha256Hex`.
  - `apps/api-cf/src/routes/health.ts` — `GET /api/health` → `{status:"ok", ts:<unix>}`.
  - `apps/api-cf/src/routes/series.ts` — `GET /api/series` (KV-stale+fresh, 600s TTL), `GET /api/series/:slug` (detail, 600s TTL), `GET /api/series/:slug/:chapterId` stub returning `{chapter}`.
  - `apps/api-cf/src/routes/search.ts` — `GET /api/search?q=` (KV `search:{sha256(q)}` 120s TTL, falls back to `db.searchSeries`).
- **Modified**
  - `apps/api-cf/src/index.ts` — Hono app `{Bindings: Env}`, custom CORS middleware (dynamic origin from `c.env.ALLOWED_ORIGINS`, default `http://localhost:3000`, `Vary: Origin`, methods `GET/POST/PUT/DELETE`, headers `Content-Type,Authorization`, OPTIONS 204), `app.route('/api', …)` for all three routers, `onError` → `{error}` 500, `notFound` → `{error:"Not Found"}` 404.
  - `apps/api-cf/wrangler.toml` — aligned D1 binding `MANGA_DB` → `DB` to match `Env.DB`.
  - `apps/api-cf/.dev.vars.example` — added `ALLOWED_ORIGINS`.
- (Task 2 review doc `docs/superpowers/plans/2026-08-04-task2-lb-schema-fix.md` was left staged/unstaged in-tree and intentionally **not** swept into this commit.)

## Verification (Step 4)
- **tsc strict:** `npx tsc --noEmit -p apps/api-cf` (tsconfig `strict: true`, `moduleResolution: Bundler`, `@cloudflare/workers-types`) → **EXIT 0**.
- **`wrangler dev --port 8787`** (Miniflare local simulation):
  - `GET /api/health` → **200** `{"status":"ok","ts":1785843133}` (unix epoch seconds). PASS.
  - `GET /api/series` / `GET /api/search?q=onepiece` / `GET /api/series/:slug` → **500** `{"error":"Internal Server Error"}`. Expected: local simulated D1 has no schema tables, so `db` helper SQL throws; `onError` catches → 500. (Spec: "dev uses local D1? wrangler dev has no real DB; expect 500 for DB calls but health 200. Acceptable.")
  - `GET /api/nope` → **404** `{"error":"Not Found"}` (404 fallback). PASS.
  - `OPTIONS /api/health` (Origin `http://localhost:3000`) → **204**, headers:
    `Access-Control-Allow-Origin: http://localhost:3000`, `Vary: Origin`,
    `Access-Control-Allow-Methods: GET, POST, PUT, DELETE`,
    `Access-Control-Allow-Headers: Content-Type, Authorization`, `Access-Control-Max-Age: 600`. PASS.
- CORS headers also observed persisting on subsequent `c.json` handler responses (Hono `newResponse` copies prior `c.res` headers into the final `Response`).

## Decisions applied (verbatim)
- Env interface lives in `src/lib/context.ts` with the exact fields specified (`DB`, `CACHE_KV`, `ASSETS_R2`, `LB_ENCRYPTION_KEY`, optional Google/Mangadex/admin secrets, `[k:string]: unknown`); added `ALLOWED_ORIGINS?: string` (consumed by CORS) — a superset of the spec's explicit list.
- `getDb(c)` returns `db(c.env.DB)` (the `db` factory from `@manga-platform/db`).
- Custom CORS middleware (built-in `hono/cors` origin fn takes no `Context`, so cannot read `c.env.ALLOWED_ORIGINS`); origin is dynamic + `Vary: Origin`. `json(c, data, init?)` forwards to Hono `c.json`. `onError` → `{error}` 500; `notFound` → 404 fallback.
- Routes as three files each `export const router = new Hono<{ Bindings: Env }>()`, mounted via `app.route('/api', router)` in `index.ts`. `GET /api/health` is the LB liveness endpoint (Task 12). `GET /api/series/:slug/:chapterId` is a stub returning `{chapter}`.
- `tsc --noEmit` must pass before `wrangler dev`; `node_modules`/`.wrangler`/local D1 not committed (`.gitignore` covers them).

## Concerns / notes
- `json` helper casts `data`/`init` through `never` to satisfy Hono 3.12's `JSONValue`-constrained `c.json` overloads (zod `z.infer` row types include `| undefined` from optional schema keys, so they don't satisfy `JSONValue`). Runtime is a plain forward; no behavior change.
- Custom CORS sets `Access-Control-Allow-Methods`/`Allow-Headers` on every response (also on non-OPTIONS). The built-in `hono/cors` sets these only for OPTIONS — our broader application is intentional per the spec ("set … allow methods …, headers …") but could be tightened to OPTIONS-only if desired.
- Series list cache stores `{data, ts}` with `expirationTtl: 600` and a 300s freshness gate (serve fresh cache, else refetch) — per spec; no background revalidation/invalidation yet ("Detailed invalidation later").
- `wrangler dev` local D1 is empty; DB routes 500 until schema is applied (Task 2 `schema.sql` exists but was not wired as a migration here — out of scope for Task 3). `LB_ENCRYPTION_KEY` etc. are required at deploy (CF `vars`/secrets); dev defaults cover CORS origin only.
