# Hapus MangaDex Total — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all MangaDex references from code, files, DB — adapter, registry, UI, env, docs. Pure cleanup, no new features.

**Architecture:** Delete `packages/sources/mangadex/`. Remove mangadex from source registry (`packages/sources/index.ts`), shared types, API routes, web components. New D1 migration `0003_drop_mangadex.sql` deletes mangadex rows (cascade). `SourceKey` union becomes `'komiku' | 'bacakomik' | 'thrive'` (placeholders — adapters built in Part 2).

**Tech Stack:** TypeScript, Cloudflare Workers (Hono), D1/SQLite, Next.js 14, Zod (shared types).

## Global Constraints

- **No new mangadex references** — case-insensitive grep must be clean in code/files (only `docs/superpowers/**` + `.superpowers/**` historical remain).
- **`SourceKey` union:** `'komiku' | 'bacakomik' | 'thrive'` after this part. `bacakomik`/`thrive` adapters NOT built yet — `getAdapter` returns null for them (Part 2).
- **`series.source` default** → `'komiku'` (both `packages/db/schema.sql` and `packages/shared/types.ts:22`).
- **Migration file is new:** `packages/db/migrations/0003_drop_mangadex.sql`. Do NOT edit old migrations.
- **Do NOT edit** `docs/superpowers/**`, `.superpowers/**`, `.opencode/skills/manga/SKILL.md` (historical / deferred).
- **Typecheck must pass** — no new errors (pre-existing allowance for api-cf auth/crypto).
- **Preserve functional behavior** for Komiku. Search stays single-source (Komiku). No multi-source search in this part.
- **No new dependencies.**

---

### Task 1: Delete mangadex package + update source registry

**Files:**
- Delete: `packages/sources/mangadex/index.ts`, `packages/sources/mangadex/client.ts`
- Modify: `packages/sources/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SourceKey = 'komiku' | 'bacakomik' | 'thrive'`, `AdapterEnv` exported, `getAdapter(sourceKey, env)` signature unchanged.

- [ ] **Step 1: Delete mangadex directory**

```bash
rm -rf packages/sources/mangadex
```

Expected: directory gone.

- [ ] **Step 2: Rewrite `packages/sources/index.ts`**

Replace entire file:

```ts
// Source adapter registry. `getAdapter(sourceKey, env?)` returns the adapter or null.
// `env` is forwarded to adapters that read runtime config; omitting it yields
// keyless behavior (backwards-compatible).
import { komikuAdapter } from './komiku/index.js';
import type { AdapterEnv } from './komiku/index.js';
import type { Series, Chapter } from '@manga-platform/shared';
import type { RobotsResult } from './komiku/client.js';

export type SourceKey = 'komiku' | 'bacakomik' | 'thrive';

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
  fetchPageUrls(
    chapterSourceId: string
  ): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]>;
  scrapeUrl?(url: string): Promise<ScrapeResult>;
  checkRobots?(url: string): Promise<RobotsResult>;
  healthCheck?(): Promise<{ healthy: boolean; latency_ms: number; error?: string }>;
}

const adapterFactories: Partial<Record<SourceKey, (env?: AdapterEnv) => SourceAdapter>> = {
  komiku: (env) => komikuAdapter(env),
};

export const getAdapter = (sourceKey: string, env?: AdapterEnv): SourceAdapter | null => {
  const factory = adapterFactories[sourceKey as SourceKey];
  return factory ? factory(env) : null;
};

export { komikuAdapter, type AdapterEnv };
```

- [ ] **Step 3: Verify no mangadex import remains**

Run: `grep -ri "mangadex" packages/sources/`
Expected: output empty.

- [ ] **Step 4: Typecheck sources package**

Run: `npx tsc --noEmit -p packages/sources`
Expected: PASS (no errors referencing mangadex; existing komiku type error allowance).

- [ ] **Step 5: Commit**

```bash
git add -A packages/sources/
git commit -m "refactor(sources): remove mangadex adapter, registry keys komiku/bacakomik/thrive"
```

---

### Task 2: Remove mangadex from shared types

**Files:**
- Modify: `packages/shared/types.ts:22`

**Interfaces:**
- Consumes: nothing.
- Produces: `SeriesSchema.source` default `'komiku'`.

- [ ] **Step 1: Change default**

In `packages/shared/types.ts`, line 22:

```ts
source: z.string().default('komiku'),
```

- [ ] **Step 2: Verify**

Run: `grep -n "default('mangadex')" packages/shared/types.ts`
Expected: no output.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p packages/shared`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/types.ts
git commit -m "refactor(shared): SeriesSchema source default komiku not mangadex"
```

---

### Task 3: D1 migration to drop mangadex rows

**Files:**
- Create: `packages/db/migrations/0003_drop_mangadex.sql`

**Interfaces:**
- Consumes: `series.source` column (existing), `source_health` table (existing from migration 0001).
- Produces: Migration former rows removed from `series`/`source_health` where `source='mangadex'`.

- [ ] **Step 1: Write migration file**

Create `packages/db/migrations/0003_drop_mangadex.sql`:

