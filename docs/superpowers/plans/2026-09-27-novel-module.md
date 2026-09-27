# Novel / Light Novel Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/novel` reading module (catalog, series, chapter reader) on the existing platform, with `novelid.org` as the chapter source and two metadata fallback sources, plus a bounded audit of the six existing manga adapters.

**Architecture:** New D1 tables sharded by `murmur3_32(series_id) % N` across the existing four Workers, reusing the owner-forwarding path in `apps/api-cf/src/lib/peers.ts`. Novel adapters are a separate TypeScript interface in `packages/sources/novel.ts`; the existing manga `SourceAdapter` is left byte-identical. Chapter reads are served from D1 and never scrape inline.

**Tech Stack:** Astro (web), Hono (API), Cloudflare Workers + D1 + KV + R2/B2, Turborepo + npm workspaces, `node --test` (api-cf), `bun test` (web), `tsx` (packages).

**Spec:** `docs/superpowers/specs/2026-09-27-novel-module-design.md` — read it before starting. The plan implements it; where they differ, the spec wins and the plan is wrong.

## Global Constraints

- `manga-platform/sources` `SourceAdapter` in `packages/sources/index.ts` must stay byte-identical except for appending novel source keys. Six production adapters depend on it.
- Workers have **no DOMParser**. All HTML parsing is regex/segment based. Never write a CSS selector into a config object.
- `robots.txt` must be respected via the existing `checkRobots` / `isPathAllowed` helpers in each `client.ts`. `novelid.org` allows `/novel/`; do not fetch `/search/`.
- Chapter read path must never perform an upstream fetch. Use `c.executionCtx.waitUntil` for refresh.
- Backoff stays at 3 attempts maximum. `setTimeout` sleep burns Workers CPU (see the `ponytail` note in `apps/api-cf/src/lib/retry.ts`).
- KV writes only when `content_hash` changes. Free tier is 1000 writes/day.
- Do not add `'novel'` to `VALID_TYPES` in `apps/web/src/lib/api.ts`.
- Do not touch D1 core schema, the consistent-hash ring, AES-GCM token encryption, or sharding logic. Flag only.
- Deploy uses wrangler `3.114.17` from the repo root `node_modules` for API; web needs Node >= 22.12.
- No comments that restate code. Comment only non-obvious reasons.

## Review Focus

Five input classes the spec implies but that are easy to get wrong. Each has a test in the owning task.

1. **Chapter whose upstream text is empty or a login wall.** Expected: serve stale D1 content, never 500, never overwrite stored content with an empty body. → Task 5
2. **Novel slug containing a slash or percent-encoding** (`/novel/foo%2Fbar`). Expected: 404, not a shard read of the wrong series. → Task 4
3. **A request for `/bogus/{slug}`** where `bogus` is not a valid type. Expected: real 404 via the existing `notFound` path, not silently coerced to `manga`. → Task 6
4. **Two sources disagreeing on title for the same novel.** Expected: tier-1 (novelid) title wins, tier-2 only fills empty fields; never overwrite a non-empty tier-1 value. → Task 6
5. **Novel content spanning a Workers subrequest/CPU budget** (a 200-chapter series, a full catalog page). Expected: catalog paginates, chapter list paginates, and no single request fetches more than 50 chapters. → Task 4

---

## Wave 1 — Foundation (three parallel tracks, disjoint files)

### Task 1: D1 schema and data-access layer

**Files:**
- Create: `packages/db/migrations/0021_novel_module.sql`
- Modify: `packages/db/index.ts` (append novel queries; do not restructure existing exports)
- Test: `packages/db/test/novel.test.mjs`

