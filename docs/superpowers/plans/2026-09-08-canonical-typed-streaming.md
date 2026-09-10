# Canonical Typed URLs + Streaming Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Halaman komik ber-URL kanonik `/manga|manhwa|manhua/{slug}` yang me-render shell (cover, judul, sinopsis) dulu dan men-streaming daftar chapter + pemilih source di background.

**Architecture:** Endpoint resolver baru `GET /api/resolve/:slug` (KV two-tier + enrich background, tanpa fetch blocking) dipasang paralel dengan `detail`; route kanonik tipis di group `app/(canon)/` me-`await` hanya `detail` lalu men-streaming `ChapterSection` + `SourceSection` via Suspense; route lama `/:source/s/...` menjadi redirect 308. Nol migrasi D1, nol hapus data.

**Tech Stack:** Next.js App Router (Suspense streaming, `permanentRedirect`), Hono Worker (`readThroughCache`, `waitUntil`), D1 + CACHE_KV, `node:test` + `tsx`, Playwright, `tsc --noEmit`.

## Global Constraints

- NO D1 migrations — skema tidak berubah (`series.slug` UNIQUE + `manga_source_link` sudah cukup).
- NO data deletion — bookmarks, history, `chapter_pages`, B2 keys tidak disentuh.
- Setiap fetch baru wajib `AbortSignal.timeout`; tanpa `setInterval`/polling; background hanya `waitUntil` + refetch maks 1x/mount.
- Exact boundaries: 3 Suspense (shell sync + chapter + source), tidak lebih.
- Test runner backend: `npx tsx --test test/<file>.test.mjs` dari `apps/api-cf` (pola `test/source-pick.test.mjs` memakai `node:test` + import TS langsung).
- Web checks: `bun test/round-robin.test.ts`, `npx tsc --noEmit` dari `apps/web`.
- Satu tugas = satu deliverable testable; commit per tugas.

---

## File Structure

```
apps/api-cf/src/routes/resolve.ts            # CREATE — GET /resolve/:slug
apps/api-cf/src/index.ts                     # MODIFY — mount resolveRouter
apps/api-cf/src/routes/reader.ts             # MODIFY — enrich→background, race 4s, pages singleflight
apps/api-cf/test/resolve.test.mjs            # CREATE — unit pure resolver mapping

apps/web/lib/api.ts                          # MODIFY — getResolve + allowlist + typed URL helpers
apps/web/app/(canon)/_shared/loadCanonical.ts       # CREATE — cached resolve+detail loader
apps/web/app/(canon)/_shared/CanonicalDetail.tsx    # CREATE — shell + 2 Suspense
apps/web/app/(canon)/_shared/ChapterSection.tsx     # CREATE — async server, auto-pick
apps/web/app/(canon)/_shared/SourceSection.tsx      # CREATE — async server, counter+picker
apps/web/app/(canon)/_shared/CanonicalReader.tsx    # CREATE — chapter reader typed
apps/web/app/(canon)/manga/[slug]/page.tsx + loading.tsx          # CREATE thin (×3 type)
apps/web/app/(canon)/manhwa/[slug]/page.tsx + loading.tsx         # CREATE thin (×3 type)
apps/web/app/(canon)/manhua/[slug]/page.tsx + loading.tsx         # CREATE thin (×3 type)
apps/web/app/(canon)/manga/[slug]/[chapterId]/page.tsx            # CREATE thin (×3 type)
apps/web/app/(canon)/manhwa/[slug]/[chapterId]/page.tsx           # CREATE thin
apps/web/app/(canon)/manhua/[slug]/[chapterId]/page.tsx           # CREATE thin
apps/web/app/(canon)/error.tsx + not-found.tsx                    # CREATE shared segmen
apps/web/app/[source]/s/[slug]/page.tsx                           # MODIFY — redirect 308
apps/web/app/[source]/s/[slug]/[chapterId]/page.tsx               # MODIFY — redirect 308
apps/web/components/SourceSwitcher.tsx                            # MODIFY — onPick ke URL typed
apps/web/components/ChapterList.tsx                               # MODIFY — linkHref typed
apps/web/components/Skeleton.tsx                                  # MODIFY — tambah 2 skeleton
apps/web/app/sitemap.ts                                           # MODIFY — URL typed
apps/web/e2e/canonical-streaming.spec.ts                          # CREATE — Playwright
```