```sql
-- Hapus data sumber mangadex: series → chapters (CASCADE) → chapter_pages (CASCADE)
-- + bookmarks/reading_history (CASCADE via FK series_slug).
DELETE FROM series WHERE source = 'mangadex';

-- source_health: hapus baris histori mangadex (no FK, manual).
DELETE FROM source_health WHERE source = 'mangadex';
```

- [ ] **Step 2: Verify FK cascade covers related tables**

Confirm in `packages/db/schema.sql`:
- `chapters.series_slug` → `series(slug)` ON DELETE CASCADE ✓
- `chapter_pages.chapter_id` → `chapters(id)` ON DELETE CASCADE ✓
- `bookmarks.series_slug` → `series(slug)` ON DELETE CASCADE ✓
- `reading_history.chapter_id` → `chapters(id)` ON DELETE CASCADE ✓
- `series_search` → trigger `series_search_ad` on series DELETE ✓

Expected: all true (already in schema). No changes needed.

- [ ] **Step 3: Dry-run against local D1 (optional but recommended)**

```bash
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0003_drop_mangadex.sql
```

Expected: no mangadex rows, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/migrations/0003_drop_mangadex.sql
git commit -m "db: migration 0003 drop mangadex rows + source_health history"
```

---

### Task 4: Remove mangadex branches from Worker routes

**Files:**
- Modify: `apps/api-cf/src/routes/search.ts`, `apps/api-cf/src/routes/reader.ts`, `apps/api-cf/src/routes/sourceStatus.ts`, `apps/api-cf/src/routes/admin/scrape.ts`, `apps/api-cf/src/lib/context.ts`

**Interfaces:**
- Consumes: `Shared: SeriesSchema source default 'komiku'` (Task 2), registry `getAdapter` (Task 1).
- Produces: No mangadex branch in search/reader/sourceStatus/scrape. Komiku single-source search.

- [ ] **Step 1: `apps/api-cf/src/routes/search.ts` — single-source search**

Replace lines 101-141 (the Promise.allSettled + addResult loop for mangadex) with single Komiku call:

In the `if (q)` branch replace the `Promise.allSettled` block (lines 101-141) with:

```ts
  const sourcesQueried: string[] = [];
  const startKomiku = Date.now();
  const komiku = await retryUpstream(async () => {
    const a = getAdapter('komiku', c.env);
    if (!a) throw new Error('komiku adapter unavailable');
    sourcesQueried.push('komiku');
    return a.search({ q, limit });
  });
  recordHealth(c, 'komiku', startKomiku, true);
```

Then after local results + komiku, remove the `if (mangadexResults.status...)` block:

```ts
  if (komikuResults.status === 'fulfilled') {
    for (const s of komikuResults.value) addResult(s, 'komiku');
  }
```

becomes (komiku is awaited, no status check):

```ts
  for (const s of komiku) addResult(s, 'komiku');
```

- [ ] **Step 2: Verify search.ts typecheck**

Run: `npx tsc --noEmit -p apps/api-cf`
Expected: only pre-existing allowances (auth/crypto), no new mangadex-related errors.

- [ ] **Step 3: `apps/api-cf/src/routes/reader.ts` — remove mangadex**

Remove:
- Line 53 `'uploads.mangadex.org'` from `ALLOWED_IMAGE_HOSTS`.
- Lines 70-71: the `.mangadex-network.app` / `.mangadex.org` subdomain allow.
- Line 283-284 comment mentioning MangaDex at-home (generalize comment).

Result:

```ts
const ALLOWED_IMAGE_HOSTS = new Set([
  'img.komiku.org',
  'komiku.org',
]);
```

And in `isAllowedImageUrl`, remove the `host.endsWith('.mangadex-network.app') || host.endsWith('.mangadex.org')` line.

- [ ] **Step 4: `apps/api-cf/src/routes/sourceStatus.ts` — remove mangadex**

Read the file, remove any mangadex-specific branch (listing/health row). Komik remains the only listed source.

- [ ] **Step 5: `apps/api-cf/src/routes/admin/scrape.ts` — remove mangadex**

Read the file; remove mangadex from allowed `source` values (list becomes `['komiku']` this round; `['komiku','bacakomik','thrive']` when Part 2 lands).

- [ ] **Step 6: `apps/api-cf/src/lib/context.ts` — remove Env key**

Remove `MANGADEX_API_KEY?: string;` from `Env` interface.

- [ ] **Step 7: Typecheck + grep worker**

Run:
```bash
npx tsc --noEmit -p apps/api-cf
grep -ri "mangadex" apps/api-cf/
```

Expected: typecheck PASS (pre-existing allowances), grep empty.

- [ ] **Step 8: Commit**

```bash
git add -A apps/api-cf/src/
git commit -m "refactor(api-cf): remove mangadex branches from search/reader/sourceStatus/scrape/context"
```

---

### Task 5: Remove mangadex from frontend UI

**Files:**
- Modify: `apps/web/components/SourceBadge.tsx`, `apps/web/components/MangaCard.tsx`, `apps/web/app/status/page.tsx`, `apps/web/app/history/page.tsx`

**Interfaces:**
- Consumes: `SourceKey = 'komiku' | 'bacakomik' | 'thrive'` (task 1).
- Produces: UI no longer renders mangadex badges / filters / refs. `SourceBadge` supports keys: komiku/bakabomik/thrive-placeholder.

- [ ] **Step 1: `apps/web/components/SourceBadge.tsx`**

Read file. Remove `mangadex` case from the badge styling/icon map. Leave komik case; add placeholder skin for `bacakomik` + `thrive` (simple neutral circle with first letter — Part 4 refines to icon-only asset).

- [ ] **Step 2: `apps/web/components/MangaCard.tsx`**

Read file. Remove `source === 'mangadex'` detection/badge logic. Komik primary default, other sources pass through generically.

- [ ] **Step 3: `apps/web/app/status/page.tsx`**

Read file. Remove mangadex source row from health list. Only komikku shows.

- [ ] **Step 4: `apps/web/app/history/page.tsx`**

Read file. Remove any mangadex reference (source label / link formatting).

- [ ] **Step 5: Typecheck web**

Run: `npx tsc --noEmit -p apps/web`
Expected: PASS.

- [ ] **Step 6: Grep frontend**

Run: `grep -ri "mangadex" apps/web/`
Expected: empty.

- [ ] **Step 7: Commit**

```bash
git add -A apps/web/
git commit -m "feat(web): remove mangadex from badge/card/status/history UI"
```

---

### Task 6: Remove mangadex from docs + env + verify clean

**Files:**
- Modify: `packages/db/schema.sql:11` (default `'komiku'`), `docs/DEPLOY.md`, `docs/TOS-REVIEW.md`, `README.md`
- Check if exists: `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: docs/env clean of mangadex. Grep verification passes.