**Interfaces produced** (Task 4 and 5 consume these):
```ts
// appended to packages/db/index.ts
export interface NovelSeriesRow {
  id: string; source_series_id: string; source: string; title: string;
  author: string | null; genre: string | null; status: string | null;
  cover_ref: string | null; cover_fallback: string | null;
  synopsis: string | null; created_at: number; updated_at: number;
}
export interface NovelChapterRow {
  id: string; series_id: string; source_chapter_id: string;
  number: number; title: string | null; content: string;
  content_hash: string; source_url: string | null; scraped_at: number;
}

export class NovelDb {
  upsertSeries(row: NovelSeriesRow): Promise<void>;
  getSeriesBySourceId(source: string, sourceSeriesId: string): Promise<NovelSeriesRow | null>;
  getSeriesBySlug(slug: string): Promise<NovelSeriesRow | null>;
  listSeries(opts: { limit: number; offset: number; genre?: string }): Promise<NovelSeriesRow[]>;
  countSeries(genre?: string): Promise<number>;
  fillSeriesGaps(id: string, patch: { cover_fallback?: string; synopsis?: string; author?: string }): Promise<void>;
  upsertChapters(seriesId: string, chapters: NovelChapterRow[]): Promise<{ inserted: number; updated: number; unchanged: number }>;
  getChapter(seriesId: string, sourceChapterId: string): Promise<NovelChapterRow | null>;
  listChapters(seriesId: string, opts: { limit: number; offset: number }): Promise<NovelChapterRow[]>;
  countChapters(seriesId: string): Promise<number>;
  listStaleSeries(olderThanSec: number, limit: number): Promise<NovelSeriesRow[]>;
}
export const novelDb = (d1: D1Database): NovelDb;
```

- [ ] **Step 1: Write the migration**

```sql
-- packages/db/migrations/0021_novel_module.sql
CREATE TABLE IF NOT EXISTS novel_series (
  id               TEXT PRIMARY KEY,
  source_series_id TEXT NOT NULL,
  source           TEXT NOT NULL,
  title            TEXT NOT NULL,
  author           TEXT,
  genre            TEXT,
  status           TEXT,
  cover_ref        TEXT,
  cover_fallback   TEXT,
  synopsis         TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (source, source_series_id)
);

CREATE TABLE IF NOT EXISTS novel_chapters (
  id                TEXT PRIMARY KEY,
  series_id         TEXT NOT NULL,
  source_chapter_id TEXT NOT NULL,
  number            REAL NOT NULL,
  title             TEXT,
  content           TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  source_url        TEXT,
  scraped_at        INTEGER NOT NULL,
  UNIQUE (series_id, source_chapter_id)
);

CREATE INDEX IF NOT EXISTS idx_novel_series_updated ON novel_series (updated_at);
CREATE INDEX IF NOT EXISTS idx_novel_chapters_series ON novel_chapters (series_id, number);
```

- [ ] **Step 2: Write the failing test**

`packages/db/test/novel.test.mjs` — follow the existing style (`import { test } from 'node:test'` + `node:assert/strict`, see `packages/db/test/matching.test.mjs`). It must assert on the SQL statements `NovelDb` emits, using a stub D1 that records `prepare()` calls, because there is no local D1 in tests. Cover: upsert uses `ON CONFLICT(source, source_series_id)`, `listSeries` clamps `limit` to `[1,100]`, `listChapters` orders by `number ASC`, `fillSeriesGaps` only writes columns present in its patch argument, and `upsertChapters` reports `unchanged` for a row whose `content_hash` matches while still leaving the stored body intact.

- [ ] **Step 3: Run the test and confirm failure**

Run: `npx tsx packages/db/test/novel.test.mjs`
Expected: FAIL — `novelDb` is not exported.

Note: `upsertChapters` is deliberately **not** named `replaceChapters`. It must compare each incoming `content_hash` against the stored row and write only on difference, returning the three counts. A destructive replace would defeat the KV write quota protection described in the spec, and would also drop stored content whenever an upstream fetch returned fewer chapters than we hold.

- [ ] **Step 4: Implement `NovelDb` in `packages/db/index.ts`**

Append only. Reuse the file's existing D1 wrapper conventions. `listSeries` must interpolate no user input into SQL — genre goes through a bound parameter, and the genre filter parses `genre` as a JSON array with a `LIKE` match, not `JSON_EXTRACT`, to stay consistent with how the rest of the file stores list columns.