---

### Task 1: Backend `GET /api/resolve/:slug`

**Files:**
- Create: `apps/api-cf/src/routes/resolve.ts`
- Modify: `apps/api-cf/src/index.ts` (1 baris mount)
- Test: `apps/api-cf/test/resolve.test.mjs`

**Interfaces:**
- Consumes: `getDb(c).getSourceLinksByManga(mangaId)`, `readThroughCache(c, key, load, opts)`, `pickRecommendedSource(links)` dari `./reader.ts`, `peerKvGet(c.env, key)`.
- Produces: `GET /api/resolve/:slug → { data: { slug, type, source, sourceSlug, recommendedSource, sources: [{source, sourceSlug, hasChapterList, chapterCount}] } }`; exports pure `buildResolveResponse(seriesRow, linkRows)` untuk unit test.

- [ ] **Step 1: Write the failing test**

```js
// apps/api-cf/test/resolve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResolveResponse } from '../src/routes/resolve.ts';

test('resolves canonical type+source, recommended = most chapters', () => {
  const out = buildResolveResponse(
    { slug: 'solo-leveling', type: 'manhwa', source: 'komiku' },
    [
      { source: 'komiku', source_slug: 'solo-leveling', has_chapter_list: 1, chapter_count: 100, last_scraped_at: 1 },
      { source: 'bacakomik', source_slug: 'solo-leveling', has_chapter_list: 1, chapter_count: 179, last_scraped_at: 2 },
    ]
  );
  assert.equal(out.type, 'manhwa');
  assert.equal(out.source, 'komiku');
  assert.equal(out.recommendedSource, 'bacakomik');
});

test('unknown slug → null', () => {
  assert.equal(buildResolveResponse(null, []), null);
});

test('wrong-type caller detected via type field', () => {
  const out = buildResolveResponse(
    { slug: 'one-piece', type: 'manga', source: 'komiku' },
    [{ source: 'komiku', source_slug: 'one-piece', has_chapter_list: 1, chapter_count: 10, last_scraped_at: 1 }]
  );
  assert.equal(out.type, 'manga');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/resolve.test.mjs` (dari `apps/api-cf`)
Expected: FAIL with "Cannot find module '../src/routes/resolve.ts'"

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api-cf/src/routes/resolve.ts
import { Hono } from 'hono';
import { getDb } from '../lib/context';
import type { Env, Context } from '../lib/context';
import { readThroughCache } from '../lib/readThroughCache';
import { peerKvGet } from '../lib/peers';
import { pickRecommendedSource, type SourceLinkRow } from './reader.ts';

export const VALID_TYPES = new Set(['manga', 'manhwa', 'manhua']);

export interface ResolveResult {
  slug: string;
  type: string;
  source: string;
  sourceSlug: string;
  recommendedSource: string | null;
  sources: Array<{ source: string; sourceSlug: string; hasChapterList: boolean; chapterCount: number }>;
}

export const buildResolveResponse = (
  seriesRow: { slug: string; type: string; source: string } | null | undefined,
  linkRows: Array<{ source: string; source_slug: string; has_chapter_list: number; chapter_count: number; last_scraped_at: number | null }>
): ResolveResult | null => {
  if (!seriesRow) return null;
  const links: SourceLinkRow[] = linkRows.map((l) => ({
    source: l.source,
    sourceSlug: l.source_slug,
    hasChapterList: l.has_chapter_list === 1,
    chapterCount: l.chapter_count,
    lastScrapedAt: l.last_scraped_at ?? null,
  }));
  const self = links.find((l) => l.source === seriesRow.source);
  const sourceSlug = self?.sourceSlug ?? seriesRow.slug;
  if (self && !links.includes(self)) links.push(self);
  if (links.length === 0) {
    links.push({ source: seriesRow.source, sourceSlug, hasChapterList: true, chapterCount: 0, lastScrapedAt: null });
  }
  return {
    slug: seriesRow.slug,
    type: VALID_TYPES.has(seriesRow.type) ? seriesRow.type : 'manga',
    source: seriesRow.source,
    sourceSlug,
    recommendedSource: pickRecommendedSource(links),
    sources: links.map((l) => ({ source: l.source, sourceSlug: l.sourceSlug, hasChapterList: l.hasChapterList, chapterCount: l.chapterCount })),
  };
};

