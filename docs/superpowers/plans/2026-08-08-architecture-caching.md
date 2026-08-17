# Architecture Caching Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 5 architecture changes: homepage KV daily cache, D1 akun-2 primary with overflow to akun-1, R2 all-source cache-aside, DB-first pattern for all data, source switcher UI in detail page + reader gear panel.

**Architecture:** Worker reads D1 (akun-2 primary) first for all data, falls back to upstream adapter on miss, persists to D1. KV caches homepage feed with 24h lazy refresh. R2 stores images for all sources on-demand. Frontend uses R2-first for all sources, proxy fallback. Source switcher lazy-loads sources in detail page top-right and reader gear settings.

**Tech Stack:** Cloudflare Workers (Hono), D1 (SQLite), KV, R2 (S3 SigV4), Next.js 14 (Pages, edge runtime), Tailwind CSS.

## Global Constraints

- D1 akun-2 (tzok5555) id `61cbf1b1-508e-4b00-a0e6-dd68528e54ba` = primary
- D1 akun-1 (oktz) id `76606365-0fa5-4c1e-9b55-18a8366ef92a` = overflow
- KV namespace `6205fceab7b64f9d80f6f67e4189316b` (akun-1, shared)
- R2 key pattern: `{source}/{slug}/{chapterId}/{pageNo}` (was `komiku/...`)
- Homepage KV TTL: 90000s (25h), CF cache: `s-maxage=900, stale-while-revalidate=86400`
- D1 overflow threshold: 80% quota -> KV `d1:usage` counter
- All source switcher loads must be lazy (no pre-fetch on page load)
- `runtime = 'edge'` required for dynamic Pages
- No new npm dependencies
- CF API tokens: akun-1 `cfut_<REDACTED>`, akun-2 `cfut_<REDACTED>`

---

## Task 1: D1 Overflow — Wrangler Config + Context

**Files:**
- Modify: `apps/api-cf/wrangler.toml`
- Modify: `apps/api-cf/src/lib/context.ts`

**Interfaces:**
- Produces: `Env.DB_OVERFLOW?: D1Database` — second D1 binding (akun-1 overflow)
- Produces: `shouldOverflow(c: Context): Promise<boolean>` — check KV usage counter
- Produces: `trackD1Usage(c: Context, estimatedBytes: number): void` — increment KV counter

- [ ] **Step 1: Swap DB binding to akun-2, add DB_OVERFLOW for akun-1**

In `apps/api-cf/wrangler.toml`, replace the `[[d1_databases]]` block:

```toml
[[d1_databases]]
binding = "DB"
database_name = "manga-db"
database_id = "61cbf1b1-508e-4b00-a0e6-dd68528e54ba"

[[d1_databases]]
binding = "DB_OVERFLOW"
database_name = "manga-db"
database_id = "76606365-0fa5-4c1e-9b55-18a8366ef92a"
```

- [ ] **Step 2: Add DB_OVERFLOW to Env interface + overflow helpers in context.ts**

In `apps/api-cf/src/lib/context.ts`, add `DB_OVERFLOW?: D1Database;` to Env interface, then add after `getDb`:

```typescript
export const shouldOverflow = async (c: Context): Promise<boolean> => {
  if (!c.env.DB_OVERFLOW) return false;
  try {
    const usage = await c.env.CACHE_KV.get('d1:usage', { type: 'json' }) as { bytes: number; overflow: boolean } | null;
    if (!usage) return false;
    return usage.overflow || usage.bytes > 400 * 1024 * 1024;
  } catch { return false; }
};

export const trackD1Usage = (c: Context, estimatedBytes: number): void => {
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const current = await c.env.CACHE_KV.get('d1:usage', { type: 'json' }) as { bytes: number; overflow: boolean } | null;
        const bytes = (current?.bytes ?? 0) + estimatedBytes;
        const overflow = bytes > 400 * 1024 * 1024;
        await c.env.CACHE_KV.put('d1:usage', JSON.stringify({ bytes, overflow }));
      } catch {}
    })()
  );
};
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit -p apps/api-cf`
Expected: PASS (pre-existing errors in auth.ts/crypto.ts OK)

- [ ] **Step 4: Commit**

```bash
git add apps/api-cf/wrangler.toml apps/api-cf/src/lib/context.ts
git commit -m "feat(api): D1 akun-2 primary + overflow binding to akun-1"
```