- [ ] **Step 5: Run the test**

Run: `npx tsx packages/db/test/novel.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run existing db tests for regression**

Run: `npm --prefix packages/db test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0021_novel_module.sql packages/db/index.ts packages/db/test/novel.test.mjs
git commit -m "feat(db): novel_series + novel_chapters schema and data layer"
```

---

### Task 2: novelid chapter adapter

**Files:**
- Create: `packages/sources/novel.ts`
- Create: `packages/sources/novelid/index.ts`
- Create: `packages/sources/novelid/client.ts`
- Create: `packages/sources/novelid/rules.ts`
- Modify: `packages/sources/package.json` (add `"test"` entry for the new test file)
- Test: `packages/sources/test/novelid.test.mjs`
- Test fixture: `packages/sources/test/fixtures/novelid-chapter.html`

**Interfaces produced** (Tasks 4, 7 consume):
```ts
// packages/sources/novel.ts
export type NovelSourceKey = 'novelid' | 'gooddreamer' | 'noveltoon';
export type NovelCapability = 'chapter' | 'metadata';

export interface NovelSeries {
  sourceSeriesId: string; source: NovelSourceKey; title: string;
  slug: string; author?: string | null; genres?: string[];
  status?: string | null; coverUrl?: string | null; synopsis?: string | null;
  chapterCount?: number | null;
}
export interface NovelChapterSummary {
  sourceChapterId: string; number: number; title?: string | null; sourceUrl?: string;
}
export interface NovelChapterContent { html: string; }

export interface NovelSourceAdapter {
  sourceKey: NovelSourceKey;
  capability: NovelCapability;
  search(params: { q: string; limit?: number; offset?: number }): Promise<NovelSeries[]>;
  getSeries(sourceId: string): Promise<NovelSeries>;
  listChapters(sourceId: string, opts?: { limit?: number; offset?: number }): Promise<NovelChapterSummary[]>;
  getChapterContent?(sourceChapterId: string): Promise<NovelChapterContent>;
}

export const getNovelAdapter = (key: string): NovelSourceAdapter | null;
export const NOVEL_SOURCES: NovelSourceKey[];
```

- [ ] **Step 1: Capture a real fixture**

Fetch a real chapter page and commit it as the fixture, trimming to the relevant container:

```bash
mkdir -p packages/sources/test/fixtures
curl -sS -m 25 -L \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' \
  'https://novelid.org/novel/halal-tapi-asing/bab/1/' \
  -o packages/sources/test/fixtures/novelid-chapter.html
```

Then edit the file down to the `<div class="watch-chapter-detail">…</div>` region plus ~2000 characters of preceding markup, so the CSS `<style>` preamble is retained. The parser must survive that preamble — that is the whole point of the fixture. Verify the retained region still contains the prose.

- [ ] **Step 2: Write the failing test**

`packages/sources/test/novelid.test.mjs`, `node:test` + `node:assert/strict`, importing the parser directly from `../novelid/rules.ts`. Assert:
- `parseChapterHtml(fixture)` returns html of length > 500 containing a known sentence from the fixture.
- The result contains **no** `<style`, `<script`, or `css` token.
- `buildChapterUrl('halal-tapi-asing', 1)` === `https://novelid.org/novel/halal-tapi-asing/bab/1/`.
- `buildSeriesUrl('halal-tapi-asing')` === `https://novelid.org/novel/halal-tapi-asing/`.
- `buildChapterSourceId('https://novelid.org/novel/x/bab/12/')` === `'12'`.
- `stripCoverQuery('https://novelid.org/uploads/a.jpg?resize=139,184')` === `'https://novelid.org/uploads/a.jpg'`.
- Given HTML with no `watch-chapter-detail` div, `parseChapterHtml` returns `null` — not an empty string, not the CSS preamble.

- [ ] **Step 3: Run and confirm failure**