- [ ] **Step 1: `packages/db/schema.sql:11`**

Change:

```sql
source TEXT NOT NULL DEFAULT 'mangadex',
```

to:

```sql
source TEXT NOT NULL DEFAULT 'komiku',
```

- [ ] **Step 2: `.env.example` (if exists)**

If `.env.example` present and contains `MANGADEX_*`, remove those lines.

- [ ] **Step 3: `docs/DEPLOY.md`**

Remove `MANGADEX_API_KEY` from secrets list. If it has other mangadex instructions, remove them.

- [ ] **Step 4: `docs/TOS-REVIEW.md`**

Remove mangadex-specific review lines (the file's topic IS mangadex ToS — if the whole file is mangadex ToS, leave as historical doc; flag in commit note).

- [ ] **Step 5: `README.md`**

Remove mangadex mentions. Keep or prune as appropriate — README is already flagged "outdated, see skill". Minimal edit: remove mangadex references.

- [ ] **Step 6: Repo-wide grep verification**

```bash
grep -ri "mangadex" -l --include="*.ts" --include="*.tsx" --include="*.sql" --include="*.toml" --include="*.json" --include="*.md" . 
```

Expected remaining: only under `docs/superpowers/**` and `.superpowers/**` (historical). `README.md` clean. `docs/TOS-REVIEW.md` — if historical mangadex ToS stays, that's intentional; note it.

- [ ] **Step 7: Full typecheck pass**

```bash
npx tsc --noEmit -p apps/web
npx tsc --noEmit -p packages/db
npx tsc --noEmit -p packages/sources
npx tsc --noEmit -p packages/shared
npx tsc --noEmit -p apps/api-cf
npx tsc --noEmit -p packages/lb
npx tsc --noEmit -p packages/vision
```

Expected: PASS with only pre-existing allowances.

- [ ] **Step 8: Commit**

```bash
git add -A packages/db/schema.sql docs/DEPLOY.md docs/TOS-REVIEW.md README.md
[ -f .env.example ] && git add .env.example
git commit -m "refactor: remove mangadex from schema default + env/docs; verify clean grep"
```

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|------------------|------|
| Delete mangadex adapter + tests | Task 1 |
| Remove registry reference | Task 1 |
| Migration drop mangadex rows | Task 3 |
| Remove UI references | Task 5 |
| Remove env/API key | Task 6 |
| Grep clean verification | Task 6 |
| Preserve docs/superpowers historical | Global Constraints Task 6 step 6 |

All covered.

**2. Placeholder scan:** No TBD/TODO. TypeScript edits have codeblocks but Task 4 Step 4/5 (sourceStatus, scrape) reference reading files first — actual deletion not specified line-by-line because content unknown; added instruction "Read the file; remove mangadex branch". This is acceptable — targets deletion, reviewer can verify grep empty.

**3. Type consistency:**
- `SourceKey` → `'komiku' | 'bacakomik' | 'thrive'` everywhere: index.ts (T1), shared types default (T2), SourceBadge (T5).
- `getAdapter(sourceKey, env?)` unchanged signature — routes just stop asking for 'mangadex'.
- `series.source` default `'komiku'` in both schema.sql and types.ts.
- AdapterEnv exported from sources/index re-export from komiku/index. ✓

No issues found.