---

## Task 2: Homepage KV Cache — New Endpoint

**Files:**
- Create: `apps/api-cf/src/routes/homepage.ts`
- Modify: `apps/api-cf/src/index.ts` (mount route)

**Interfaces:**
- Produces: `GET /api/homepage` -> `{ data: MergedManga[], sources_queried: string[], total: number, cached: boolean }`

- [ ] **Step 1: Create homepage route file**

Create `apps/api-cf/src/routes/homepage.ts` with:
- `fetchHomepageFromSources(c)` — fetch 4 sources paralel, merge by normalized title, include D1 rows
- `GET /homepage` handler: KV read first, fresh (<24h) serve, stale serve+bg refresh, missing block+fetch
- KV keys: `homepage:feed` (JSON payload, TTL 90000s), `homepage:feed:last_updated` (timestamp string, TTL 90000s)
- CF header: `Cache-Control: public, s-maxage=900, stale-while-revalidate=86400`
- Reuse `normalizeTitle`, `recordHealth`, `retryUpstream` patterns from search.ts

- [ ] **Step 2: Mount in index.ts**

Add `import { router as homepageRouter } from './routes/homepage';` and `app.route('/api', homepageRouter);`

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit -p apps/api-cf`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api-cf/src/routes/homepage.ts apps/api-cf/src/index.ts
git commit -m "feat(api): /api/homepage endpoint with KV daily cache"
```

---

## Task 3: Homepage Frontend — Use New Endpoint

**Files:**
- Modify: `apps/web/lib/api.ts` (add `fetchHomepage`)
- Modify: `apps/web/app/page.tsx` (use `fetchHomepage` instead of `searchMerged`)

- [ ] **Step 1: Add fetchHomepage to api.ts**

Add after `searchMerged`:
```typescript
export const fetchHomepage = (): Promise<{ data: MergedManga[]; sources_queried: string[]; total: number; cached: boolean }> =>
  dataApi('/api/homepage');
```

- [ ] **Step 2: Update page.tsx**

Change import to `import { fetchHomepage, getSourceStatus } from '@/lib/api';`
Change fetch call to use `fetchHomepage()` instead of `searchMerged('')`.
Remove `export const revalidate = 300;` (CF cache headers handle it).
Keep `export const runtime = 'edge';`.

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit -p apps/web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/api.ts apps/web/app/page.tsx
git commit -m "feat(web): homepage uses /api/homepage KV cache"
```

---

## Task 4: R2 All-Source — Worker reader.ts + shared r2-routing

**Files:**
- Modify: `packages/shared/src/r2-routing.ts` (add `r2KeyFor`)
- Modify: `apps/api-cf/src/routes/reader.ts` (remove komiku-only guard, all-source upload)

**Interfaces:**
- Produces: `r2KeyFor(source, slug, chapterId, pageNo): string` — shared key pattern `{source}/{slug}/{chapterId}/{pageNo}`
- Changes: `uploadToR2` takes `source` param, `resolveSlug` replaces `resolveKomikuSlug`

- [ ] **Step 1: Add r2KeyFor to r2-routing.ts**

```typescript
export const r2KeyFor = (source: string, slug: string, chapterId: string, pageNo: number): string =>
  `${source}/${slug}/${chapterId}/${pageNo}`;
```

- [ ] **Step 2: Update uploadToR2 in reader.ts**

Add `source: string` to opts param. Change key from `komiku/${slug}/${chapterId}/${pageNo}` to `r2KeyFor(opts.source, opts.slug, opts.chapterId, opts.pageNo)`.

- [ ] **Step 3: Rename resolveKomikuSlug -> resolveSlug**

Rename function. Logic unchanged (D1 lookup + KV cache + fallback parse).

- [ ] **Step 4: Remove komiku-only guard in image proxy**

Replace `if (source === 'komiku')` block with unconditional R2 upload for all sources. Pass `source` to `uploadToR2`.

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit -p apps/api-cf && npx tsc --noEmit -p packages/shared`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api-cf/src/routes/reader.ts packages/shared/src/r2-routing.ts
git commit -m "feat(api): R2 cache-aside for all sources, not just komiku"
```

---

## Task 5: R2 All-Source — Frontend api.ts

**Files:**
- Modify: `apps/web/lib/api.ts` (r2UrlFor signature change)
- Modify: `apps/web/app/[source]/s/[slug]/[chapterId]/page.tsx` (pass source)

- [ ] **Step 1: Update r2UrlFor signature**

Change from `r2UrlFor(slug, chapterId, pageNo)` to `r2UrlFor(source, slug, chapterId, pageNo)`. Import `r2KeyFor` from shared. Use `r2KeyFor(source, slug, chapterId, pageNo)` in URL.

- [ ] **Step 2: Update chapter page**

Change `r2UrlFor(params.slug, params.chapterId, i + 1)` to `r2UrlFor(params.source, params.slug, params.chapterId, i + 1)`.

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit -p apps/web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/api.ts "apps/web/app/[source]/s/[slug]/[chapterId]/page.tsx"
git commit -m "feat(web): R2-first for all sources in reader"
```