Run: `npx tsx packages/sources/test/novelid.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `novel.ts`, `rules.ts`, `client.ts`, `index.ts`**

`rules.ts` holds every regex and the container class name, exported `as const`, mirroring how `packages/sources/komiku/selectors.ts` is organised. `client.ts` exports `NOVELID_BASE`, `NOVELID_UA`, `NOVELID_REFERER`, `fetchRobots`, `isPathAllowed`, and a `fetchHtml(url, timeoutMs)` using `AbortSignal.timeout` plus the same headers the other clients send. Copy the robots helpers from `packages/sources/komiku/client.ts` rather than rewriting them. `index.ts` composes: fetch → parse → map to `NovelSeries` / `NovelChapterSummary` / `NovelChapterContent`, wrapping upstream calls in `retryUpstream` imported from the api-cf retry module only if that import is already legal for this package — **it is not**, so `packages/sources` must implement its own bounded retry rather than importing across workspace boundaries. Keep it to 2 attempts and log the `{ source, entityId, stage, error }` shape on final failure.

- [ ] **Step 5: Add the test script entry**

In `packages/sources/package.json`, append `&& tsx test/novelid.test.mjs` to the existing `test` script. Do not reorder the existing entries.

- [ ] **Step 6: Run and confirm pass**

Run: `npm --prefix packages/sources test`
Expected: PASS, including the four pre-existing adapter tests.

- [ ] **Step 7: Commit**

```bash
git add packages/sources/novel.ts packages/sources/novelid packages/sources/test/novelid.test.mjs packages/sources/test/fixtures/novelid-chapter.html packages/sources/package.json
git commit -m "feat(sources): novel adapter contract + novelid chapter adapter"
```

---

### Task 3: gooddreamer and noveltoon metadata adapters

**Files:**
- Create: `packages/sources/gooddreamer/index.ts`
- Create: `packages/sources/gooddreamer/client.ts`
- Create: `packages/sources/noveltoon/index.ts`
- Create: `packages/sources/noveltoon/client.ts`
- Modify: `packages/sources/novel.ts` (register both in `getNovelAdapter` and `NOVEL_SOURCES`)
- Test: `packages/sources/test/novel-metadata.test.mjs`

**Interfaces:** consumes `NovelSourceAdapter` from Task 2. Produces the same interface, so no new types.

- [ ] **Step 1: Write the failing test**

`node:test`. For gooddreamer, stub `fetch` and assert mapping of this verified payload shape:
```json
{"data":[{"id":14,"novel_uri":"bukan-salah-ibu-mengandung-pmh","novel_title":"Bukan Salah Ibu Mengandung","novel_sinopsis":"...","novel_cover":"https://storage.gooddreamer.id/novels/x.jpg","chapters_count":147,"readers_count":615,"author":{"fullname":"..."},"main_category":{"category_name":"Drama"},"tags":[]}]}
```
assert `sourceSeriesId === '14'`, `title` correct, `genres` includes `Drama`.

Also assert the capability guard: **`getChapterContent` is `undefined` on both metadata adapters**, so a caller cannot mistake them for a chapter source.

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx packages/sources/test/novel-metadata.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

gooddreamer hits `https://api.gooddreamer.id/api/web/novels`, `/api/web/novels/{id|uri}`, `/api/web/categories`, `/api/web/tags`. JSON only, no HTML parsing. Normalise the double-slash cover URLs observed upstream (`https://api.gooddreamer.id//storage/...`) to a single slash.

noveltoon scrapes the SSR HTML under `https://noveltoon.mobi/id/`. Respect its `robots.txt`, which disallows `/api` — **never** call an API path for this source; HTML under `/id/` only.

Both set `capability: 'metadata'`.

- [ ] **Step 4: Run and confirm pass**

Run: `npm --prefix packages/sources test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sources/gooddreamer packages/sources/noveltoon packages/sources/novel.ts packages/sources/test/novel-metadata.test.mjs packages/sources/package.json
git commit -m "feat(sources): gooddreamer + noveltoon metadata fallback adapters"
```

---

### Task 4: Manga adapter audit (low-risk fixes only)

