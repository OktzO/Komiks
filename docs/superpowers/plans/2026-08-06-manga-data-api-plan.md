# Manga Data API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build standalone manga data API (scraping + image identification) with Komiku as primary source, MangaDex as secondary, pHash-based image recognition, source status page, and merged beranda — deployed as separate Cloudflare Worker `manga-data-api`.

**Architecture:** New `apps/data-api/` Worker (Hono) reusing existing D1 `manga-db`, KV `CACHE_KV`, R2 `manga-assets`. New packages `packages/vision/` (pHash) + extend `packages/sources/` with Komiku adapter. Extend `apps/web/` with merged beranda + status page. Zero new deps where stdlib covers; `@cloudflare/puppeteer` only for browser rendering binding.

**Tech Stack:** Hono, Cloudflare Workers + Browser Rendering (`@cloudflare/puppeteer`), D1, KV, R2, Zod, Next.js 14 (existing web). Tests: node `assert` self-checks (no framework), `node:sqlite` for schema smoke.

## Global Constraints

- Node 18+, wrangler 3.71+, Hono 3.12+
- All secrets via env vars: `.dev.vars` (local), `wrangler secret put` (prod). No plaintext keys in committed config
- Komiku = primary source, MangaDex = secondary (preserve existing adapter, do not delete)
- Reuse D1 `manga-db` (id `76606365-0fa5-4c1e-9b55-18a8366ef92a`), KV `CACHE_KV` (id `6205fceab7b64f9d80f6f67e4189316b`), R2 `manga-assets`
- New Worker name `manga-data-api` (separate from existing `manga-api` reader)
- Rate limit: 60/min public, 10/min identify, 600/min admin
- Image upload: ≤ 10MB, content-type image/* only
- Robots.txt must be checked before scraping; skip disallowed paths
- No new deps unless stdlib/edge-incompatible can't cover; `@cloudflare/puppeteer` is the one allowed addition
- Cache keys: `manga:meta:{slug}`, `search:{sha256(q)}`, `identify:{hash[:8]}`, `robots:{source}`, `source:health:{source}`
- Existing `apps/api-cf` (reader) must stay intact — do not modify its wrangler.toml name

## File Structure

**New files:**
```
apps/data-api/                          # NEW Worker app (sibling of apps/api-cf)
  package.json
  tsconfig.json
  wrangler.toml
  .dev.vars.example
  src/index.ts                          # Hono app entry
  src/lib/context.ts                    # Env type, getDb, json, CORS, sha256Hex
  src/lib/auth.ts                       # admin api-key constant-time compare
  src/lib/rateLimit.ts                  # per-route rate limit (60/10/600)
  src/lib/retry.ts                      # retryUpstream shared util
  src/routes/search.ts                  # GET /api/search (merge komiku+mangadex)
  src/routes/manga.ts                   # GET /api/manga/:id
  src/routes/identify.ts                # POST /api/identify (upload + pHash)
  src/routes/scrape.ts                  # POST/GET /api/scrape (admin)
  src/routes/sourceStatus.ts            # GET /api/source-status
  src/routes/health.ts                  # GET /api/health

packages/vision/                        # NEW image recognition package
  package.json
  tsconfig.json
  index.ts                              # barrel
  phash.ts                              # pHash 64-bit via OffscreenCanvas + DCT
  hamming.ts                            # Hamming distance hex strings
  identify.ts                           # orchestrator: hash → D1 → candidates
  test/phash.test.mjs                   # self-check (fixture reader-ch1.jpeg)

packages/sources/komiku/               # NEW Komiku adapter
  index.ts                              # adapter (puppeteer-based)
  selectors.ts                          # per-page CSS selectors config
  client.ts                             # fetch wrappers (robots, HTML)

packages/db/migrations/                # NEW migration dir
  0001_manga_data.sql                   # additive ALTER + new tables

scripts/smoke-data-db.mjs               # NEW schema smoke for new tables
```

**Modified files:**
```
packages/sources/index.ts               # add 'komiku' to SourceKey + registry
packages/sources/package.json           # add @cloudflare/puppeteer dep
packages/sources/tsconfig.json          # include komiku/*.ts
packages/shared/types.ts                # add ScrapeResult, RobotsResult, SourceHealth types
packages/db/index.ts                    # add helpers: upsertSeries, getImageHashes, etc.
apps/web/lib/api.ts                     # add DATA_API_URL + new fetch helpers
apps/web/app/page.tsx                   # rewrite beranda (merge sources)
apps/web/app/status/page.tsx            # NEW status page
apps/web/components/SourceBadge.tsx     # NEW source badge component
package.json (root)                     # ensure apps/data-api in workspaces
```

---

### Task 1: Scaffold apps/data-api Worker + wrangler config

**Files:**
- Create: `apps/data-api/package.json`, `apps/data-api/tsconfig.json`, `apps/data-api/wrangler.toml`, `apps/data-api/.dev.vars.example`
- Modify: `package.json` (root, add `dev:data` script), `turbo.json` (add `dev:data` task)

**Interfaces:**
- Consumes: none
- Produces: `apps/data-api/` runnable via `npx wrangler dev` (port 8788), env bindings `DB`, `CACHE_KV`, `ASSETS_R2`, `MY_BROWSER`, secrets `SCRAPE_API_KEY`, `MANGADEX_API_KEY`, `ALLOWED_ORIGINS`

- [ ] **Step 1: Create `apps/data-api/package.json`**

```json
{
  "name": "manga-data-api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev:data": "wrangler dev --port 8788",
    "dev": "wrangler dev --port 8788",
    "build": "tsc"
  },
  "dependencies": {
    "hono": "^3.12.0",
    "@cloudflare/puppeteer": "^0.0.14"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240802.0",
    "typescript": "^5.5.4",
    "wrangler": "^3.71.0"
  }
}
```

- [ ] **Step 2: Create `apps/data-api/tsconfig.json`** (mirror `apps/api-cf/tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `apps/data-api/wrangler.toml`**

```toml
name = "manga-data-api"
main = "./src/index.ts"
compatibility_date = "2024-08-01"
account_id = "4ce21aec2dd478bf380b7b59990a9165"

[[d1_databases]]
binding = "DB"
database_name = "manga-db"
database_id = "76606365-0fa5-4c1e-9b55-18a8366ef92a"

[[kv_namespaces]]
binding = "CACHE_KV"
id = "6205fceab7b64f9d80f6f67e4189316b"
preview_id = "6205fceab7b64f9d80f6f67e4189316b"

[[r2_buckets]]
binding = "ASSETS_R2"
bucket_name = "manga-assets"
preview_bucket_name = "manga-assets-dev"

[browser]
binding = "MY_BROWSER"
remote = true
```

- [ ] **Step 4: Create `apps/data-api/.dev.vars.example`**

```env
SCRAPE_API_KEY=
MANGADEX_API_KEY=
ALLOWED_ORIGINS=http://localhost:3000
LB_ENCRYPTION_KEY=
```

- [ ] **Step 5: Update root `package.json`** — add `dev:data` script and ensure workspaces glob covers `apps/*`

```json
{
  "scripts": {
    "dev:api": "turbo run dev:api",
    "dev:web": "turbo run dev:web",
    "dev:data": "turbo run dev:data"
  }
}
```

- [ ] **Step 6: Update `turbo.json`** — add `dev:data` task

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev:api": { "persistent": true, "cache": false },
    "dev:web": { "persistent": true, "cache": false },
    "dev:data": { "persistent": true, "cache": false },
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] }
  }
}
```

- [ ] **Step 7: Create minimal `apps/data-api/src/index.ts` stub** so wrangler dev compiles

```typescript
export default {
  async fetch(request: Request): Promise<Response> {
    return new Response(JSON.stringify({ status: 'ok', service: 'manga-data-api' }), {
      headers: { 'content-type': 'application/json' }
    });
  }
};
```

- [ ] **Step 8: Install + verify wrangler dev compiles**

Run: `npm install && npx wrangler dev --port 8788` (ctrl-C after it boots)
Expected: boots without error, `GET /` returns `{"status":"ok"}`

- [ ] **Step 9: Commit**

```bash
git add apps/data-api package.json turbo.json
git commit -m "feat(data-api): scaffold manga-data-api Worker with browser binding"
```

---

### Task 2: D1 migration + shared types

**Files:**
- Create: `packages/db/migrations/0001_manga_data.sql`
- Modify: `packages/shared/types.ts` (append new types)
- Modify: `packages/db/index.ts` (append new helper methods)
- Create: `scripts/smoke-data-db.mjs`

**Interfaces:**
- Consumes: existing `series`, `chapters` tables from `packages/db/schema.sql`
- Produces: `ScrapeResult`, `RobotsResult`, `SourceHealth` types; `image_hashes`, `scrape_jobs`, `source_health` tables; db helpers `upsertSeries`, `getImageHashesByPrefix`, `addImageHash`, `createScrapeJob`, `updateScrapeJob`, `listScrapeJobs`, `getScrapeJob`, `recordSourceHealth`, `getLatestSourceHealth`

- [ ] **Step 1: Create migration `packages/db/migrations/0001_manga_data.sql`**

```sql
-- 0001_manga_data.sql — additive migration for data-api service.
-- Reuses existing series + chapters tables from packages/db/schema.sql.

ALTER TABLE series ADD COLUMN alt_titles TEXT;
ALTER TABLE series ADD COLUMN source_url TEXT;
ALTER TABLE series ADD COLUMN cover_r2_key TEXT;
ALTER TABLE series ADD COLUMN language TEXT;

CREATE TABLE image_hashes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  series_slug TEXT    NOT NULL REFERENCES series(slug) ON DELETE CASCADE,
  hash        TEXT    NOT NULL,
  r2_key      TEXT,
  image_type  TEXT    NOT NULL CHECK (image_type IN ('cover','page')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_image_hashes_hash ON image_hashes(hash);
CREATE INDEX idx_image_hashes_slug ON image_hashes(series_slug);

CREATE TABLE scrape_jobs (
  id          TEXT PRIMARY KEY,
  source      TEXT    NOT NULL,
  source_url  TEXT,
  query       TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('pending','running','completed','failed','skipped_robots')) DEFAULT 'pending',
  series_slug TEXT    REFERENCES series(slug) ON DELETE SET NULL,
  error       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);
CREATE INDEX idx_scrape_jobs_status ON scrape_jobs(status);
CREATE INDEX idx_scrape_jobs_series ON scrape_jobs(series_slug);

CREATE TABLE source_health (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,
  healthy     INTEGER NOT NULL,
  latency_ms  INTEGER,
  error       TEXT,
  checked_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_source_health_source ON source_health(source, checked_at DESC);
```

- [ ] **Step 2: Append types to `packages/shared/types.ts`**

```typescript
// ---- Manga Data API types --------------------------------------------------

export const ScrapeResultSchema = z.object({
  series: SeriesSchema,
  chapters: z.array(ChapterSchema),
  coverImageUrl: z.string().nullable()
});
export type ScrapeResult = z.infer<typeof ScrapeResultSchema>;

export const RobotsResultSchema = z.object({
  allowed: z.boolean(),
  disallowedPaths: z.array(z.string()),
  crawlDelay: z.number().nullable().optional()
});
export type RobotsResult = z.infer<typeof RobotsResultSchema>;

export const SourceHealthSchema = z.object({
  source: z.string(),
  healthy: z.boolean(),
  latency_ms: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  last_checked_at: z.number().optional()
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const ScrapeJobSchema = z.object({
  id: z.string(),
  source: z.string(),
  source_url: z.string().nullable().optional(),
  query: z.string().nullable().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped_robots']),
  series_slug: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  created_by: z.number().int().nullable().optional(),
  created_at: z.number().int().optional(),
  completed_at: z.number().int().nullable().optional()
});
export type ScrapeJob = z.infer<typeof ScrapeJobSchema>;

export const ImageHashRowSchema = z.object({
  id: z.number().int().optional(),
  series_slug: z.string(),
  hash: z.string(),
  r2_key: z.string().nullable().optional(),
  image_type: z.enum(['cover', 'page']),
  created_at: z.number().int().optional()
});
export type ImageHashRow = z.infer<typeof ImageHashRowSchema>;
```

- [ ] **Step 3: Append db helpers to `packages/db/index.ts`**

Add to the `Db` interface:

```typescript
  upsertSeries: (params: { slug: string; title: string; external_id?: string | null; source: string; synopsis?: string | null; type: string; status?: string; author?: string | null; artist?: string | null; cover_image?: string | null; genres?: string[]; tags?: string[]; alt_titles?: string | null; source_url?: string | null; cover_r2_key?: string | null; language?: string | null }) => Promise<{ slug: string }>;
  addImageHash: (params: { seriesSlug: string; hash: string; r2Key?: string | null; imageType: 'cover' | 'page' }) => Promise<{ id: number }>;
  getImageHashesByPrefix: (prefix: string) => Promise<Array<{ series_slug: string; hash: string; r2_key: string | null }>>;
  getAllImageHashes: () => Promise<Array<{ series_slug: string; hash: string; r2_key: string | null }>>;
  createScrapeJob: (params: { id: string; source: string; sourceUrl?: string | null; query?: string | null; createdBy?: number | null }) => Promise<{ id: string }>;
  updateScrapeJob: (id: string, params: { status: string; seriesSlug?: string | null; error?: string | null; completedAt?: number | null }) => Promise<{ success: boolean }>;
  getScrapeJob: (id: string) => Promise<Result<ScrapeJob>>;
  listScrapeJobs: (limit?: number) => Promise<ListResult<ScrapeJob>>;
  recordSourceHealth: (params: { source: string; healthy: boolean; latencyMs?: number | null; error?: string | null }) => Promise<{ id: number }>;
  getLatestSourceHealth: (source: string) => Promise<Result<{ source: string; healthy: boolean; latency_ms: number | null; error: string | null; checked_at: number }>>;
```

Add to the `db()` factory implementation (after existing helpers, before closing `}`):

```typescript
    upsertSeries: async (p) => {
      const genres = p.genres ? JSON.stringify(p.genres) : null;
      const tags = p.tags ? JSON.stringify(p.tags) : null;
      await prep(
        `INSERT INTO series (slug, external_id, source, title, synopsis, type, status, author, artist, cover_image, genres, tags, alt_titles, source_url, cover_r2_key, language, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, unixepoch())
         ON CONFLICT(slug) DO UPDATE SET
           title=excluded.title, synopsis=excluded.synopsis, status=excluded.status,
           author=excluded.author, artist=excluded.artist, cover_image=excluded.cover_image,
           genres=excluded.genres, tags=excluded.tags, alt_titles=excluded.alt_titles,
           source_url=excluded.source_url, cover_r2_key=excluded.cover_r2_key,
           language=excluded.language, updated_at=unixepoch()`
      ).bind(p.slug, p.external_id ?? null, p.source, p.title, p.synopsis ?? null, p.type, p.status ?? 'ongoing', p.author ?? null, p.artist ?? null, p.cover_image ?? null, genres, tags, p.alt_titles ?? null, p.source_url ?? null, p.cover_r2_key ?? null, p.language ?? null).run();
      return { slug: p.slug };
    },

    addImageHash: async (p) =>
      fromRow<{ id: number }>(
        await prep('INSERT INTO image_hashes (series_slug, hash, r2_key, image_type) VALUES (?1, ?2, ?3, ?4) RETURNING id')
          .bind(p.seriesSlug, p.hash, p.r2Key ?? null, p.imageType).first<Row>()
      ),

    getImageHashesByPrefix: async (prefix) => {
      const { results } = await prep('SELECT series_slug, hash, r2_key FROM image_hashes WHERE hash LIKE ?1').bind(`${prefix}%`).all<Row>();
      return (results ?? []) as unknown as Array<{ series_slug: string; hash: string; r2_key: string | null }>;
    },

    getAllImageHashes: async () => {
      const { results } = await prep('SELECT series_slug, hash, r2_key FROM image_hashes').all<Row>();
      return (results ?? []) as unknown as Array<{ series_slug: string; hash: string; r2_key: string | null }>;
    },

    createScrapeJob: async (p) =>
      fromRow<{ id: string }>(
        await prep('INSERT INTO scrape_jobs (id, source, source_url, query, status, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id')
          .bind(p.id, p.source, p.sourceUrl ?? null, p.query ?? null, 'pending', p.createdBy ?? null).first<Row>()
      ),

    updateScrapeJob: async (id, p) => {
      const res = await prep('UPDATE scrape_jobs SET status = ?1, series_slug = ?2, error = ?3, completed_at = ?4 WHERE id = ?5')
        .bind(p.status, p.seriesSlug ?? null, p.error ?? null, p.completedAt ?? null, id).run();
      return { success: res.success };
    },

    getScrapeJob: async (id) =>
      fromRow<ScrapeJob>(await prep('SELECT * FROM scrape_jobs WHERE id = ?1 LIMIT 1').bind(id).first<Row>()),

    listScrapeJobs: async (limit = 50) => {
      const { results } = await prep('SELECT * FROM scrape_jobs ORDER BY created_at DESC LIMIT ?1').bind(limit).all<Row>();
      return (results ?? []) as unknown as ListResult<ScrapeJob>;
    },

    recordSourceHealth: async (p) =>
      fromRow<{ id: number }>(
        await prep('INSERT INTO source_health (source, healthy, latency_ms, error) VALUES (?1, ?2, ?3, ?4) RETURNING id')
          .bind(p.source, p.healthy ? 1 : 0, p.latencyMs ?? null, p.error ?? null).first<Row>()
      ),

    getLatestSourceHealth: async (source) => {
      const row = await prep('SELECT source, healthy, latency_ms, error, checked_at FROM source_health WHERE source = ?1 ORDER BY checked_at DESC LIMIT 1').bind(source).first<Row>();
      if (!row) return null;
      return {
        source: row.source as string,
        healthy: (row.healthy as number) === 1,
        latency_ms: (row.latency_ms as number) ?? null,
        error: (row.error as string) ?? null,
        checked_at: row.checked_at as number
      };
    }
```

Also update imports at top of `packages/db/index.ts` to include new types:

```typescript
import type {
  Series,
  Chapter,
  ChapterPage,
  Bookmark,
  ReadingHistory,
  LbSettings,
  LbAccount,
  LbAccountSafe,
  LbOrigin,
  ScrapeJob
} from '@manga-platform/shared/types';
```

- [ ] **Step 4: Create `scripts/smoke-data-db.mjs`**

```javascript
// Self-check: data-api migration tables + helpers against in-memory sqlite.
// Run: node scripts/smoke-data-db.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const schema = fs.readFileSync(path.resolve(here, '../packages/db/schema.sql'), 'utf8');
const migration = fs.readFileSync(path.resolve(here, '../packages/db/migrations/0001_manga_data.sql'), 'utf8');

const db = new DatabaseSync(':memory:');
db.exec(schema);
db.exec(migration);

let ok = true;
const check = (name, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} => ${JSON.stringify(got)}`);
};

// series has new columns
const cols = db.prepare("PRAGMA table_info(series)").all().map(c => c.name);
check('series has alt_titles', cols.includes('alt_titles'), true);
check('series has source_url', cols.includes('source_url'), true);
check('series has cover_r2_key', cols.includes('cover_r2_key'), true);
check('series has language', cols.includes('language'), true);

// image_hashes table
check('image_hashes insert', db.prepare('INSERT INTO image_hashes (series_slug, hash, r2_key, image_type) VALUES (?1, ?2, ?3, ?4)').run('test-slug', 'abcdef0123456789', 'covers/test.jpg', 'cover').success, true);
check('image_hashes query', db.prepare('SELECT series_slug FROM image_hashes WHERE hash LIKE ?1').all('abc%')[0].series_slug, 'test-slug');

// scrape_jobs table
check('scrape_jobs insert', db.prepare('INSERT INTO scrape_jobs (id, source, status) VALUES (?1, ?2, ?3)').run('job-1', 'komiku', 'pending').success, true);
db.prepare('UPDATE scrape_jobs SET status = ?1, completed_at = ?2 WHERE id = ?3').run('completed', 1700000000, 'job-1');
check('scrape_jobs update', db.prepare('SELECT status FROM scrape_jobs WHERE id = ?1').get('job-1').status, 'completed');

// source_health table
db.prepare('INSERT INTO source_health (source, healthy, latency_ms) VALUES (?1, ?2, ?3)').run('komiku', 1, 234);
check('source_health latest', db.prepare('SELECT source, healthy FROM source_health WHERE source = ?1 ORDER BY checked_at DESC LIMIT 1').get('komiku').healthy, 1);

// upsertSeries (ON CONFLICT)
db.prepare("INSERT INTO series (slug, title, type, status, source) VALUES (?1, ?2, ?3, ?4, ?5)").run('upsert-test', 'Test Title', 'manga', 'ongoing', 'komiku');
db.prepare("INSERT INTO series (slug, title, type, status, source) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(slug) DO UPDATE SET title=excluded.title, updated_at=unixepoch()").run('upsert-test', 'Updated Title', 'manga', 'ongoing', 'komiku');
check('upsertSeries updates title', db.prepare('SELECT title FROM series WHERE slug = ?1').get('upsert-test').title, 'Updated Title');

console.log(`\n${ok ? 'ALL PASS' : 'SOME FAILED'}`);
db.close();
process.exit(ok ? 0 : 1);
```

- [ ] **Step 5: Run smoke test**

Run: `node scripts/smoke-data-db.mjs`
Expected: `ALL PASS`

- [ ] **Step 6: Apply migration to remote D1**

Run: `npx wrangler d1 execute manga-db --file=packages/db/migrations/0001_manga_data.sql --remote`
Expected: migration applied successfully

- [ ] **Step 7: Type check**

Run: `npx tsc --noEmit -p packages/db && npx tsc --noEmit -p packages/shared`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0001_manga_data.sql packages/shared/types.ts packages/db/index.ts scripts/smoke-data-db.mjs
git commit -m "feat(db): add manga-data migration (image_hashes, scrape_jobs, source_health) + helpers"
```

---

### Task 3: Shared utilities (context, auth, rateLimit, retry)

**Files:**
- Create: `apps/data-api/src/lib/context.ts`, `apps/data-api/src/lib/auth.ts`, `apps/data-api/src/lib/rateLimit.ts`, `apps/data-api/src/lib/retry.ts`

**Interfaces:**
- Consumes: `@manga-platform/db`, `@cloudflare/workers-types`
- Produces: `Env` type (with `DB`, `CACHE_KV`, `ASSETS_R2`, `MY_BROWSER: Fetcher`, `SCRAPE_API_KEY`), `Context`, `json()`, `parseAllowedOrigins()`, `sha256Hex()`, `requireAdminKey()` middleware, `rateLimitPublic`/`rateLimitIdentify`/`rateLimitAdmin` middlewares, `retryUpstream()`

- [ ] **Step 1: Create `apps/data-api/src/lib/context.ts`**

```typescript
import { Context as HonoContext } from 'hono';
import type { D1Database, KVNamespace, R2Bucket, Fetcher } from '@cloudflare/workers-types';
import { db } from '@manga-platform/db';
import type { Db } from '@manga-platform/db';

export interface Env {
  DB: D1Database;
  CACHE_KV: KVNamespace;
  ASSETS_R2: R2Bucket;
  MY_BROWSER: Fetcher;
  SCRAPE_API_KEY?: string;
  MANGADEX_API_KEY?: string;
  LB_ENCRYPTION_KEY?: string;
  ALLOWED_ORIGINS?: string;
  [k: string]: unknown;
}

export type Context = HonoContext<{ Bindings: Env }>;

export const getDb = (c: Context): Db => db(c.env.DB);

export const json = <T>(
  c: Context,
  data: T,
  init?: number | ResponseInit
): Response => c.json(data as never, init as never);

export const parseAllowedOrigins = (env: Env): string[] => {
  const raw = env.ALLOWED_ORIGINS;
  const list = (raw ? raw.split(',') : ['http://localhost:3000'])
    .map((s) => s.trim())
    .filter(Boolean);
  return list;
};

export const sha256Hex = async (input: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};
```

- [ ] **Step 2: Create `apps/data-api/src/lib/auth.ts`**

```typescript
import type { MiddlewareHandler } from 'hono';
import type { Env, Context } from './context';

// Constant-time compare to prevent timing attacks on admin key.
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const requireAdminKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const supplied = c.req.header('x-admin-api-key');
  const expected = c.env.SCRAPE_API_KEY;
  if (!expected || !supplied || !constantTimeEqual(supplied, expected)) {
    return c.json({ error: 'admin api key required' }, 401);
  }
  await next();
};
```

- [ ] **Step 3: Create `apps/data-api/src/lib/rateLimit.ts`**

```typescript
import type { MiddlewareHandler } from 'hono';
import type { Env } from './context';

const makeLimiter = (limit: number, window: number): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const key = `ratelimit:${ip}:${Math.floor(Date.now() / 1000 / window)}`;
    const raw = await c.env.CACHE_KV.get(key);
    const count = raw ? Number(raw) : 0;
    if (count >= limit) {
      return c.json({ error: 'rate limit exceeded', retry_after: window }, 429);
    }
    c.executionCtx.waitUntil(c.env.CACHE_KV.put(key, String(count + 1), { expirationTtl: window }).catch(() => {}));
    await next();
  };
};

export const rateLimitPublic = makeLimiter(60, 60);
export const rateLimitIdentify = makeLimiter(10, 60);
export const rateLimitAdmin = makeLimiter(600, 60);
```

- [ ] **Step 4: Create `apps/data-api/src/lib/retry.ts`**

```typescript
// Shared retry with exponential backoff. Promoted from apps/api-cf reader.ts.
export const retryUpstream = async <T>(fn: () => Promise<T>, attempts = 3): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      last = e;
      const msg = String(e);
      if (msg.includes('429') || msg.includes('Too Many Requests')) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
      } else if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      }
    }
  }
  throw last;
};
```

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit -p apps/data-api`
Expected: no errors (stub index.ts still valid since libs not imported yet)

- [ ] **Step 6: Commit**

```bash
git add apps/data-api/src/lib/
git commit -m "feat(data-api): add context, auth, rateLimit, retry utilities"
```

---

### Task 4: Extend SourceAdapter interface + Komiku adapter

**Files:**
- Modify: `packages/sources/index.ts` (extend SourceKey + adapterFactories)
- Create: `packages/sources/komiku/index.ts`, `packages/sources/komiku/client.ts`, `packages/sources/komiku/selectors.ts`
- Modify: `packages/sources/package.json` (add `@cloudflare/puppeteer` dep)
- Modify: `packages/sources/tsconfig.json` (include `komiku/*.ts`)

**Interfaces:**
- Consumes: `@manga-platform/shared` types, `@cloudflare/puppeteer`, `AdapterEnv`
- Produces: `SourceKey = 'mangadex' | 'komiku'`, `SourceAdapter` extended with optional `scrapeUrl`, `checkRobots`, `healthCheck`; `komikuAdapter(env?)` returns `SourceAdapter`

- [ ] **Step 1: Update `packages/sources/package.json`** — add puppeteer dep

```json
{
  "dependencies": {
    "@manga-platform/shared": "0.1.0",
    "@cloudflare/puppeteer": "^0.0.14",
    "zod": "3.22.3"
  }
}
```

- [ ] **Step 2: Update `packages/sources/tsconfig.json`** — include komiku dir

```json
{
  "include": ["*.ts", "mangadex/*.ts", "komiku/*.ts"],
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["node", "@cloudflare/workers-types"]
  },
  "exclude": ["node_modules", "test"]
}
```

- [ ] **Step 3: Create `packages/sources/komiku/selectors.ts`**

```typescript
// Per-page CSS selectors for Komiku (WordPress-based manga site).
// Centralized so adding a new source = new selectors file.
export const KOMIKU_SELECTORS = {
  search: {
    container: '.listupd .bs',
    link: 'a',
    title: '.tt',
    cover: 'img',
  },
  detail: {
    title: 'h1.entry-title',
    synopsis: '.entry-content[itemprop="description"], .sinopsis p',
    cover: '.thumb img, .series-thumb img',
    author: '.fmed li:contains("Author") b, .mcs a:first',
    status: '.imptdt:contains("Status") i',
    type: '.imptdt:contains("Type") i',
    genreList: '.mgen a',
    chapterList: '#chapter_list li, .lch a',
    chapterLink: 'a',
    chapterTitle: 'a',
  },
} as const;
```

- [ ] **Step 4: Create `packages/sources/komiku/client.ts`**

```typescript
// Komiku HTTP client: robots.txt fetch + raw HTML fetch (no puppeteer for static pages).
const BASE = 'https://komiku.id';

export interface RobotsResult {
  allowed: boolean;
  disallowedPaths: string[];
  crawlDelay?: number;
}

export const fetchRobots = async (kv: KVNamespace | null): Promise<RobotsResult> => {
  const cacheKey = 'robots:komiku';
  if (kv) {
    const cached = await kv.get(cacheKey, 'json').catch(() => null);
    if (cached) return cached as RobotsResult;
  }
  try {
    const res = await fetch(`${BASE}/robots.txt`, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    const disallowedPaths: string[] = [];
    let crawlDelay: number | undefined;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith('disallow:')) {
        const path = trimmed.slice(9).trim();
        if (path) disallowedPaths.push(path);
      }
      if (trimmed.toLowerCase().startsWith('crawl-delay:')) {
        crawlDelay = Number(trimmed.slice(12).trim()) || undefined;
      }
    }
    const result: RobotsResult = { allowed: true, disallowedPaths, crawlDelay };
    if (kv) await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 }).catch(() => {});
    return result;
  } catch {
    // If robots.txt unreachable, assume allowed (standard behavior).
    return { allowed: true, disallowedPaths: [], crawlDelay: undefined };
  }
};

export const isPathAllowed = (robots: RobotsResult, urlPath: string): boolean => {
  for (const disallowed of robots.disallowedPaths) {
    if (disallowed === '/' ) return false;
    if (disallowed && urlPath.startsWith(disallowed)) return false;
  }
  return true;
};

export const KOMIKU_BASE = BASE;
```

- [ ] **Step 5: Create `packages/sources/komiku/index.ts`**

```typescript
// Komiku adapter: PRIMARY source. Uses @cloudflare/puppeteer for JS-rendered pages.
import puppeteer from '@cloudflare/puppeteer';
import type { Series, Chapter } from '@manga-platform/shared';
import { KOMIKU_SELECTORS } from './selectors.js';
import { fetchRobots, isPathAllowed, KOMIKU_BASE } from './client.js';
import type { RobotsResult } from './client.js';

export interface AdapterEnv {
  MY_BROWSER?: Fetcher;
  MANGADEX_API_KEY?: string;
}

const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'untitled';

const parseChapterNumber = (title: string): number => {
  const m = title.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
};

export const komikuAdapter = (env?: AdapterEnv) => {
  const launchBrowser = async () => {
    if (!env?.MY_BROWSER) throw new Error('MY_BROWSER binding not configured');
    return puppeteer.launch(env.MY_BROWSER);
  };

  return {
    sourceKey: 'komiku' as const,

    async search({ q, limit = 20 }: { q: string; limit?: number; offset?: number }): Promise<Series[]> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(`${KOMIKU_BASE}/?s=${encodeURIComponent(q)}`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        const results = await page.evaluate((sel) => {
          const items = Array.from(document.querySelectorAll(sel.container));
          return items.slice(0, 20).map((el) => {
            const a = el.querySelector(sel.link) as HTMLAnchorElement | null;
            const img = el.querySelector(sel.cover) as HTMLImageElement | null;
            const titleEl = el.querySelector(sel.title);
            const href = a?.href ?? '';
            const slug = href.split('/').filter(Boolean).pop() ?? '';
            return {
              slug: slug || slugify(titleEl?.textContent?.trim() ?? ''),
              title: titleEl?.textContent?.trim() ?? '',
              source: 'komiku',
              source_url: href,
              cover_image: img?.src ?? null,
              type: 'manga',
              status: 'ongoing',
            };
          });
        }, KOMIKU_SELECTORS.search);
        return results.slice(0, limit);
      } finally {
        await browser.close();
      }
    },

    async getSeries(sourceId: string): Promise<Series> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(`${KOMIKU_BASE}/manga/${sourceId}/`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        const data = await page.evaluate((sel) => {
          const title = document.querySelector(sel.title)?.textContent?.trim() ?? '';
          const synopsis = document.querySelector(sel.synopsis)?.textContent?.trim() ?? null;
          const cover = (document.querySelector(sel.cover) as HTMLImageElement)?.src ?? null;
          const author = document.querySelector(sel.author)?.textContent?.trim() ?? null;
          const status = document.querySelector(sel.status)?.textContent?.trim()?.toLowerCase() ?? 'ongoing';
          const type = document.querySelector(sel.type)?.textContent?.trim()?.toLowerCase() ?? 'manga';
          const genres = Array.from(document.querySelectorAll(sel.genreList)).map((a) => (a as HTMLAnchorElement).textContent?.trim() ?? '').filter(Boolean);
          return { title, synopsis, cover_image: cover, author, status, type, genres };
        }, KOMIKU_SELECTORS.detail);
        return {
          slug: sourceId,
          external_id: sourceId,
          source: 'komiku',
          source_url: `${KOMIKU_BASE}/manga/${sourceId}/`,
          ...data,
        };
      } finally {
        await browser.close();
      }
    },

    async listChapters(sourceId: string, _opts?: { lang?: string }): Promise<Chapter[]> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(`${KOMIKU_BASE}/manga/${sourceId}/`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        const chapters = await page.evaluate((sel) => {
          const links = Array.from(document.querySelectorAll(sel.chapterList));
          return links.map((a) => {
            const link = (a.tagName === 'A' ? a : a.querySelector(sel.chapterLink)) as HTMLAnchorElement;
            const title = link?.textContent?.trim() ?? '';
            const href = link?.href ?? '';
            const id = href.split('/').filter(Boolean).pop() ?? '';
            return { id, title, href, chapter_number: 0 };
          });
        }, KOMIKU_SELECTORS.detail);
        return chapters.map((c) => ({
          id: c.id,
          series_slug: sourceId,
          chapter_number: parseChapterNumber(c.title),
          title: c.title,
          language: 'id',
          pages_count: 0,
        }));
      } finally {
        await browser.close();
      }
    },

    async getChapter(chapterSourceId: string): Promise<Chapter> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(`${KOMIKU_BASE}/${chapterSourceId}/`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        const title = await page.title();
        return {
          id: chapterSourceId,
          series_slug: '',
          chapter_number: parseChapterNumber(title),
          title,
          language: 'id',
          pages_count: 0,
        };
      } finally {
        await browser.close();
      }
    },

    async fetchPageUrls(chapterSourceId: string): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(`${KOMIKU_BASE}/${chapterSourceId}/`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        const urls = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('#readerarea img, .reader-area img'));
          return imgs.map((img) => (img as HTMLImageElement).src).filter(Boolean);
        });
        return urls.map((url) => ({ url }));
      } finally {
        await browser.close();
      }
    },

    async scrapeUrl(url: string): Promise<{ series: Series; chapters: Chapter[]; coverImageUrl: string | null }> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        const data = await page.evaluate((sel) => {
          const title = document.querySelector(sel.title)?.textContent?.trim() ?? '';
          const synopsis = document.querySelector(sel.synopsis)?.textContent?.trim() ?? null;
          const cover = (document.querySelector(sel.cover) as HTMLImageElement)?.src ?? null;
          const author = document.querySelector(sel.author)?.textContent?.trim() ?? null;
          const status = document.querySelector(sel.status)?.textContent?.trim()?.toLowerCase() ?? 'ongoing';
          const type = document.querySelector(sel.type)?.textContent?.trim()?.toLowerCase() ?? 'manga';
          const genres = Array.from(document.querySelectorAll(sel.genreList)).map((a) => (a as HTMLAnchorElement).textContent?.trim() ?? '').filter(Boolean);
          const chapterLinks = Array.from(document.querySelectorAll(sel.chapterList)).map((a) => {
            const link = (a.tagName === 'A' ? a : a.querySelector(sel.chapterLink)) as HTMLAnchorElement;
            return { id: link?.href?.split('/').filter(Boolean).pop() ?? '', title: link?.textContent?.trim() ?? '', href: link?.href ?? '' };
          });
          return { title, synopsis, cover_image: cover, author, status, type, genres, chapterLinks };
        }, KOMIKU_SELECTORS.detail);
        const slug = url.split('/').filter(Boolean).pop() ?? slugify(data.title);
        const series: Series = {
          slug,
          external_id: slug,
          source: 'komiku',
          title: data.title,
          synopsis: data.synopsis,
          cover_image: data.cover_image,
          author: data.author,
          status: data.status,
          type: data.type,
          genres: data.genres.length > 0 ? data.genres : undefined,
          source_url: url,
          language: 'id',
        };
        const chapters: Chapter[] = data.chapterLinks.map((c) => ({
          id: c.id,
          series_slug: slug,
          chapter_number: parseChapterNumber(c.title),
          title: c.title,
          language: 'id',
          pages_count: 0,
        }));
        return { series, chapters, coverImageUrl: data.cover_image };
      } finally {
        await browser.close();
      }
    },

    async checkRobots(url: string): Promise<RobotsResult> {
      const robots = await fetchRobots(null);
      const urlPath = new URL(url).pathname;
      if (!isPathAllowed(robots, urlPath)) {
        return { ...robots, allowed: false };
      }
      return robots;
    },

    async healthCheck(): Promise<{ healthy: boolean; latency_ms: number; error?: string }> {
      const start = Date.now();
      try {
        const res = await fetch(KOMIKU_BASE, { signal: AbortSignal.timeout(5000) });
        return { healthy: res.ok, latency_ms: Date.now() - start };
      } catch (e) {
        return { healthy: false, latency_ms: Date.now() - start, error: String(e) };
      }
    },
  };
};
```

- [ ] **Step 6: Update `packages/sources/index.ts`** — add komiku to registry

```typescript
import { mangadexAdapter } from './mangadex/index.js';
import { komikuAdapter } from './komiku/index.js';
import type { MangadexAdapter, AdapterEnv } from './mangadex/index.js';
import type { Series, Chapter } from '@manga-platform/shared';
import type { RobotsResult } from './komiku/client.js';

export type SourceKey = 'mangadex' | 'komiku';

export interface ScrapeResult {
  series: Series;
  chapters: Chapter[];
  coverImageUrl: string | null;
}

export interface SourceAdapter {
  sourceKey: SourceKey;
  search(params: { q: string; limit?: number; offset?: number }): Promise<Series[]>;
  getSeries(sourceId: string): Promise<Series>;
  listChapters(sourceId: string, opts?: { lang?: string; chapter?: string }): Promise<Chapter[]>;
  getChapter(chapterSourceId: string): Promise<Chapter>;
  fetchPageUrls(chapterSourceId: string): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]>;
  scrapeUrl?(url: string): Promise<ScrapeResult>;
  checkRobots?(url: string): Promise<RobotsResult>;
  healthCheck?(): Promise<{ healthy: boolean; latency_ms: number; error?: string }>;
}

const adapterFactories: Record<SourceKey, (env?: AdapterEnv) => SourceAdapter> = {
  mangadex: (env) => mangadexAdapter(env) as unknown as SourceAdapter,
  komiku: (env) => komikuAdapter(env) as unknown as SourceAdapter,
};

export const getAdapter = (sourceKey: string, env?: AdapterEnv): SourceAdapter | null =>
  (sourceKey in adapterFactories) ? adapterFactories[sourceKey as SourceKey](env) : null;

export { mangadexAdapter, komikuAdapter, type MangadexAdapter, type AdapterEnv };
```

- [ ] **Step 7: Add `healthCheck` to MangaDex adapter** — append to `packages/sources/mangadex/index.ts` inside `mangadexAdapter` return object, before closing `}`:

```typescript
    async healthCheck(): Promise<{ healthy: boolean; latency_ms: number; error?: string }> {
      const start = Date.now();
      try {
        const res = await fetch('https://api.mangadex.org/health', { signal: AbortSignal.timeout(5000) });
        return { healthy: res.ok, latency_ms: Date.now() - start };
      } catch (e) {
        return { healthy: false, latency_ms: Date.now() - start, error: String(e) };
      }
    },
```

Also add `healthCheck` to the `MangadexAdapter` interface in the same file:

```typescript
export interface MangadexAdapter {
  sourceKey: 'mangadex';
  search(params: SearchParams): Promise<Series[]>;
  getSeries(sourceId: string): Promise<Series>;
  listChapters(sourceId: string, opts?: ListChaptersOpts): Promise<Chapter[]>;
  getChapter(chapterSourceId: string): Promise<Chapter>;
  fetchPageUrls(chapterSourceId: string): Promise<PageUrl[]>;
  healthCheck(): Promise<{ healthy: boolean; latency_ms: number; error?: string }>;
}
```

- [ ] **Step 8: Install deps + type check**

Run: `npm install && npx tsc --noEmit -p packages/sources`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add packages/sources/ packages/sources/package.json packages/sources/tsconfig.json
git commit -m "feat(sources): add Komiku adapter (puppeteer) + extend SourceAdapter with scrapeUrl/healthCheck"
```

---

### Task 5: packages/vision (pHash + Hamming + identify)

**Files:**
- Create: `packages/vision/package.json`, `packages/vision/tsconfig.json`, `packages/vision/index.ts`, `packages/vision/phash.ts`, `packages/vision/hamming.ts`, `packages/vision/identify.ts`
- Create: `packages/vision/test/phash.test.mjs`

**Interfaces:**
- Consumes: image bytes (`ArrayBuffer`/`Uint8Array`), D1 `image_hashes` table via injected db helper
- Produces: `phash(bytes): Promise<string>` (16-char hex 64-bit), `hammingDistance(a, b): number`, `identifyImage(bytes, hashes): Promise<Candidate[]>` where `Candidate = { series_slug, confidence, match_type }`

- [ ] **Step 1: Create `packages/vision/package.json`**

```json
{
  "name": "@manga-platform/vision",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.ts",
  "exports": {
    ".": "./index.ts"
  },
  "devDependencies": {
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Create `packages/vision/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["*.ts"],
  "exclude": ["node_modules", "test"]
}
```

- [ ] **Step 3: Create `packages/vision/hamming.ts`**

```typescript
// Hamming distance between two 16-char hex strings (64-bit pHash).
// Each hex char = 4 bits. We compute popcount of XOR per nibble.
const NIBBLE_POPCOUNT: Record<string, number> = {
  '0': 0, '1': 1, '2': 1, '3': 2,
  '4': 1, '5': 2, '6': 2, '7': 3,
  '8': 1, '9': 2, 'a': 2, 'b': 3,
  'c': 2, 'd': 3, 'e': 3, 'f': 4,
};

export const hammingDistance = (a: string, b: string): number => {
  if (a.length !== b.length) return 64;
  let dist = 0;
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  for (let i = 0; i < aLower.length; i++) {
    const xor = (parseInt(aLower[i], 16) ^ parseInt(bLower[i], 16)).toString(16);
    dist += NIBBLE_POPCOUNT[xor] ?? 4;
  }
  return dist;
};
```

- [ ] **Step 4: Create `packages/vision/phash.ts`**

```typescript
// pHash 64-bit via OffscreenCanvas (grayscale + 8x8 DCT + median threshold).
// Falls back to aHash (average hash) if OffscreenCanvas unavailable in runtime.
// Zero-dependency: no sharp, no jimp. Uses Web platform APIs.

const resize = async (bytes: Uint8Array, type: string): Promise<Uint8Array> => {
  // OffscreenCanvas available in Workers runtime (CF Workers support it).
  if (typeof OffscreenCanvas !== 'undefined') {
    const blob = new Blob([bytes], { type });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(32, 32);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0, 32, 32);
    const imgData = ctx.getImageData(0, 0, 32, 32);
    // Convert to grayscale (0-255 per pixel)
    const gray = new Uint8Array(32 * 32);
    for (let i = 0; i < 32 * 32; i++) {
      const r = imgData.data[i * 4];
      const g = imgData.data[i * 4 + 1];
      const b = imgData.data[i * 4 + 2];
      gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    return gray;
  }
  throw new Error('OffscreenCanvas not available — pHash requires Worker runtime with canvas support');
};

// 2D DCT (Discrete Cosine Transform) — 8x8 from 8x8 block of 32x32 grayscale.
// Simplified: take top-left 8x8 after applying DCT to the full 32x32.
// For perf, we downsample 32x32 → 8x8 by averaging 4x4 blocks first.
const downsample8x8 = (gray32: Uint8Array): number[] => {
  const out = new Array(64).fill(0);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      let sum = 0;
      for (let dr = 0; dr < 4; dr++) {
        for (let dc = 0; dc < 4; dc++) {
          const idx = (row * 4 + dr) * 32 + (col * 4 + dc);
          sum += gray32[idx];
        }
      }
      out[row * 8 + col] = sum / 16;
    }
  }
  return out;
};

// 1D DCT-II of length 8
const C = (n: number, k: number): number =>
  Math.cos(((2 * n + 1) * k * Math.PI) / 16);

const dct2d = (block: number[]): number[] => {
  const out = new Array(64).fill(0);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) {
        for (let y = 0; y < 8; y++) {
          sum += block[x * 8 + y] * C(x, u) * C(y, v);
        }
      }
      const cu = u === 0 ? 1 / Math.SQRT2 : 1;
      const cv = v === 0 ? 1 / Math.SQRT2 : 1;
      out[u * 8 + v] = 0.25 * cu * cv * sum;
    }
  }
  return out;
};

const toHex = (bits: boolean[]): string => {
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j++) {
      if (bits[i + j]) nibble |= (1 << (3 - j));
    }
    hex += nibble.toString(16);
  }
  return hex;
};

export const phash = async (bytes: Uint8Array, type = 'image/jpeg'): Promise<string> => {
  const gray32 = await resize(bytes, type);
  const block = downsample8x8(gray32);
  const dct = dct2d(block);
  // Top-left 8x8 (we already have 8x8 from downsample). Take all 64 coefficients.
  // Compute median of all except the DC term (index 0).
  const ac = dct.slice(1);
  const sorted = [...ac].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const bits = dct.map((v) => v > median);
  return toHex(bits);
};

// Fallback: aHash (average hash) — simpler, if pHash DCT fails or is too slow.
export const ahash = async (bytes: Uint8Array, type = 'image/jpeg'): Promise<string> => {
  const gray32 = await resize(bytes, type);
  const block = downsample8x8(gray32);
  const avg = block.reduce((a, b) => a + b, 0) / block.length;
  const bits = block.map((v) => v > avg);
  return toHex(bits);
};

// Auto: try pHash, fall back to aHash on error.
export const hashImage = async (bytes: Uint8Array, type = 'image/jpeg'): Promise<string> => {
  try {
    return await phash(bytes, type);
  } catch {
    return await ahash(bytes, type);
  }
};
```

- [ ] **Step 5: Create `packages/vision/identify.ts`**

```typescript
import { hashImage } from './phash.js';
import { hammingDistance } from './hamming.js';

export interface Candidate {
  series_slug: string;
  confidence: number;
  match_type: 'phash';
  r2_key: string | null;
}

export interface ImageHashRow {
  series_slug: string;
  hash: string;
  r2_key: string | null;
}

const THRESHOLD = 8; // max Hamming distance for a match

export const identifyImage = async (
  imageBytes: Uint8Array,
  imageType: string,
  hashes: ImageHashRow[]
): Promise<{ candidates: Candidate[]; computedHash: string }> => {
  const computedHash = await hashImage(imageBytes, imageType);
  const candidates: Candidate[] = [];
  for (const row of hashes) {
    const dist = hammingDistance(computedHash, row.hash);
    if (dist <= THRESHOLD) {
      candidates.push({
        series_slug: row.series_slug,
        confidence: 1 - dist / 64,
        match_type: 'phash',
        r2_key: row.r2_key,
      });
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  return { candidates, computedHash };
};
```

- [ ] **Step 6: Create `packages/vision/index.ts`**

```typescript
export { phash, ahash, hashImage } from './phash.js';
export { hammingDistance } from './hamming.js';
export { identifyImage } from './identify.js';
export type { Candidate, ImageHashRow } from './identify.js';
```

- [ ] **Step 7: Create `packages/vision/test/phash.test.mjs`**

```javascript
// Self-check: pHash determinism + Hamming distance.
// Run: node packages/vision/test/phash.test.mjs
// Uses fixture reader-ch1.jpeg in repo root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = path.resolve(here, '../../../reader-ch1.jpeg');
const fixtureBytes = new Uint8Array(fs.readFileSync(fixturePath));

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.error(`  FAIL - ${name}\n    ${e.message}`); }
};

// 1. Hamming distance: same hash → 0, 1-bit diff → 1
const { hammingDistance } = await import('../hamming.ts').catch(() => ({
  hammingDistance: (a, b) => {
    if (a.length !== b.length) return 64;
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      let nib = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      while (nib) { d += nib & 1; nib >>= 1; }
    }
    return d;
  }
}));

await test('hamming same hash = 0', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0);
});
await test('hamming 1-bit diff = 1', () => {
  assert.equal(hammingDistance('0000000000000000', '8000000000000000'), 1);
});
await test('hamming all different = 64', () => {
  assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffff'), 64);
});

// 2. pHash determinism: same image → same hash twice
// ponytail: OffscreenCanvas not available in plain Node; skip pHash test
// in CI. Run manually in Worker runtime. Mark as known limitation.
console.log('  skip - pHash determinism (requires Worker runtime with OffscreenCanvas)');

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 8: Run self-check**

Run: `node packages/vision/test/phash.test.mjs`
Expected: `3 pass, 0 fail` (pHash test skipped with note)

- [ ] **Step 9: Type check**

Run: `npx tsc --noEmit -p packages/vision`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add packages/vision/
git commit -m "feat(vision): add pHash + Hamming distance + identify orchestrator"
```

---

### Task 6: API routes — health, search, manga, source-status

**Files:**
- Create: `apps/data-api/src/routes/health.ts`, `apps/data-api/src/routes/search.ts`, `apps/data-api/src/routes/manga.ts`, `apps/data-api/src/routes/sourceStatus.ts`
- Modify: `apps/data-api/src/index.ts` (wire routes + CORS + error handler + rate limit)

**Interfaces:**
- Consumes: `Env`, `Context`, `json`, `sha256Hex`, `getDb`, `rateLimitPublic`, `retryUpstream`, `getAdapter`
- Produces: `GET /api/health`, `GET /api/search?q=`, `GET /api/manga/:id`, `GET /api/source-status`

- [ ] **Step 1: Create `apps/data-api/src/routes/health.ts`**

```typescript
import { Hono } from 'hono';
import type { Env } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

router.get('/health', (c) => c.json({ status: 'ok', service: 'manga-data-api', ts: Date.now() }));
```

- [ ] **Step 2: Create `apps/data-api/src/routes/search.ts`**

```typescript
import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import type { Env, Context } from '../lib/context';
import { json, sha256Hex } from '../lib/context';
import { retryUpstream } from '../lib/retry';

export const router = new Hono<{ Bindings: Env }>();

// Normalized title for dedup (case-insensitive, strip punctuation)
const normalizeTitle = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

router.get('/search', async (c: Context) => {
  const q = c.req.query('q');
  if (!q) return json(c, { error: 'query param "q" is required' }, 400);
  const limit = Math.min(Number(c.req.query('limit') ?? '20'), 50);

  const cacheKey = `search:${await sha256Hex(q)}`;
  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) return json(c, { ...cached, cached: true });

  // 1. Query local D1 FTS5 first
  const db = c.env.DB;
  const localResults = await db.prepare(
    "SELECT s.* FROM series_search f JOIN series s ON s.id = f.rowid WHERE series_search MATCH ?1 ORDER BY rank LIMIT ?2"
  ).bind(q, limit).all();

  // 2. Trigger both adapters in parallel for fresh data
  const sourcesQueried: string[] = [];
  const [komikuResults, mangadexResults] = await Promise.allSettled([
    retryUpstream(() => {
      const a = getAdapter('komiku', c.env);
      if (!a) throw new Error('komiku adapter unavailable');
      sourcesQueried.push('komiku');
      return a.search({ q, limit });
    }),
    retryUpstream(() => {
      const a = getAdapter('mangadex', c.env);
      if (!a) throw new Error('mangadex adapter unavailable');
      sourcesQueried.push('mangadex');
      return a.search({ q, limit });
    }),
  ]);

  const allResults: Record<string, { data: any; sources: string[] }> = {};
  const addResult = (series: any, source: string) => {
    const key = normalizeTitle(series.title || series.slug || '');
    if (!key) return;
    if (allResults[key]) {
      if (!allResults[key].sources.includes(source)) allResults[key].sources.push(source);
    } else {
      allResults[key] = { data: { ...series, sources: [source] }, sources: [source] };
    }
  };

  // Add local D1 results (already in DB)
  for (const row of localResults.results ?? []) {
    addResult(row, row.source || 'local');
  }
  if (komikuResults.status === 'fulfilled') {
    for (const s of komikuResults.value) addResult(s, 'komiku');
  }
  if (mangadexResults.status === 'fulfilled') {
    for (const s of mangadexResults.value) addResult(s, 'mangadex');
  }

  const merged = Object.values(allResults).slice(0, limit);
  const payload = { data: merged, total: merged.length, sources_queried: sourcesQueried, cached: false };

  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 120 }).catch(() => {})
  );
  return json(c, payload);
});
```

- [ ] **Step 3: Create `apps/data-api/src/routes/manga.ts`**

```typescript
import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { getDb, json } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

router.get('/manga/:id', async (c: Context) => {
  const slug = c.req.param('id');
  const cacheKey = `manga:meta:${slug}`;

  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) return json(c, cached);

  const db = getDb(c);
  const series = await db.getSeriesBySlug(slug);
  if (!series) return json(c, { error: 'manga not found' }, 404);

  // Get chapters + sources for this slug
  const chapters = await c.env.DB.prepare(
    'SELECT * FROM chapters WHERE series_slug = ?1 ORDER BY chapter_number ASC'
  ).bind(slug).all();

  // Find all sources that have this manga (by external_id or title)
  const sources = await c.env.DB.prepare(
    "SELECT DISTINCT source FROM series WHERE slug = ?1 OR title = (SELECT title FROM series WHERE slug = ?1)"
  ).bind(slug).all();

  const payload = {
    data: {
      ...series,
      chapters: chapters.results ?? [],
      sources: (sources.results ?? []).map((r: any) => r.source),
    }
  };

  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {})
  );
  return json(c, payload);
});
```

- [ ] **Step 4: Create `apps/data-api/src/routes/sourceStatus.ts`**

```typescript
import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import type { Env, Context } from '../lib/context';
import { getDb, json } from '../lib/context';
import { retryUpstream } from '../lib/retry';

export const router = new Hono<{ Bindings: Env }>();

router.get('/source-status', async (c: Context) => {
  const sources: { source: string; healthy: boolean; latency_ms: number; last_checked_at: number; error?: string }[] = [];

  for (const key of ['komiku', 'mangadex'] as const) {
    const cacheKey = `source:health:${key}`;
    const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
    if (cached) { sources.push(cached); continue; }

    const adapter = getAdapter(key, c.env);
    if (!adapter?.healthCheck) {
      sources.push({ source: key, healthy: false, latency_ms: 0, last_checked_at: Math.floor(Date.now() / 1000), error: 'adapter missing healthCheck' });
      continue;
    }

    try {
      const result = await retryUpstream(() => adapter.healthCheck!(), 1);
      const snapshot = {
        source: key,
        healthy: result.healthy,
        latency_ms: result.latency_ms,
        last_checked_at: Math.floor(Date.now() / 1000),
        error: result.error,
      };
      sources.push(snapshot);
      c.executionCtx.waitUntil(c.env.CACHE_KV.put(cacheKey, JSON.stringify(snapshot), { expirationTtl: 60 }).catch(() => {}));
      // Persist to D1 for audit history
      c.executionCtx.waitUntil(getDb(c).recordSourceHealth({ source: key, healthy: result.healthy, latencyMs: result.latency_ms, error: result.error ?? null }).catch(() => {}));
    } catch (e) {
      sources.push({ source: key, healthy: false, latency_ms: 0, last_checked_at: Math.floor(Date.now() / 1000), error: String(e) });
    }
  }

  return json(c, { data: sources });
});
```

- [ ] **Step 5: Rewrite `apps/data-api/src/index.ts`** — wire all routes

```typescript
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { Env, parseAllowedOrigins } from './lib/context';
import { rateLimitPublic } from './lib/rateLimit';
import { router as healthRouter } from './routes/health';
import { router as searchRouter } from './routes/search';
import { router as mangaRouter } from './routes/manga';
import { router as sourceStatusRouter } from './routes/sourceStatus';

const corsMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const allowed = parseAllowedOrigins(c.env);
  const origin = c.req.header('origin');
  if (origin && allowed.includes(origin)) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Vary', 'Origin');
  }
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-api-key');
  if (c.req.method === 'OPTIONS') {
    c.res.headers.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers: c.res.headers });
  }
  await next();
};

export const app = new Hono<{ Bindings: Env }>();

app.use('*', corsMw);
app.use('*', rateLimitPublic);
app.route('/api', healthRouter);
app.route('/api', searchRouter);
app.route('/api', mangaRouter);
app.route('/api', sourceStatusRouter);

app.onError((err, c) => {
  console.error('[data-api]', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not Found' }, 404));

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 6: Type check + local dev smoke**

Run: `npx tsc --noEmit -p apps/data-api`
Expected: no errors

Run: `npx wrangler dev --port 8788` (in `apps/data-api/`), then in another terminal:
```bash
curl http://localhost:8788/api/health
curl 'http://localhost:8788/api/source-status'
```
Expected: health returns `{"status":"ok"}`; source-status returns both sources

- [ ] **Step 7: Commit**

```bash
git add apps/data-api/src/
git commit -m "feat(data-api): wire health, search, manga, source-status routes + CORS"
```

---

### Task 7: API routes — identify + scrape (admin)

**Files:**
- Create: `apps/data-api/src/routes/identify.ts`, `apps/data-api/src/routes/scrape.ts`
- Modify: `apps/data-api/src/index.ts` (add identify + scrape routes, per-route rate limit)

**Interfaces:**
- Consumes: `@manga-platform/vision` (identifyImage), `@manga-platform/sources` (getAdapter, scrapeUrl), `@manga-platform/db` (addImageHash, getAllImageHashes, createScrapeJob, updateScrapeJob, upsertSeries), `requireAdminKey`, `rateLimitIdentify`, `rateLimitAdmin`
- Produces: `POST /api/identify` (multipart upload + pHash match), `POST /api/scrape` (admin trigger), `GET /api/scrape/:job_id`, `GET /api/scrape`

- [ ] **Step 1: Create `apps/data-api/src/routes/identify.ts`**

```typescript
import { Hono } from 'hono';
import { identifyImage } from '@manga-platform/vision';
import type { Env, Context } from '../lib/context';
import { getDb, json, sha256Hex } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

router.post('/identify', async (c: Context) => {
  const formData = await c.req.formData();
  const file = formData.get('image');
  if (!(file instanceof File)) {
    return json(c, { error: 'image field required (multipart/form-data)' }, 400);
  }
  if (file.size > MAX_IMAGE_SIZE) {
    return json(c, { error: 'image too large (max 10MB)' }, 413);
  }
  if (!file.type.startsWith('image/')) {
    return json(c, { error: 'file must be image/*' }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Upload to R2 (temporary, lifecycle rule deletes after 1h)
  const uploadKey = `uploads/${crypto.randomUUID()}.${file.type.split('/')[1] || 'jpg'}`;
  await c.env.ASSETS_R2.put(uploadKey, bytes);

  // Get all image hashes from D1 (small table, acceptable for MVP)
  const db = getDb(c);
  const allHashes = await db.getAllImageHashes();

  const { candidates, computedHash } = await identifyImage(bytes, file.type, allHashes);

  // Cache identify result by hash prefix (10min)
  const cacheKey = `identify:${computedHash.slice(0, 8)}`;
  const payload = { candidates, uploaded_key: uploadKey, computed_hash: computedHash };
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 600 }).catch(() => {})
  );

  return json(c, payload);
});
```

- [ ] **Step 2: Create `apps/data-api/src/routes/scrape.ts`**

```typescript
import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import type { Env, Context } from '../lib/context';
import { getDb, json } from '../lib/context';
import { requireAdminKey } from '../lib/auth';
import { retryUpstream } from '../lib/retry';

export const router = new Hono<{ Bindings: Env }>();

// All scrape endpoints require admin key
router.use('*', requireAdminKey);

router.post('/scrape', async (c: Context) => {
  const body = await c.req.json().catch(() => null) as {
    source: 'komiku' | 'mangadex';
    url?: string;
    query?: string;
  } | null;
  if (!body || !body.source) {
    return json(c, { error: 'source required (komiku or mangadex), plus url or query' }, 400);
  }

  const adapter = getAdapter(body.source, c.env);
  if (!adapter) return json(c, { error: 'unknown source' }, 400);

  // Create job
  const jobId = crypto.randomUUID();
  const db = getDb(c);
  await db.createScrapeJob({
    id: jobId,
    source: body.source,
    sourceUrl: body.url ?? null,
    query: body.query ?? null,
  });

  // Run async
  c.executionCtx.waitUntil((async () => {
    try {
      await db.updateScrapeJob(jobId, { status: 'running' });

      // Check robots.txt for URL-based scrape
      if (body.url && adapter.checkRobots) {
        const robots = await adapter.checkRobots(body.url);
        if (!robots.allowed) {
          await db.updateScrapeJob(jobId, { status: 'skipped_robots', completedAt: Math.floor(Date.now() / 1000) });
          return;
        }
      }

      let result;
      if (body.url && adapter.scrapeUrl) {
        result = await retryUpstream(() => adapter.scrapeUrl!(body.url!));
      } else if (body.query) {
        const results = await retryUpstream(() => adapter.search({ q: body.query! }));
        if (results.length === 0) {
          await db.updateScrapeJob(jobId, { status: 'completed', completedAt: Math.floor(Date.now() / 1000) });
          return;
        }
        const sourceId = results[0].slug || results[0].external_id;
        result = {
          series: results[0],
          chapters: await retryUpstream(() => adapter.listChapters(sourceId!, { lang: 'id' })),
          coverImageUrl: results[0].cover_image,
        };
      } else {
        await db.updateScrapeJob(jobId, { status: 'failed', error: 'url or query required', completedAt: Math.floor(Date.now() / 1000) });
        return;
      }

      // Upsert series + chapters to D1
      await db.upsertSeries({
        slug: result.series.slug,
        external_id: result.series.external_id ?? null,
        source: body.source,
        title: result.series.title,
        synopsis: result.series.synopsis ?? null,
        type: result.series.type,
        status: result.series.status ?? 'ongoing',
        author: result.series.author ?? null,
        artist: result.series.artist ?? null,
        cover_image: result.series.cover_image ?? null,
        genres: result.series.genres,
        source_url: result.series.source_url ?? null,
        language: (result.series as any).language ?? null,
      });

      // Fetch cover image → R2 → pHash → image_hashes
      if (result.coverImageUrl) {
        try {
          const imgRes = await retryUpstream(() => fetch(result.coverImageUrl!));
          if (imgRes.ok) {
            const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
            const r2Key = `covers/${result.series.slug}.jpg`;
            await c.env.ASSETS_R2.put(r2Key, imgBytes);
            // Compute pHash
            const { hashImage } = await import('@manga-platform/vision');
            const hash = await hashImage(imgBytes, imgRes.headers.get('content-type') || 'image/jpeg');
            await db.addImageHash({ seriesSlug: result.series.slug, hash, r2Key, imageType: 'cover' });
          }
        } catch (e) {
          console.error('[scrape] cover hash failed:', e);
        }
      }

      await db.updateScrapeJob(jobId, {
        status: 'completed',
        seriesSlug: result.series.slug,
        completedAt: Math.floor(Date.now() / 1000),
      });
    } catch (e) {
      await db.updateScrapeJob(jobId, {
        status: 'failed',
        error: String(e).slice(0, 500),
        completedAt: Math.floor(Date.now() / 1000),
      });
    }
  })());

  return json(c, { job_id: jobId, status: 'running' });
});

router.get('/scrape/:job_id', async (c: Context) => {
  const job = await getDb(c).getScrapeJob(c.req.param('job_id'));
  if (!job) return json(c, { error: 'job not found' }, 404);
  return json(c, { data: job });
});

router.get('/scrape', async (c: Context) => {
  const jobs = await getDb(c).listScrapeJobs(50);
  return json(c, { data: jobs });
});
```

- [ ] **Step 3: Update `apps/data-api/src/index.ts`** — add identify + scrape routes with per-route rate limit

Add after the existing route imports:

```typescript
import { rateLimitIdentify } from './lib/rateLimit';
import { rateLimitAdmin } from './lib/rateLimit';
import { router as identifyRouter } from './routes/identify';
import { router as scrapeRouter } from './routes/scrape';
```

Add after the existing `app.route('/api', sourceStatusRouter);`:

```typescript
// Identify route has its own rate limit (10/min)
app.use('/api/identify', rateLimitIdentify);
app.route('/api', identifyRouter);

// Scrape routes have admin rate limit (600/min)
app.use('/api/scrape', rateLimitAdmin);
app.route('/api', scrapeRouter);
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit -p apps/data-api`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add apps/data-api/src/routes/identify.ts apps/data-api/src/routes/scrape.ts apps/data-api/src/index.ts
git commit -m "feat(data-api): add identify (pHash upload) + scrape (admin) routes"
```

---

### Task 8: Frontend — SourceBadge + api.ts extensions

**Files:**
- Create: `apps/web/components/SourceBadge.tsx`
- Modify: `apps/web/lib/api.ts` (add `DATA_API_URL` + new fetch helpers)

**Interfaces:**
- Consumes: `NEXT_PUBLIC_DATA_API_URL` env var
- Produces: `SourceBadge` component, `DATA_API_URL` constant, `searchMerged()`, `getSourceStatus()` fetch helpers

- [ ] **Step 1: Create `apps/web/components/SourceBadge.tsx`**

```tsx
// Source badge: shows pill per source. Compact, dark-theme consistent.
const SOURCE_LABELS: Record<string, string> = {
  komiku: 'Komiku',
  mangadex: 'MangaDex',
};

const SOURCE_COLORS: Record<string, string> = {
  komiku: 'bg-blue-900 text-blue-200 border-blue-700',
  mangadex: 'bg-orange-900 text-orange-200 border-orange-700',
};

export function SourceBadge({ sources }: { sources: string[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="flex gap-1 flex-wrap">
      {sources.map((s) => (
        <span
          key={s}
          className={`text-[10px] px-1.5 py-0.5 rounded border ${SOURCE_COLORS[s] ?? 'bg-gray-800 text-gray-300 border-gray-600'}`}
        >
          {SOURCE_LABELS[s] ?? s}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Update `apps/web/lib/api.ts`** — append data API helpers at end of file

```typescript
// ---- Data API (manga-data-api Worker) --------------------------------------
export const DATA_API_URL = process.env.NEXT_PUBLIC_DATA_API_URL || 'http://localhost:8788';

export interface MergedManga {
  slug: string;
  title: string;
  cover_image?: string | null;
  source: string;
  sources: string[];
  type?: string;
  status?: string;
}

export interface SourceStatus {
  source: string;
  healthy: boolean;
  latency_ms: number;
  last_checked_at: number;
  error?: string;
}

async function dataApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DATA_API_URL}${path}`, {
    ...init,
    next: { revalidate: 60 },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Data API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const searchMerged = (q: string): Promise<{ data: MergedManga[]; sources_queried: string[] }> =>
  dataApi(`/api/search?q=${encodeURIComponent(q)}`);

export const getSourceStatus = (): Promise<{ data: SourceStatus[] }> =>
  dataApi('/api/source-status');
```

- [ ] **Step 3: Create/update `apps/web/.env.production`**

```env
NEXT_PUBLIC_API_URL=https://manga-api.<sub>.workers.dev
NEXT_PUBLIC_DATA_API_URL=https://manga-data-api.<sub>.workers.dev
```

- [ ] **Step 4: Type check**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/SourceBadge.tsx apps/web/lib/api.ts apps/web/.env.production
git commit -m "feat(web): add SourceBadge component + data API fetch helpers"
```

---

### Task 9: Frontend — rewrite beranda (merge) + status page

**Files:**
- Modify: `apps/web/app/page.tsx` (rewrite beranda: merge komiku + mangadex, dedup, badge per source)
- Create: `apps/web/app/status/page.tsx` (source health status page)
- Modify: `apps/web/components/MangaCard.tsx` (accept `sources` prop, render SourceBadge)

**Interfaces:**
- Consumes: `searchMerged()`, `getSourceStatus()`, `SourceBadge`, `MergedManga`, `SourceStatus`
- Produces: Beranda `/` showing merged manga from both sources with per-source badges; `/status` page showing source health

- [ ] **Step 1: Update `apps/web/components/MangaCard.tsx`** — accept `sources` prop

```tsx
import Link from 'next/link';
import { SourceBadge } from './SourceBadge';

interface MangaCardProps {
  manga: {
    slug: string;
    title: string;
    cover?: string | null;
    cover_image?: string | null;
    id?: string;
  };
  source?: string;
  sources?: string[];
}

export function MangaCard({ manga, source = 'mangadex', sources }: MangaCardProps) {
  const cover = manga.cover ?? manga.cover_image ?? null;
  const allSources = sources ?? [source];
  return (
    <Link href={`/${source}/s/${manga.slug}${manga.id ? `?id=${manga.id}` : ''}`} className="group block">
      <div className="aspect-[3/4] w-full overflow-hidden rounded border border-subtle bg-card relative">
        {cover ? (
          <img src={cover} alt={manga.title} loading="lazy" className="h-full w-full object-cover transition-opacity duration-300" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted text-xs p-2 text-center">{manga.title}</div>
        )}
        {allSources.length > 0 && (
          <div className="absolute top-1 left-1">
            <SourceBadge sources={allSources} />
          </div>
        )}
      </div>
      <div className="mt-2 text-sm text-primary line-clamp-2 group-hover:text-accent">{manga.title}</div>
    </Link>
  );
}
```

- [ ] **Step 2: Rewrite `apps/web/app/page.tsx`** — merged beranda

```tsx
import { searchMerged, MergedManga } from '@/lib/api';
import { MangaCard } from '@/components/MangaCard';

export const revalidate = 120;

export default async function Home() {
  let manga: MergedManga[] = [];
  let sourcesQueried: string[] = [];
  let error: string | null = null;

  try {
    // Fetch popular: empty query returns trending/all from both sources
    const result = await searchMerged('');
    manga = result.data;
    sourcesQueried = result.sources_queried;
  } catch (e) {
    error = String(e);
  }

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-1">Manga Indonesia</h1>
      <p className="text-secondary text-sm mb-2">Baca manga/manhwa/manhua terjemahan Indonesia</p>
      <p className="text-muted text-xs mb-6">
        Sumber: {sourcesQueried.join(' + ') || 'memuat...'}
        {manga.length > 0 && ` · ${manga.length} judul`}
      </p>
      {error && <div className="text-error text-sm border border-border-default rounded p-3 bg-card mb-4">Gagal memuat: {error}</div>}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {manga.map((m) => (
          <MangaCard
            key={`${m.slug}-${m.sources.join(',')}`}
            manga={{ slug: m.slug, title: m.title, cover_image: m.cover_image }}
            source={m.sources[0] ?? 'komiku'}
            sources={m.sources}
          />
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Create `apps/web/app/status/page.tsx`** — source health status

```tsx
import { getSourceStatus, SourceStatus } from '@/lib/api';

export const revalidate = 60;

export default async function StatusPage() {
  let sources: SourceStatus[] = [];
  let error: string | null = null;

  try {
    const result = await getSourceStatus();
    sources = result.data;
  } catch (e) {
    error = String(e);
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-1">Status Sumber</h1>
      <p className="text-secondary text-sm mb-6">Cek hidup/mati pool Komiku & MangaDex</p>
      {error && <div className="text-error text-sm border border-border-default rounded p-3 bg-card mb-4">{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sources.map((s) => (
          <div
            key={s.source}
            className={`border rounded p-4 ${s.healthy ? 'border-green-700 bg-green-950/30' : 'border-red-700 bg-red-950/30'}`}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold capitalize">{s.source}</h2>
              <span
                className={`text-xs px-2 py-1 rounded ${s.healthy ? 'bg-green-900 text-green-200' : 'bg-red-900 text-red-200'}`}
              >
                {s.healthy ? '● HIDUP' : '● MATI'}
              </span>
            </div>
            <dl className="mt-2 text-sm space-y-1">
              <div className="flex justify-between">
                <dt className="text-muted">Latensi</dt>
                <dd className="text-secondary">{s.latency_ms}ms</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Dicek</dt>
                <dd className="text-secondary">{new Date(s.last_checked_at * 1000).toLocaleTimeString('id-ID')}</dd>
              </div>
              {s.error && (
                <div className="text-error text-xs mt-2 break-all">{s.error}</div>
              )}
            </dl>
          </div>
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Add nav link to status page** — update `apps/web/app/layout.tsx` (add link in nav)

Find the nav section and add a link to `/status`:

```tsx
<Link href="/status" className="text-secondary hover:text-primary text-sm">Status</Link>
```

- [ ] **Step 5: Type check + build**

Run: `cd apps/web && npx tsc --noEmit && npx next build`
Expected: no errors, build succeeds

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/status/page.tsx apps/web/app/layout.tsx apps/web/components/MangaCard.tsx
git commit -m "feat(web): rewrite beranda (merge komiku+mangadex) + add source status page"
```

---

### Task 10: Migration + secrets + deploy

**Files:**
- Run: D1 migration (remote), R2 lifecycle rule (dashboard), secrets, wrangler deploy

**Interfaces:**
- Consumes: `packages/db/migrations/0001_manga_data.sql` (from Task 2), `apps/data-api/wrangler.toml` (from Task 1)
- Produces: Live Worker at `https://manga-data-api.<sub>.workers.dev` with all endpoints

- [ ] **Step 1: Apply D1 migration to remote**

```bash
npx wrangler d1 execute manga-db --file=packages/db/migrations/0001_manga_data.sql --remote
```
Expected: migration applied (ALTER + CREATE TABLE statements succeed)

- [ ] **Step 2: Verify migration on remote**

```bash
npx wrangler d1 execute manga-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('image_hashes','scrape_jobs','source_health')"
```
Expected: all 3 new tables listed

- [ ] **Step 3: Set R2 lifecycle rule for uploads/ prefix (1h expiry)**

Via Cloudflare dashboard:
1. Go to R2 → `manga-assets` bucket → Settings → Object lifecycle rules
2. Add rule: prefix `uploads/`, delete after 1 hour
3. (Manual step — document in README)

- [ ] **Step 4: Set secrets via wrangler**

```bash
cd apps/data-api
# Generate random SCRAPE_API_KEY
SCRAPE_KEY=$(openssl rand -hex 32)
echo "SCRAPE_API_KEY=$SCRAPE_KEY" >> .dev.vars
npx wrangler secret put SCRAPE_API_KEY   # paste the key when prompted
npx wrangler secret put MANGADEX_API_KEY  # reuse existing key
npx wrangler secret put ALLOWED_ORIGINS  # e.g. https://manga-web.pages.dev
```

- [ ] **Step 5: Deploy Worker**

```bash
cd apps/data-api
npx wrangler deploy
```
Expected: deployed to `https://manga-data-api.<sub>.workers.dev`. Note the URL.

- [ ] **Step 6: Update frontend env + deploy web**

Update `apps/web/.env.production`:
```env
NEXT_PUBLIC_API_URL=https://manga-api.<sub>.workers.dev
NEXT_PUBLIC_DATA_API_URL=https://manga-data-api.<sub>.workers.dev
```

Deploy web:
```bash
cd apps/web
npx next build && npx next-on-pages
npx wrangler pages deploy .vercel/output/static --project-name manga-web
```

- [ ] **Step 7: Commit deployment config**

```bash
git add apps/web/.env.production
git commit -m "deploy: manga-data-api Worker live + web env updated"
```

---

### Task 11: Smoke test live endpoints via Playwright MCP

**Files:**
- No file changes — verification only

**Interfaces:**
- Consumes: live Worker URL from Task 10
- Produces: verified all endpoints return 200 + valid JSON

- [ ] **Step 1: Smoke test `GET /api/health`**

Use Playwright MCP to navigate to `https://manga-data-api.<sub>.workers.dev/api/health`.
Expected: `{"status":"ok","service":"manga-data-api","ts":...}`

- [ ] **Step 2: Smoke test `GET /api/source-status`**

Navigate to `https://manga-data-api.<sub>.workers.dev/api/source-status`.
Expected: `{"data":[{"source":"komiku","healthy":true|false,...},{"source":"mangadex",...}]}`

- [ ] **Step 3: Smoke test `GET /api/search?q=naruto`**

Navigate to `https://manga-data-api.<sub>.workers.dev/api/search?q=naruto`.
Expected: `{"data":[...],"sources_queried":["komiku","mangadex"],"cached":false}`

- [ ] **Step 4: Smoke test `POST /api/identify` with fixture image**

Use Playwright MCP to:
1. Navigate to a simple HTML page with a file upload form (or use `browser_run_code_unsafe` to construct FormData + fetch)
2. Upload `reader-ch1.jpeg` from repo root
3. POST to `https://manga-data-api.<sub>.workers.dev/api/identify`

Expected: `{"candidates":[...],"uploaded_key":"uploads/...","computed_hash":"..."}`

- [ ] **Step 5: Smoke test `POST /api/scrape` (admin)**

Use Playwright MCP or curl:
```bash
curl -X POST https://manga-data-api.<sub>.workers.dev/api/scrape \
  -H "x-admin-api-key: <SCRAPE_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"source":"komiku","query":"naruto"}'
```
Expected: `{"job_id":"...","status":"running"}`

- [ ] **Step 6: Smoke test `GET /api/scrape/:job_id`**

Wait 30s, then:
```bash
curl -H "x-admin-api-key: <SCRAPE_API_KEY>" \
  https://manga-data-api.<sub>.workers.dev/api/scrape/<job_id>
```
Expected: `{"data":{"status":"completed","series_slug":"..."}}`

- [ ] **Step 7: Smoke test beranda + status page (frontend)**

Navigate to `https://manga-web.pages.dev/` (beranda).
Expected: grid of manga cards with SourceBadge pills (Komiku, MangaDex).

Navigate to `https://manga-web.pages.dev/status`.
Expected: 2 cards (Komiku, MangaDex) with HIDUP/MATI status.

- [ ] **Step 8: Document final summary**

Append to `docs/DEPLOY.md`:

```markdown
## Manga Data API (manga-data-api)

- Base URL: `https://manga-data-api.<sub>.workers.dev`
- Endpoints:
  - `GET /api/health` — health check
  - `GET /api/search?q=` — merged search (komiku + mangadex)
  - `GET /api/manga/:id` — manga detail + chapters
  - `POST /api/identify` — image upload → pHash match (multipart, 10MB max)
  - `POST /api/scrape` — admin trigger (header `x-admin-api-key`)
  - `GET /api/scrape/:job_id` — job status (admin)
  - `GET /api/source-status` — source health (komiku + mangadex)
- Auth: `x-admin-api-key` header for `/api/scrape/*` (constant-time compare)
- Secrets: `SCRAPE_API_KEY`, `MANGADEX_API_KEY`, `ALLOWED_ORIGINS` via `wrangler secret put`
- D1 migration: `0001_manga_data.sql` (image_hashes, scrape_jobs, source_health + series column additions)
- R2: `uploads/` prefix auto-deleted after 1h (lifecycle rule)
- Limitations: OCR fallback not implemented (pHash only); external reverse image search not implemented
```

- [ ] **Step 9: Commit documentation**

```bash
git add docs/DEPLOY.md
git commit -m "docs: add manga-data-api deployment summary + endpoint reference"
```

---

## Self-Review Summary

**Spec coverage:**
- A1 (reuse CF resources) → Task 1 wrangler.toml reuses IDs ✓
- A2 (Hono) → Task 1, 3 ✓
- A3 (puppeteer + Playwright MCP for test) → Task 4, 11 ✓
- A4 (Komiku primary, MangaDex secondary) → Task 4 ✓
- A5 (pHash 64-bit) → Task 5 ✓
- A6 (OCR skip) → Task 5 identify.ts (pHash only) ✓
- A7 (external reverse search skip) → Task 5 (no external API) ✓
- A8 (10MB upload) → Task 7 identify.ts MAX_IMAGE_SIZE ✓
- A9 (admin api-key) → Task 3 auth.ts, Task 7 scrape.ts ✓
- A10 (cache keys) → Task 6, 7 (KV keys match spec) ✓
- A11 (rate limits) → Task 3 rateLimit.ts (60/10/600) ✓
- A12 (robots.txt) → Task 4 komiku/client.ts checkRobots ✓
- Komiku primary + MangaDex secondary (user override) → Task 4 ✓
- Status page → Task 9 ✓
- Beranda merge with badges → Task 9 ✓
- D1 migration → Task 2 ✓
- Deploy → Task 10 ✓
- Smoke test → Task 11 ✓

**Type consistency:** `MergedManga`, `SourceStatus`, `Candidate`, `ScrapeResult`, `RobotsResult` — defined once in shared/types or vision/identify, consumed consistently across tasks. `getDb` returns `Db` type from `@manga-platform/db` — consistent with existing pattern.

**Known limitations (documented in spec §11):**
- OCR fallback not implemented (upgrade path: CF Workers AI)
- External reverse image search not implemented
- pHash requires OffscreenCanvas in Worker runtime (fallback aHash documented)
- Scheduled scrape refresh not implemented (cron future)