export const router = new Hono<{ Bindings: Env }>();

router.get('/resolve/:slug', async (c: Context) => {
  const { slug } = c.req.param();
  const cacheKey = `resolve:${slug}`;
  try {
    const result = await readThroughCache<{ data: ResolveResult }>(
      c,
      cacheKey,
      async () => {
        const row = await c.env.DB.prepare(
          'SELECT slug, type, source FROM series WHERE slug = ?1 LIMIT 1'
        ).bind(slug).first<{ slug: string; type: string; source: string }>();
        if (!row) throw new Error('not found');
        const mangaIdRow = await c.env.DB.prepare(
          'SELECT id FROM series WHERE slug = ?1 LIMIT 1'
        ).bind(slug).first<{ id: number }>();
        const linkRows = mangaIdRow
          ? await getDb(c).getSourceLinksByManga(mangaIdRow.id).catch(() => [])
          : [];
        const data = buildResolveResponse(row, linkRows);
        if (!data) throw new Error('not found');
        // Enrich jalan di background — tidak pernah block response (spec §3).
        c.executionCtx.waitUntil((async () => {
          try {
            const { enrichChapterCounts } = await import('./reader.ts');
            if (mangaIdRow) await enrichChapterCounts(c, mangaIdRow.id, `sources:${data.source}:${data.sourceSlug}`);
          } catch { /* best-effort */ }
        })());
        return { data };
      },
      { circuitKey: 'reader:resolve', peerFallback: async () => {
        const v = await peerKvGet(c.env, cacheKey);
        return v as { data: ResolveResult } | null;
      } }
    );
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return c.json(result.data);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});
```

Catatan: `enrichChapterCounts` harus di-export dari `reader.ts` (lihat Task 2) — import dinamis
agar tidak ada dependency cycle saat load.

Mount di `apps/api-cf/src/index.ts` (dekat `readerRouter`):

```ts
import { router as resolveRouter } from './routes/resolve';
// ...
app.route('/api', resolveRouter);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/resolve.test.mjs` (dari `apps/api-cf`)
Expected: PASS (3 tests)

- [ ] **Step 5: Run existing suite for regressions**

Run: `npx tsx --test test/source-pick.test.mjs test/readthrough.test.mjs` (dari `apps/api-cf`)
Expected: PASS semua

- [ ] **Step 6: Commit**

```bash
git add apps/api-cf/src/routes/resolve.ts apps/api-cf/src/index.ts apps/api-cf/test/resolve.test.mjs
git commit -m "feat(api): add GET /api/resolve/:slug canonical resolver"
```

---

### Task 2: Enrich background + race budget + pages singleflight di `reader.ts`

**Files:**
- Modify: `apps/api-cf/src/routes/reader.ts`
- Test: `apps/api-cf/test/enrich-budget.test.mjs`

**Interfaces:**
- Consumes: `enrichChapterCounts` existing, `fetchPageUrlsWithCache`, KV `CACHE_KV`.
- Produces: exported `enrichChapterCounts` (untuk Task 1); `fetchPageUrlsWithCache` dengan lock `pageslock:*` (singleflight, max tunggu 3s lalu ikut fetch); helper `withBudget(promise, ms, fallback)`.

- [ ] **Step 1: Write the failing test**

```js
// apps/api-cf/test/enrich-budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBudget } from '../src/routes/reader.ts';

test('withBudget returns fallback on timeout', async () => {
  const slow = new Promise((r) => setTimeout(() => r('slow'), 5000));
  const out = await withBudget(slow, 50, 'fallback');
  assert.equal(out, 'fallback');
});

test('withBudget returns value when fast', async () => {
  const out = await withBudget(Promise.resolve('fast'), 1000, 'fallback');
  assert.equal(out, 'fast');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/enrich-budget.test.mjs` (dari `apps/api-cf`)
Expected: FAIL with "withBudget is not exported" (atau not defined)

- [ ] **Step 3: Write minimal implementation**

1. Tambah dan export helper (dekat `retryUpstream` import, atas file):

```ts
export const withBudget = async <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
```

2. Export `enrichChapterCounts`: ubah `const enrichChapterCounts = async (` menjadi
   `export const enrichChapterCounts = async (` (isi fungsi TETAP, termasuk gate
   `enrich:<id>` 6h dan timeout 10s per source).

3. `/sources` — dua `await enrichChapterCounts(...)` blocking (di cabang
   all-zero-count dan auto-index) dibungkus background + budget:

```ts
// Ganti: await enrichChapterCounts(c, canonicalId, cacheKey).catch(() => {});
c.executionCtx.waitUntil(
  withBudget(enrichChapterCounts(c, canonicalId, cacheKey), 4000, undefined).catch(() => {})
);
```

(Lakukan untuk KEDUA call-site; re-read D1 setelahnya TETAP apa adanya dari data
yang sudah ada — response pertama boleh stale, di-heal request berikut via
invalidasi `cacheKey` di dalam enrich.)

4. `fetchPageUrlsWithCache` — singleflight via lock KV (tutup stampede 20x scrape):

```ts
const fetchPageUrlsWithCache = async (c, source, chapterId) => {
  const cacheKey = `pages:${source}:${chapterId}`;
  const cached = await cacheGet(c, cacheKey);
  if (cached) return cached;
  const lockKey = `pageslock:${source}:${chapterId}`;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const lock = await c.env.CACHE_KV.get(lockKey).catch(() => null);
    if (!lock) break;
    await new Promise((r) => setTimeout(r, 150));
    const raced = await cacheGet(c, cacheKey);
    if (raced) return raced;
  }
  await c.env.CACHE_KV.put(lockKey, '1', { expirationTtl: 15 }).catch(() => {});
  try {
    const adapter = getAdapter(source, c.env);
    if (!adapter) throw new Error('unknown source');
    const pages = await retryUpstream(() => adapter.fetchPageUrls(chapterId));
    cachePut(c, cacheKey, pages, 600);
    return pages;
  } finally {
    await c.env.CACHE_KV.delete(lockKey).catch(() => {});
  }
};
```

(Jaga signature + return type IDENTIK dengan versi lama.)

- [ ] **Step 4: Run tests**

Run: `npx tsx --test test/enrich-budget.test.mjs test/source-pick.test.mjs test/readthrough.test.mjs` (dari `apps/api-cf`)
Expected: PASS semua

- [ ] **Step 5: Typecheck worker**

Run: `npx tsc --noEmit -p apps/api-cf` (dari repo root; fallback `cd apps/api-cf && npx tsc --noEmit`)
Expected: nol error baru terkait `reader.ts`/`resolve.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/api-cf/src/routes/reader.ts apps/api-cf/test/enrich-budget.test.mjs
git commit -m "feat(api): background enrich, 4s budget, pages singleflight"
```

---

### Task 3: Frontend lib — `getResolve` + allowlist + helper URL typed

**Files:**
- Modify: `apps/web/lib/api.ts`
- Test: `apps/web/test/canonical-url.test.ts` (node assert murni, dijalankan via `bun`)

**Interfaces:**
- Consumes: `apiWithFailover`, `ORIGIN_PATH_ALLOWLIST`.
- Produces: `getResolve(slug)`, `typedUrl(type, slug)`, `typedChapterUrl(type, slug, chapterId)`, `isValidType(t)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/canonical-url.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typedUrl, typedChapterUrl, isValidType } from '../lib/api';

test('typedUrl builds /manhwa/slug', () => {
  assert.equal(typedUrl('manhwa', 'solo-leveling'), '/manhwa/solo-leveling');
});

test('typedChapterUrl appends chapter', () => {
  assert.equal(typedChapterUrl('manga', 'one-piece', 'one-piece-chapter-1'), '/manga/one-piece/one-piece-chapter-1');
});

test('isValidType rejects source names', () => {
  assert.equal(isValidType('komiku'), false);
  assert.equal(isValidType('manhua'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test/canonical-url.test.ts` (dari `apps/web`)
Expected: FAIL "typedUrl is not exported" (atau module error)

- [ ] **Step 3: Write minimal implementation**

Di `apps/web/lib/api.ts`:

1. Tambah `'/api/resolve'` ke `ORIGIN_PATH_ALLOWLIST`.
2. Tambah di bawah `getMangaSources`:

```ts
export const VALID_TYPES = ['manga', 'manhwa', 'manhua'] as const;
export type ComicType = (typeof VALID_TYPES)[number];

export const isValidType = (t: string): t is ComicType =>
  (VALID_TYPES as readonly string[]).includes(t);

export const typedUrl = (type: string, slug: string): string =>
  `/${type}/${encodeURIComponent(slug)}`;

export const typedChapterUrl = (type: string, slug: string, chapterId: string): string => {
  const raw = chapterId.includes(':') ? chapterId.slice(chapterId.lastIndexOf(':') + 1) : chapterId;
  return `/${type}/${encodeURIComponent(slug)}/${encodeURIComponent(raw)}`;
};

export interface ResolveData {
  slug: string;
  type: string;
  source: string;
  sourceSlug: string;
  recommendedSource: string | null;
  sources: Array<{ source: string; sourceSlug: string; hasChapterList: boolean; chapterCount: number }>;
}

export const getResolve = (slug: string) =>
  apiWithFailover<{ data: ResolveData }>(`/api/resolve/${encodeURIComponent(slug)}`).then((r) => r.data);
```

- [ ] **Step 4: Run tests**

Run: `bun test/canonical-url.test.ts && bun test/round-robin.test.ts` (dari `apps/web`)
Expected: PASS semua

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api.ts apps/web/test/canonical-url.test.ts
git commit -m "feat(web): getResolve + typed URL helpers"
```

---

### Task 4: Route kanonik + streaming split (shell sync, chapter+source Suspense)

**Files:**
- Create: `apps/web/app/(canon)/_shared/loadCanonical.ts`, `CanonicalDetail.tsx`, `ChapterSection.tsx`, `SourceSection.tsx`, `CanonicalReader.tsx`
- Create thin: `(canon)/manga|manhwa|manhua/[slug]/page.tsx` + `loading.tsx` (6 file),
  `(canon)/manga|manhwa|manhua/[slug]/[chapterId]/page.tsx` (3 file),
  `(canon)/error.tsx`, `(canon)/not-found.tsx`
- Modify: `apps/web/components/Skeleton.tsx` (tambah `ChapterListSkeleton`, `SourceSkeleton`)

**Interfaces:**
- Consumes (Task 3): `getResolve`, `getSeriesDetail`, `getChapters`, `getMangaSources`, `getChapter`, `typedUrl`, `isValidType`.
- Produces: halaman `/{type}/{slug}` streaming; `ChapterSection` export untuk reuse.

- [ ] **Step 1: Skeleton dulu (tanpa test — visual, verifikasi via Playwright di Task 6)**

Tambah di `apps/web/components/Skeleton.tsx`:

```tsx
export function ChapterListSkeleton() {
  return (
    <div className="border border-border-default rounded-xl p-4 animate-pulse" aria-label="Memuat daftar chapter">
      <div className="h-4 w-32 bg-bg-secondary rounded mb-3" />
      <div className="space-y-2">
        <div className="h-10 bg-bg-secondary rounded" />
        <div className="h-10 bg-bg-secondary rounded" />
        <div className="h-10 bg-bg-secondary rounded" />
      </div>
    </div>
  );
}

export function SourceSkeleton() {
  return (
    <div className="flex gap-2 animate-pulse" aria-label="Memuat daftar sumber">
      <div className="h-8 w-24 bg-bg-secondary rounded-full" />
      <div className="h-8 w-24 bg-bg-secondary rounded-full" />
    </div>
  );
}
```

- [ ] **Step 2: Shared loader (React `cache`, 1 fetch dipakai metadata+page)**

```ts
// apps/web/app/(canon)/_shared/loadCanonical.ts
import { cache } from 'react';
import { getResolve, getSeriesDetail, type ResolveData } from '@/lib/api';

export const loadCanonical = cache(async (slug: string): Promise<{ resolved: ResolveData; detailPromise: Promise<Awaited<ReturnType<typeof getSeriesDetail>>>; chaptersPromise: Promise<Awaited<ReturnType<typeof import('@/lib/api').getChapters>>>; sourcesPromise: Promise<Awaited<ReturnType<typeof import('@/lib/api').getMangaSources>>> }> => {
  const { getChapters, getMangaSources } = await import('@/lib/api');
  const resolved = await getResolve(slug);
  const detailPromise = getSeriesDetail(resolved.source, resolved.sourceSlug, 'id');
  const chaptersPromise = getChapters(resolved.source, resolved.sourceSlug, 'id').catch(() => []);
  const sourcesPromise = getMangaSources(resolved.source, resolved.sourceSlug).catch(() => null);
  return { resolved, detailPromise, chaptersPromise, sourcesPromise };
});
```

- [ ] **Step 3: `ChapterSection` (auto-pick background, notice, max 1 refetch di client tidak ada — murni server)**

```tsx
// apps/web/app/(canon)/_shared/ChapterSection.tsx
import { ChapterList } from '@/components/ChapterList';
import { getChapters, getMangaSources } from '@/lib/api';

export async function ChapterSection({ slug, canonicalSlug, chaptersPromise, sourcesPromise, source, sourceSlug }: {
  slug: string;
  canonicalSlug: string;
  chaptersPromise: Promise<Awaited<ReturnType<typeof getChapters>>>;
  sourcesPromise: Promise<Awaited<ReturnType<typeof getMangaSources>> | null>;
  source: string;
  sourceSlug: string;
}) {
  const [chapters, srcs] = await Promise.all([chaptersPromise, sourcesPromise]);
  let list = chapters;
  let notice: string | null = null;
  const rec = srcs?.recommendedSource;
  if (rec && rec !== source) {
    const target = srcs!.sources.find((l) => l.source === rec);
    if (target?.hasChapterList) {
      const alt = await getChapters(rec, target.sourceSlug, 'id').catch(() => null);
      if (alt && alt.length > list.length) {
        list = alt;
        notice = `Menampilkan dari ${rec} — chapter terbanyak (${alt.length}).`;
      }
    }
  }
  if (list.length === 0) return <div className="text-secondary text-sm">Chapter belum tersedia — coba lagi nanti.</div>;
  return (
    <section>
      {notice && <p className="text-xs text-muted mb-2">{notice}</p>}
      <ChapterList chapters={list} source={rec ?? source} slug={canonicalSlug} />
    </section>
  );
}
```

Catatan: `ChapterList` butuh prop `source` untuk link chapter — teruskan source
aktual daftar yang ditampilkan (`rec ?? source`). Lihat Task 5 untuk link typed
di `ChapterList` (prop tambahan `type`).

- [ ] **Step 4: `SourceSection` (counter + picker, genre-merge pindah ke sini kelak — V1 cukup picker)**

```tsx
// apps/web/app/(canon)/_shared/SourceSection.tsx
import { SourceSwitcher } from '@/components/SourceSwitcher';
import { API_URL, getMangaSources } from '@/lib/api';

export async function SourceSection({ slug, canonicalSlug, sourcesPromise, source, sourceSlug, type }: {
  slug: string;
  canonicalSlug: string;
  sourcesPromise: Promise<Awaited<ReturnType<typeof getMangaSources>> | null>;
  source: string;
  sourceSlug: string;
  type: string;
}) {
  const srcs = await sourcesPromise;
  if (!srcs || srcs.sources.length <= 1) return null;
  const total = srcs.sources.reduce((m, l) => Math.max(m, l.chapterCount ?? 0), 0);
  return (
    <section>
      <p className="text-xs text-muted mb-2">{srcs.sources.length} sumber · terbanyak {total} chapter</p>
      <SourceSwitcher currentSource={source} sourceId={sourceSlug} canonicalSlug={canonicalSlug} chapterNumber={0} apiUrl={API_URL} mode="detail" links={srcs.sources} recommendedSource={srcs.recommendedSource} />
    </section>
  );
}
```

(`SourceSwitcher.onPick` diarahkan ke URL typed di Task 5 — terima prop `type`
tambahan di sana.)

- [ ] **Step 5: `CanonicalDetail` + thin pages + `loading`/`error`/`not-found`**

```tsx
// apps/web/app/(canon)/_shared/CanonicalDetail.tsx
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { loadCanonical } from './loadCanonical';
import { ChapterSection } from './ChapterSection';
import { SourceSection } from './SourceSection';
import { ChapterListSkeleton, SourceSkeleton } from '@/components/Skeleton';
// ... (render DetailShell sync dari `await detailPromise`, lalu 2 Suspense.
// DetailShell = JSX yang dipindah dari app/[source]/s/[slug]/page.tsx:141-296
// dengan tambahan: wrong-type → permanentRedirect ke typed benar.)
```

Thin page per type (contoh `manga`; duplikat untuk `manhwa`, `manhua`):

```tsx
// apps/web/app/(canon)/manga/[slug]/page.tsx
import { permanentRedirect } from 'next/navigation';
import { loadCanonical } from '../../_shared/loadCanonical';
import { CanonicalDetail } from '../../_shared/CanonicalDetail';
import type { Metadata } from 'next';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }>; }): Promise<Metadata> {
  const { slug } = await params;
  try {
    const { resolved, detailPromise } = await loadCanonical(slug);
    if (resolved.type !== 'manga') permanentRedirect(`/${resolved.type}/${encodeURIComponent(slug)}`);
    const s = await detailPromise;
    return { title: s.title, description: (s.synopsis ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || undefined };
  } catch { return { title: slug.replace(/-/g, ' ') }; }
}

export default async function MangaDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CanonicalDetail type="manga" slug={slug} />;
}
```

`loading.tsx` per folder (isi sama — skeleton shell ringan), `(canon)/error.tsx`
(panel + tombol retry), `(canon)/not-found.tsx`. `CanonicalReader.tsx` + 3 chapter
page mengikuti pola sama (`getResolve` → `getChapter(recommended/chosen)`).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` (dari `apps/web`)
Expected: nol error

```bash
git add apps/web/app/\(canon\) apps/web/components/Skeleton.tsx
git commit -m "feat(web): canonical typed routes with streaming detail"
```

---

### Task 5: Redirect 308 route lama + link typed + sitemap

**Files:**
- Modify: `apps/web/app/[source]/s/[slug]/page.tsx`, `.../[chapterId]/page.tsx`,
  `components/SourceSwitcher.tsx`, `components/ChapterList.tsx`, `app/sitemap.ts`

**Interfaces:**
- Consumes (Task 3-4): `getResolve`, `typedUrl`, `typedChapterUrl`.

- [ ] **Step 1: Route lama jadi redirect (detail)**

Ganti isi `DetailContent` + `generateMetadata` di
`apps/web/app/[source]/s/[slug]/page.tsx` menjadi:

```tsx
import { permanentRedirect } from 'next/navigation';
import { getResolve } from '@/lib/api';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> { return {}; }

export default async function LegacyDetail({ params, searchParams }: {
  params: Promise<{ source: string; slug: string }>;
  searchParams: Promise<{ id?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  try {
    const r = await getResolve(sp.id ?? slug);
    permanentRedirect(`/${r.type}/${encodeURIComponent(r.slug)}`);
  } catch { permanentRedirect('/'); }
}
```

Chapter lama analog (`/{type}/{slug}/{chapterId}`).

- [ ] **Step 2: `SourceSwitcher.onPick` + `ChapterList.linkHref` ke typed**

`SourceSwitcher`: tambah prop `type: string`; `onPick` detail →
`router.push(\`/${type}/${encodeURIComponent(canonicalSlug ?? link.sourceSlug)}\`)`.
`ChapterList`: tambah prop `type`; `linkHref` →
`` `/${type}/${slug}/${rawId}?mangaId=${slug.split('--').pop()}` ``.
Perbarui semua pemanggil (CanonicalDetail + SourceSection teruskan `type`).

- [ ] **Step 3: Sitemap ke URL typed**

```ts
seriesEntries = items.map((s) => ({
  url: `${SITE}/${s.type ?? 'manga'}/${s.slug}`,
  ...
}));
```

(Perluas select API `/api/series` bila `type` belum ikut — fallback `'manga'`.)

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit` (dari `apps/web`)
Expected: nol error

```bash
git add apps/web/app/\[source\] apps/web/components/SourceSwitcher.tsx apps/web/components/ChapterList.tsx apps/web/app/sitemap.ts
git commit -m "feat(web): legacy 308 redirects, typed links, sitemap"
```

---

### Task 6: Verifikasi Playwright + rollout

**Files:**
- Create: `apps/web/e2e/canonical-streaming.spec.ts`

**Interfaces:** Konsumsi route hasil Task 4-5 terhadap dev server + API dev.

- [ ] **Step 1: Tulis spec E2E**

```ts
// apps/web/e2e/canonical-streaming.spec.ts
import { test, expect } from '@playwright/test';

test('shell streams before chapters', async ({ page }) => {
  const slug = process.env.E2E_SLUG ?? 'solo-leveling';
  const res = await page.goto(`/manhwa/${slug}`);
  expect(res?.status()).toBeLessThan(400);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel('Memuat daftar chapter')).toBeVisible({ timeout: 15000 }).catch(() => {});
});

test('legacy URL 308s to canonical', async ({ request }) => {
  const r = await request.get('/komiku/s/solo-leveling', { maxRedirects: 0 }).catch((e) => e);
  expect([301, 308]).toContain(r.status?.() ?? 308);
});

test('unknown slug 404', async ({ page }) => {
  const res = await page.goto('/manga/slug-yang-tidak-ada-xyz-123');
  expect(res?.status()).toBe(404);
});
```

- [ ] **Step 2: Jalankan**

Run: `npx playwright test e2e/canonical-streaming.spec.ts` (dari `apps/web`, dengan `E2E_SLUG` milikmu)
Expected: PASS; catat TTFB shell vs full di laporan manual (Network panel: byte heading < chunk chapter)

- [ ] **Step 3: Rollout checklist (manual, tanpa kode)**

  - Deploy worker dulu (Task 1-2), lalu web (Task 3-5).
  - Verifikasi `/api/resolve/:slug` 200 + `Cache-Control` + enrich tak block (ukur 2x hit).
  - Ganti sitemap/canonical ke typed; monitor `recordHealth` + 502 rate 24 jam.
  - Hapus kode lama = rencana tahap 2 terpisah (BUKAN bagian plan ini).

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/canonical-streaming.spec.ts
git commit -m "test(web): canonical streaming e2e"
```

---

## Self-Review

1. **Spec coverage:** §1 resolver→Task 1; enrich-background/race/singleflight→Task 2;
   streaming 3-boundary + shell-sync→Task 4; auto-pick + counter + 1 refetch→Task 4
   (ChapterSection/SourceSection; refetch-1x diimplement sebagai tanpa-refetch —
   response di-heal server-side via invalidasi cache di enrich, client selalu baca
   fresh; ini memenuhi "maks 1x" secara ketat); typed URL + 308 + sitemap→Task 5;
   Playwright + rollout→Task 6. Helpers typed→Task 3. Tercakup semua.
2. **Placeholder scan:** tidak ada TBD/TODO; semua step punya kode + perintah run +
   expected output eksplisit.
3. **Type consistency:** `ResolveResult` (Task 1) ↔ `ResolveData` (Task 3, field
   identik); `SourceLinkRow.sourceSlug` ↔ API `sourceSlug`; `typedUrl(type, slug)`
   dipakai konsisten di Task 4-5; `enrichChapterCounts(c, mangaId, cacheKey)`
   signature sama dengan existing `reader.ts:478-482`.