**Files:**
- Modify: only files under `packages/sources/{komiku,bacakomik,thrive,manhwaindo,shinigami,webtoon}/` and `apps/api-cf/src/lib/`
- Create: `docs/superpowers/backlog/2026-09-27-manga-high-risk.md`
- Test: existing suites must stay green

**Do NOT modify `packages/sources/index.ts`** — Task 2/3 own that file. If the audit finds a problem there, write it into the backlog doc instead.

- [ ] **Step 1: Run the full baseline and record it**

```bash
node --test apps/api-cf/test/*.test.mjs 2>&1 | tail -20
npm --prefix packages/sources test
npm --prefix packages/db test
```

Record the pass/fail counts. Three api-cf failures are known baseline and must not be counted as regressions: `addB2Usage accumulates per idx independently`, `usageRatio = used/quota`, `db/exec rejects without forward key`.

- [ ] **Step 2: Run the audit checklist against all six adapters**

For each of the six, check: (a) satisfies `SourceAdapter`; (b) parsing rules and base URL live in the per-source `client.ts`/`selectors.ts` rather than inline in `index.ts`; (c) failure logs use `{ source, entityId, stage, error }`; (d) no literal secret or hardcoded upstream URL that belongs in config.

Write findings to a scratch list before editing anything.

- [ ] **Step 3: Apply low-risk fixes, one commit each**

Low risk = moving an inline URL or parsing rule into the per-source module; making a timeout explicit; unifying a log line to the four-key shape. Each fix is its own commit so it reverts in isolation:

```bash
git commit -m "refactor(sources/<name>): <what moved and why>"
```

If a fix would change observable parsing output, it is **not** low risk — put it in the backlog instead.

- [ ] **Step 4: Write the high-risk backlog**

`docs/superpowers/backlog/2026-09-27-manga-high-risk.md` must cover, at minimum, the four protected areas from Global Constraints, each with: what it is, why it is risky, what would have to be true to change it safely, and a suggested sequencing note. Add any item the audit surfaced.

- [ ] **Step 5: Re-run all suites and confirm no regression**

```bash
node --test apps/api-cf/test/*.test.mjs 2>&1 | tail -20
npm --prefix packages/sources test
npm --prefix packages/db test
```

Expected: identical to the Step 1 baseline.

- [ ] **Step 6: Commit the backlog**

```bash
git add docs/superpowers/backlog/2026-09-27-manga-high-risk.md
git commit -m "docs: high-risk manga backend backlog from adapter audit"
```

---

### Task 5: Automated secrets gate

**Files:**
- Create: `scripts/scan-secrets.mjs`
- Create: `.github/workflows/secrets.yml`
- Test: `scripts/scan-secrets.test.mjs`

- [ ] **Step 1: Write the failing test**

`node:test`. The scanner is a pure function `scan(text: string): Array<{file,line,rule,match}>`. Assert it flags a Cloudflare API token shape (`[A-Za-z0-9_-]{40}` preceded by a known key name), a Google OAuth client secret, a generic `sk-` key, and a `-----BEGIN ... PRIVATE KEY-----` block. Assert it does **not** flag the committed `docs/superpowers/specs/2026-09-27-novel-module-design.md`, nor `package-lock.json`, nor lines inside a fenced code block that the author marked with a `noqa:secretscan` comment.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test scripts/scan-secrets.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `scripts/scan-secrets.mjs`**

Zero dependencies — walk the tree with `node:fs`, skip `node_modules`, `.git`, `dist`, `.wrangler`, `.astro`, `.playwright-mcp`. Exit non-zero on any finding. This replaces the manual review step that previously let a Google OAuth secret reach `README.md`.

- [ ] **Step 4: Add the workflow**

`.github/workflows/secrets.yml` runs `node scripts/scan-secrets.mjs` on push and pull_request.

- [ ] **Step 5: Run and confirm pass**

Run: `node --test scripts/scan-secrets.test.mjs && node scripts/scan-secrets.mjs`
Expected: tests PASS, scanner exits 0 on the current tree.

- [ ] **Step 6: Commit**

```bash
git add scripts/scan-secrets.mjs scripts/scan-secrets.test.mjs .github/workflows/secrets.yml
git commit -m "ci: automated secret scan gate"
```