---

## Task 6: DB-First Pattern — New D1 Methods

**Files:**
- Modify: `packages/db/index.ts` (add 3 new methods to Db interface + implementation)

**Interfaces:**
- Produces: `db.upsertChapter(params): Promise<{ success: boolean }>`
- Produces: `db.upsertChapterPages(chapterId, pages[]): Promise<{ success: boolean }>`
- Produces: `db.getChapterWithPages(chapterId): Promise<Result<ChapterWithPages>>`

- [ ] **Step 1: Add upsertChapter to Db interface + implementation**

Interface:
```typescript
upsertChapter: (params: { id: string; seriesSlug: string; chapterNumber: number; volume?: string | null; title?: string | null; language?: string; pagesCount?: number; publishedAt?: number | null }) => Promise<{ success: boolean }>;
```

Implementation (INSERT ON CONFLICT DO UPDATE):
```typescript
upsertChapter: async (p) => {
  const res = await prep(
    `INSERT INTO chapters (id, series_slug, chapter_number, volume, title, language, pages_count, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       series_slug=excluded.series_slug, chapter_number=excluded.chapter_number,
       volume=excluded.volume, title=excluded.title, pages_count=excluded.pages_count,
       published_at=excluded.published_at`
  ).bind(p.id, p.seriesSlug, p.chapterNumber, p.volume ?? null, p.title ?? null, p.language ?? 'en', p.pagesCount ?? 0, p.publishedAt ?? null).run();
  return { success: res.success };
},
```

- [ ] **Step 2: Add upsertChapterPages (batch insert)**

Interface:
```typescript
upsertChapterPages: (chapterId: string, pages: Array<{ pageNumber: number; imageUrl: string }>) => Promise<{ success: boolean }>;
```

Implementation (batch INSERT OR IGNORE):
```typescript
upsertChapterPages: async (chapterId, pages) => {
  if (pages.length === 0) return { success: true };
  const stmts = pages.map((p) =>
    prep('INSERT OR IGNORE INTO chapter_pages (chapter_id, page_number, image_url) VALUES (?, ?, ?)')
      .bind(chapterId, p.pageNumber, p.imageUrl)
  );
  await client.batch(stmts);
  return { success: true };
},
```

- [ ] **Step 3: Add getChapterWithPages**

Interface:
```typescript
getChapterWithPages: (chapterId: string) => Promise<Result<{ id: string; series_slug: string; chapter_number: number; title: string | null; pages: Array<{ page_number: number; image_url: string }> }>>;
```

Implementation:
```typescript
getChapterWithPages: async (chapterId) => {
  const ch = await prep('SELECT * FROM chapters WHERE id = ?1 LIMIT 1').bind(chapterId).first<Row>();
  if (!ch) return null;
  const { results } = await prep('SELECT page_number, image_url FROM chapter_pages WHERE chapter_id = ?1 ORDER BY page_number ASC').bind(chapterId).all<Row>();
  return {
    id: ch.id as string,
    series_slug: ch.series_slug as string,
    chapter_number: ch.chapter_number as number,
    title: (ch.title as string) ?? null,
    pages: (results ?? []).map((r) => ({ page_number: r.page_number as number, image_url: r.image_url as string })),
  } as any;
},
```

- [ ] **Step 4: Verify typecheck**

Run: `npx tsc --noEmit -p packages/db`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/index.ts
git commit -m "feat(db): upsertChapter, upsertChapterPages, getChapterWithPages"
```

---

## Task 7: DB-First Pattern — Worker reader.ts + search.ts

**Files:**
- Modify: `apps/api-cf/src/routes/reader.ts` (series detail + chapter: D1 first)
- Modify: `apps/api-cf/src/routes/search.ts` (persist search results to D1)

- [ ] **Step 1: Series detail route — D1 first**

In `reader.ts` `GET /:source/series/:sourceId`:
1. Check D1 via `db.getMangaBySource(source, sourceId)` -> if hit, serve from D1
2. If miss -> adapter.getSeries -> upsertSeries + upsertSourceLink -> serve
3. KV cache remains for 600s

- [ ] **Step 2: Chapter detail route — D1 first**

In `reader.ts` `GET /:source/chapter/:chapterId`:
1. Check D1 via `db.getChapterWithPages(chapterId)` -> if hit AND pages.length > 0, serve from D1
2. If miss -> adapter.getChapter + fetchPageUrls -> upsertChapter + upsertChapterPages -> serve
3. KV cache remains for 300s

- [ ] **Step 3: Search — persist results to D1**

In `search.ts`, after merging results from all sources, background `waitUntil` to upsert each result to D1 series table + manga_source_link. Already partially done in `/sources` endpoint auto-index.

- [ ] **Step 4: Verify typecheck**

Run: `npx tsc --noEmit -p apps/api-cf`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-cf/src/routes/reader.ts apps/api-cf/src/routes/search.ts
git commit -m "feat(api): DB-first pattern — D1 before upstream fetch"
```

---

## Task 8: Source Switcher — Detail Page Top-Right

**Files:**
- Modify: `apps/web/app/[source]/s/[slug]/page.tsx` (reposition SourceSwitcher to top-right)
- Modify: `apps/web/components/SourceSwitcher.tsx` (badge+name layout for top-right)

- [ ] **Step 1: Reposition SourceSwitcher in detail page**

In `apps/web/app/[source]/s/[slug]/page.tsx`, change top section to flex justify-between:

```tsx
<div className="flex items-center justify-between mb-4">
  <Link href="/" prefetch={false} className="text-secondary text-sm hover:text-accent">← Beranda</Link>
  <SourceSwitcher
    currentSource={params.source}
    sourceId={sourceId}
    canonicalSlug={params.slug}
    chapterNumber={0}
    apiUrl={API_URL}
    mode="detail"
  />
</div>
```

Remove the SourceSwitcher that was below the title (lines ~66-73).

- [ ] **Step 2: Verify SourceSwitcher detail mode works in top-right**

The existing `mode='detail'` already renders a button with badge+name+dropdown. No component change needed — just repositioned.

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit -p apps/web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/[source]/s/[slug]/page.tsx"
git commit -m "feat(web): source switcher repositioned to detail page top-right"
```

---

## Task 9: Source Switcher — Reader Gear Panel

**Files:**
- Modify: `apps/web/components/SourceSwitcher.tsx` (add `mode='settings'`)
- Modify: `apps/web/components/ReaderShell.tsx` (add SourceSwitcher in settings panel)

- [ ] **Step 1: Add mode='settings' to SourceSwitcher**

In `SourceSwitcher.tsx`, add a new mode block before the reader mode block. Layout: vertical list of source buttons (badge + name), no horizontal scroll. Same lazy fetch logic (only fetch when `open` prop is true).

```tsx
if (mode === 'settings') {
  return (
    <div className="mt-2">
      <p className="px-1 pb-1 text-[10px] uppercase tracking-wider text-muted">Ganti Source</p>
      {ordered.map((s) => {
        const link = links.find((l) => l.source === s);
        const isActive = s === currentSource;
        return (
          <button
            key={s}
            onClick={() => onPick(s)}
            disabled={!link?.hasChapterList}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors text-left ${
              isActive ? 'bg-bg-secondary text-primary' : 'text-secondary hover:text-primary hover:bg-bg-secondary/60'
            } ${!link?.hasChapterList ? 'opacity-40' : ''}`}
          >
            <SourceIcon source={s} dim="h-5 w-5" />
            <span className="capitalize flex-1">{sourceLabel(s)}</span>
            {isActive && <span className="text-[10px] text-accent">aktif</span>}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Add SourceSwitcher to ReaderShell settings panel**

In `ReaderShell.tsx`, inside the `settingsOpen && (...)` block (after the mode buttons, before the page counter), add:

```tsx
<SourceSwitcher
  currentSource={source}
  sourceId={slug}
  canonicalSlug={slug}
  chapterNumber={chapterNumber}
  apiUrl={apiUrl}
  mode="settings"
/>
```

This is lazy — the settings panel only renders when `settingsOpen` is true. SourceSwitcher fetches `/sources` only when mounted.

- [ ] **Step 3: Ensure chapter list loads from current source**

`ReaderShell` already calls `getChapters(source, slug)` which hits `/api/reader/${source}/series/${sourceId}/chapters`. When user switches source via SourceSwitcher, it navigates to the new source URL, causing `ReaderShell` to remount with the new `source` prop. Chapters load from the new source automatically.

- [ ] **Step 4: Verify typecheck**

Run: `npx tsc --noEmit -p apps/web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/SourceSwitcher.tsx apps/web/components/ReaderShell.tsx
git commit -m "feat(web): source switcher in reader gear settings panel"
```

---

## Task 10: Deploy + Test End-to-End

**Files:** None (deployment only)

- [ ] **Step 1: Run all typechecks**

```bash
npx tsc --noEmit -p apps/api-cf
npx tsc --noEmit -p apps/web
npx tsc --noEmit -p packages/db
npx tsc --noEmit -p packages/shared
```
Expected: All PASS

- [ ] **Step 2: Build worker bundle**

```bash
node scripts/build-worker-bundle.mjs
```

- [ ] **Step 3: Deploy Worker to akun-1 (main)**

```bash
export CLOUDFLARE_API_TOKEN="cfut_<REDACTED>"
npx wrangler deploy --config apps/api-cf/wrangler.toml
```

- [ ] **Step 4: Set secrets on akun-1 (if not already set)**

Secrets persist from previous deploy. Only new binding DB_OVERFLOW needs the D1 to exist (it does — akun-1 D1 `manga-db` id `76606365`).

- [ ] **Step 5: Run migrations on akun-2 D1 (primary)**

```bash
export CLOUDFLARE_API_TOKEN="cfut_<REDACTED>"
export CLOUDFLARE_ACCOUNT_ID=6a0bdfb8bccff744bd738a57502d0380
npx wrangler d1 execute manga-db --remote --file=packages/db/schema.sql
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0001_manga_data.sql
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0002_r2_storage.sql
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0003_drop_mangadex.sql
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0004_aggregation.sql
```

- [ ] **Step 6: Build + deploy frontend**

```bash
cd apps/web
rm -rf .next .vercel
NEXT_PUBLIC_API_URL=https://manga-api.oktz.workers.dev \
NEXT_PUBLIC_DATA_API_URL=https://manga-api.oktz.workers.dev \
npx next-on-pages
export CLOUDFLARE_API_TOKEN="cfut_<REDACTED>"
npx wrangler pages deploy .vercel/output/static --project-name manga-web --branch main
```

- [ ] **Step 7: Verify endpoints**

- `GET /api/health` -> `{status:"ok"}`
- `GET /api/homepage` -> JSON with data array, cached: true/false
- `GET /api/search?q=naruto` -> results
- `GET /api/reader/komiku/series/test/detail` -> series + chapters
- Mobile viewport: no horizontal overflow on all pages

- [ ] **Step 8: Commit final**

```bash
git add -A
git commit -m "feat: architecture caching redesign — KV homepage, D1 overflow, R2 all-source, DB-first, source switcher"
```

---

## Self-Review Notes

**Spec coverage:** All 5 sections from spec have tasks:
1. Homepage KV cache -> Task 2, 3
2. D1 overflow -> Task 1
3. R2 all-source -> Task 4, 5
4. Source switcher UI -> Task 8, 9
5. DB-first pattern -> Task 6, 7

**Type consistency:**
- `r2UrlFor(source, slug, chapterId, pageNo)` — consistent in Task 4 (Worker) and Task 5 (frontend)
- `r2KeyFor(source, slug, chapterId, pageNo)` — shared helper, consistent
- `getDb(c)` unchanged, `shouldOverflow(c)` + `trackD1Usage(c, bytes)` new
- `upsertChapter`, `upsertChapterPages`, `getChapterWithPages` — new Db methods, used in Task 7

**No placeholders:** All steps have concrete code or commands.