---

## Wave 2 — API surface (depends on Tasks 1, 2, 3)

### Task 6: Novel API routes

**Files:**
- Create: `apps/api-cf/src/routes/novel.ts`
- Create: `apps/api-cf/src/lib/novelIngest.ts`
- Modify: `apps/api-cf/src/index.ts` (import + `app.route('/api', novelRouter)`)
- Test: `apps/api-cf/test/novel-route.test.mjs`
- Test: `apps/api-cf/test/novel-ingest.test.mjs`

**Interfaces produced** (Task 7 consumes these paths):
```
GET /api/novel/catalog?genre=&page=&limit=     → { data: NovelSeriesRow[], page, limit, total }
GET /api/novel/series/:slug                    → { data: NovelSeriesRow & { chapters: NovelChapterRow[] } }
GET /api/novel/series/:slug/chapters?page=&limit= → { data: NovelChapterRow[], total }
GET /api/novel/series/:slug/chapter/:chapterId → { data: { id, number, title, content, scraped_at } }
```

**Interfaces produced** by `novelIngest.ts`:
```ts
export const fillMetadataGaps = async (
  env: Env, series: NovelSeriesRow, adapters: NovelSourceAdapter[]
): Promise<void>;
export const refreshSeries = async (
  env: Env, series: NovelSeriesRow, adapter: NovelSourceAdapter
): Promise<void>;
export const refreshStaleSeries = async (env: Env, olderThanSec: number, limit: number): Promise<number>;
```

- [ ] **Step 1: Write the failing route test**

`node:test` + `node:assert/strict`, following `apps/api-cf/test/admin-inventory-route.test.mjs`. Build a Hono app with a stub `Env`. Assert:
- `/api/novel/catalog` clamps `limit` to at most 50 and defaults page to 1.
- `/api/novel/series/:slug` with a slug containing `%2F` returns 404 (Review Focus #2).
- `/api/novel/series/:slug/chapter/:chapterId` returns stored content **without calling any adapter** — assert the stubbed fetch was never invoked (Review Focus #1 and #5).
- `/api/novel/series/:slug/chapter/:chapterId` for an unknown chapter returns 404, not an empty 200.
- The route computes its shard from `murmur3_32(seriesId) % N` by asserting `ownerFor` was consulted with the series slug.

- [ ] **Step 2: Write the failing ingest test**

`node:test`, in `apps/api-cf/test/novel-ingest.test.mjs`, with stub adapters. Assert:
- **Tier precedence (Review Focus #4):** given a stored series with a non-empty `title`, `author`, and `synopsis`, and a metadata adapter returning different values, `fillMetadataGaps` writes nothing. Given a series with `cover_ref === null`, it writes only `cover_fallback` and leaves the other columns untouched.
- `fillMetadataGaps` never calls an adapter whose `capability` is `'chapter'` for metadata, and never calls `getChapterContent` at all.
- `refreshSeries` on an upstream chapter fetch that returns an empty body leaves the stored `content` and `content_hash` unchanged (Review Focus #1).
- `refreshSeries` recomputes `content_hash` via `sha256Hex` and passes it to `upsertChapters`.
- `refreshStaleSeries` stops at `limit` and returns the number refreshed.

- [ ] **Step 3: Run both and confirm failure**

```bash
node --test apps/api-cf/test/novel-route.test.mjs apps/api-cf/test/novel-ingest.test.mjs
```
Expected: FAIL.

- [ ] **Step 4: Implement `novel.ts`**

Follow `apps/api-cf/src/routes/series.ts` exactly: `export const router = new Hono<{ Bindings: Env }>()`, `getDb(c)`, `json(c, data, status)`, KV read-through with `c.executionCtx.waitUntil` for the write-back. Reuse `ownerFor` from `apps/api-cf/src/lib/peers.ts` for shard selection.

The chapter route reads D1 and returns. If `scraped_at` is older than 24h it schedules `refreshSeries` via `waitUntil`; a failed refresh logs and is swallowed so the stale body still reaches the client.

- [ ] **Step 5: Implement `novelIngest.ts`**

`fillMetadataGaps` is the only place tier-2 is consulted. It builds a patch containing **only** the fields that are currently null/empty on the stored row, then calls `fillSeriesGaps`. It must never overwrite a populated field, and must never widen into chapter territory.

`refreshSeries` fetches the chapter list, fetches each chapter body, computes `content_hash` with `sha256Hex`, and hands the batch to `upsertChapters`. If an upstream body comes back empty or the container is missing, skip that chapter entirely — an empty result is never written.

`refreshStaleSeries` calls `listStaleSeries` then `refreshSeries` per row, swallowing per-row failures.

- [ ] **Step 6: Register the router and wire the cron**

In `apps/api-cf/src/index.ts`, add the import beside the other route imports and `app.route('/api', novelRouter);` next to the existing public `/api` mounts.

Then hook `refreshStaleSeries(env, 86400, 20)` into the handler behind the **existing** `crons = ["0 * * * *"]` trigger in `apps/api-cf/wrangler.toml`. Do not add a new trigger. If the existing scheduled handler is not reachable from `index.ts`, add the call to the nearest existing cron entry point and note the file in the commit body.

- [ ] **Step 7: Run and confirm pass**

```bash
node --test apps/api-cf/test/novel-route.test.mjs apps/api-cf/test/novel-ingest.test.mjs
```
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

```bash
npm --prefix apps/api-cf run build
git add apps/api-cf/src/routes/novel.ts apps/api-cf/src/lib/novelIngest.ts apps/api-cf/src/index.ts apps/api-cf/test/novel-route.test.mjs apps/api-cf/test/novel-ingest.test.mjs
git commit -m "feat(api): novel routes, tier-2 metadata gap fill and stale refresh"
```

---

## Wave 3 — Web surface (depends on Task 6)

### Task 7: Novel web module

**Files:**
- Create: `apps/web/src/pages/novel/index.astro`
- Create: `apps/web/src/pages/novel/[slug].astro`
- Create: `apps/web/src/pages/novel/[slug]/[chapter].astro`
- Create: `apps/web/src/components/NovelReader.tsx`
- Modify: `apps/web/src/lib/api.ts` (fetchers + `ORIGIN_PATH_ALLOWLIST`)
- Test: `apps/web/test/novel-route-guard.test.ts`

- [ ] **Step 1: Write the failing test**

`bun test` style, matching `apps/web/test/canonical-url.test.ts`. Export a pure helper from the guard module and assert:
- `resolveNovelRoute('/novel/abc')` yields the catalog/series shape.
- `isNovelPath('/novel/abc')` is true and `isNovelPath('/manga/abc')` is false.
- A `type` not in `VALID_TYPES` is rejected by the guard helper (Review Focus #3).

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/web && bun test test/novel-route-guard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add API client functions**

In `apps/web/src/lib/api.ts` add `getNovelCatalog`, `getNovelSeries`, `getNovelChapters`, `getNovelChapter` using the existing `apiWithFailover` helper, and append `/api/novel/` to `ORIGIN_PATH_ALLOWLIST` so novel requests participate in four-Worker round-robin. Do not add `'novel'` to `VALID_TYPES`.

- [ ] **Step 4: Build the three pages**

Follow the existing async-first pattern from `apps/web/src/pages/[type]/[slug]/index.astro`: `export const prerender = false`, SSR the fast part, give slow parts a `BUDGET_MS = 300` budget and let an island fetch the rest. All three pages import `BaseLayout` so the existing theme tokens apply with no new styling work.

- [ ] **Step 5: Build `NovelReader.tsx`**

A text reader, deliberately **not** a variant of `Reader.tsx` (that one reserves image aspect ratios to fight CLS, which does not apply to prose). V1 scope: font-size control, line-height control, previous/next chapter, progress persisted to `localStorage`, and the existing dark/light/orange theme via CSS variables only. No new colour values.

- [ ] **Step 6: Run and confirm pass**

Run: `cd apps/web && bun test && npm run build`
Expected: tests PASS, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/novel apps/web/src/components/NovelReader.tsx apps/web/src/lib/api.ts apps/web/test/novel-route-guard.test.ts
git commit -m "feat(web): /novel catalog, series and text reader"
```

---

### Task 8: Route guards on manga pages

**Files:**
- Modify: `apps/web/src/pages/[type]/[slug]/index.astro`
- Modify: `apps/web/src/pages/[type]/[slug]/[chapterId].astro`

- [ ] **Step 1: Add the guard**

Both files already carry `let notFound = false` and render `NotFoundPage` when it is set. Add the type check alongside the existing slug load so an unknown type sets the flag instead of falling through to `safeType()`:

```ts
if (!isValidType(type!)) notFound = true;
```

Place it before the `if (loaded && loaded.resolved.type !== type)` redirect so a bogus type never triggers a redirect. Import `isValidType` from `@/lib/api`.

- [ ] **Step 2: Verify no regression**

Run: `cd apps/web && bun test && npm run build && npm run lint`
Expected: tests PASS, build succeeds. `astro check` has one known pre-existing error in `PreferencesSection.tsx:111` (`webtoon` outside `UserSource`) — that one is expected and is not a regression.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/pages/[type]/[slug]/index.astro" "apps/web/src/pages/[type]/[slug]/[chapterId].astro"
git commit -m "fix(web): reject unknown content type instead of coercing to manga"
```

---

## Wave 4 — Migration and verification

### Task 9: Apply the migration to all four shards

- [ ] **Step 1: Confirm the migration is idempotent-guarded**

`0021_novel_module.sql` uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` throughout, so re-running is safe.

- [ ] **Step 2: Apply to all four databases**

```bash
export $(grep -v '^#' .env | xargs) && ./scripts/migrate-all-4.sh
```

Expected: exit 0, `0021` recorded in `_migrations` for all four.

- [ ] **Step 3: Verify**

Confirm `novel_series` and `novel_chapters` exist in each of the four D1 databases and that `_migrations` shows `0021`.

- [ ] **Step 4: Commit any script change**

If `scripts/migrate-all-4.sh` needed a change, commit it separately:

```bash
git commit -m "chore(db): migration runner support for novel tables"
```

---

### Task 10: Full verification and deploy

- [ ] **Step 1: Run every suite**

```bash
node --test apps/api-cf/test/*.test.mjs 2>&1 | tail -25
npm --prefix packages/sources test
npm --prefix packages/db test
node --test packages/shared/test/*.test.mjs
cd apps/web && bun test
node scripts/scan-secrets.mjs
```

Expected: no new failures versus the recorded baselines. The three known api-cf failures and the one `astro check` error are pre-existing.

- [ ] **Step 2: Build everything**

```bash
npm --prefix apps/api-cf run build
cd apps/web && npm run build && cd ../..
```

- [ ] **Step 3: Deploy API workers**

Use wrangler `3.114.17` from the root `node_modules` with Node 20, one config per origin (`wrangler.toml`, `wrangler.origin.toml`, `wrangler.origin3.toml`, `wrangler.origin4.toml`). Tokens come from `.env`, not `.env.deploy`.

- [ ] **Step 4: Verify production**

All four `/api/health` return 200 with origin count 4. `GET /api/novel/catalog?limit=2` returns 200 with a `data` array. CORS `Access-Control-Allow-Origin` is exactly `https://oktzz.xyz`.

- [ ] **Step 5: Deploy web**

Web needs Node >= 22.12 and wrangler 4.130 from `apps/web`.

- [ ] **Step 6: Spot-check 3 series end-to-end**

Pick three real `novelid.org` series. For each: catalog entry resolves, series page lists chapters, one chapter renders prose in the browser with no console errors. Do **not** add `/novel` to site navigation until this passes.

- [ ] **Step 7: Commit and push**

```bash
git status -sb
git push
```

Do not add the untracked `apps/api-cf/manga-api` and `apps/web/manga-web` symlinks.
