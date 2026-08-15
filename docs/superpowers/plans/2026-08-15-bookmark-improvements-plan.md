# Bookmark Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task with checkpoint reviews.

**Goal:** Make bookmarks multi-source aware (store `source` + `source_url`), add bookmark toggle to MangaCard (homepage/search) so users can "add komik ke bookmark" anywhere, improve the bookmark page (empty state, newest-first sort, clear-all), and rate-limit mutating bookmark endpoints.

**Architecture:** One D1 migration adds columns to `bookmarks`; Worker API returns the resolved source per bookmark row + applies an in-memory 60/hour limiter on POST/DELETE; frontend MangaCard gains an optional BookmarkButton overlay, bookmark page renders empty state + sort + clear-all. KV cache for the bookmarks list is invalidated on mutate.

**Tech Stack:** Cloudflare Workers (Hono), D1 SQLite, KV (edge cache), Next.js 14 Pages (edge runtime). Existing `bookmark` DB helpers in `packages/db/index.ts`, existing `BookmarkButton` component, existing `makeLimiter` factory in `lib/rateLimit.ts`.

## Global Constraints

- `bookmarks` rows = existing PK `(user_id, series_slug)`; add nullable `source` + `source_url` (never break existing rows).
- Mutating routes rate limit = `makeLimiter(60, 3600)` (60/hour per IP), applied AFTER `requireSession`.
- KV cache key for list = `bookmarks:user:{uid}` TTL 600s; invalidate on POST/DELETE by deleting the key (`cachePut(c, key, null, 0)` or direct `c.env.CACHE_KV.delete(key)`).
- Frontend BookmarkButton on MangaCard uses `getAuthApiUrl()` + `credentials:'include'` (auth cookie origin mismatch rule unchanged).
- Migration must be backward-compatible (ALTER TABLE ADD COLUMN, no NOT NULL without default).
- Worker max request duration 30s — keep DB operations fast; do not chain >1 extra query in list SELECT.
- Deploy to 3 Worker accounts + Pages (per `.opencode/skills/manga/SKILL.md` section 7).

---

### Task 1: DB migration — add source columns to bookmarks

**Files:**
- Create: `packages/db/migrations/0010_bookmark_source.sql`
- Modify: `packages/db/schema.sql` (add columns for local parity — NOT for prod, which uses migrations)
- Test: (none — D1 migrations are SQL only; verified via `smoke-db`)

**Interfaces:**
- Consumes: none
- Produces: `bookmarks.source TEXT`, `bookmarks.source_url TEXT`, index `idx_bookmarks_source`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Add original source attribution to bookmarks so a bookmark can point at
-- the specific source (komiku/bacakomik/thrive/manhwaindo) the user
-- bookmarked, instead of only the canonical slug. Backward compatible:
-- existing rows get NULL and are resolved to 'komiku' by convention.
ALTER TABLE bookmarks ADD COLUMN source     TEXT;
ALTER TABLE bookmarks ADD COLUMN source_url TEXT;
CREATE INDEX idx_bookmarks_source ON bookmarks (source, created_at DESC);
```

- [ ] **Step 2: Run smoke test against local + remote D1**

Local:
```bash
npx wrangler d1 execute manga-db --local --file=packages/db/migrations/0010_bookmark_source.sql
```
Remote (after deploy):
```bash
export CLOUDFLARE_API_TOKEN="$CF_TOKEN_AKUN1"; export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID_AKUN2"
npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0010_bookmark_source.sql
```

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations/0010_bookmark_source.sql
git commit -m "db: add source + source_url to bookmarks (0010)"
```

### Task 2: Worker DB helpers + API route — multi-source bookmark payload

**Files:**
- Modify: `packages/db/index.ts` (add `addBookmark` with source, update bookmark list SELECT)
- Modify: `apps/api-cf/src/routes/user.ts` (POST/GET/DELETE bookmark, rate limit middleware)
- Modify: `apps/api-cf/src/lib/rateLimit.ts` (export `rateLimitMutate`)
- Modify: `apps/api-cf/src/lib/context.ts` (helper to invalidate KV cache key)

**Interfaces:**
- Consumes: `bookmarks` columns `source`/`source_url` (Task 1), `makeLimiter` factory.
- Produces: `db.addBookmark({ userId, seriesSlug, source?, source_url? })`; `rateLimitMutate` (60/3600); `GET /api/user/bookmarks` returns `source`/`source_url`/`created_at` per row.

- [ ] **Step 1: Add DB helpers in `packages/db/index.ts`**

Existing `addBookmark`:
```ts
addBookmark: async ({ userId, seriesSlug }: { userId: number; seriesSlug: string }): Promise<{ ok: boolean }> => {
  const res = await prep('INSERT OR IGNORE INTO bookmarks (user_id, series_slug) VALUES (?1, ?2)')
    .bind(userId, seriesSlug).run();
  ...
}
```
Update signature + SQL to accept optional `source`/`source_url`:
```ts
addBookmark: async ({ userId, seriesSlug, source, source_url }: {
  userId: number; seriesSlug: string; source?: string; source_url?: string;
}): Promise<{ ok: boolean }> => {
  const res = await prep(
    'INSERT OR IGNORE INTO bookmarks (user_id, series_slug, source, source_url) VALUES (?1, ?2, ?3, ?4)'
  ).bind(userId, seriesSlug, source ?? null, source_url ?? null).run();
  return { ok: res.success };
},
```

Update `listBookmarks` SELECT to include new cols + `created_at`:
```ts
const res = await prep(`
  SELECT s.slug, s.title, s.cover_image, s.source, b.source AS bookmark_source,
         b.source_url AS bookmark_url, b.created_at
  FROM bookmarks b
  JOIN series s ON s.slug = b.series_slug
  WHERE b.user_id = ?1
  ORDER BY b.created_at DESC
`).bind(userId).all<Row>();
```
Return shape `{ slug, title, cover_image, source, bookmark_source, bookmark_url, created_at }`.

- [ ] **Step 2: Add `rateLimitMutate` to `lib/rateLimit.ts`**

```ts
export const rateLimitMutate: MiddlewareHandler<{ Bindings: Env }> = makeLimiter(60, 3600);
```

- [ ] **Step 3: Apply to `routes/user.ts`**

```ts
router.use('/bookmark', requireSession, rateLimitMutate);
router.use('/bookmark/:slug', requireSession, rateLimitMutate);
router.use('/bookmarks', requireSession, rateLimitMutate);
```

Update POST `body` parsing:
```ts
const { seriesSlug, source, source_url } = body;
await db(c.env.DB).addBookmark({ userId: user.id, seriesSlug, source, source_url });
```
Invalidate KV cache: add helper in `lib/context.ts`:
```ts
export const invalidateBookmarksCache = (c: Context, uid: number): void => {
  c.env.CACHE_KV.delete(`bookmarks:user:${uid}`).catch(() => {});
};
```
Call after add/remove/clear-all.

- [ ] **Step 4: Write smoke test `scripts/smoke-user.mjs`** — add bookmark with source, list, verify fields, delete. (Reuse existing smoke infrastructure.)

- [ ] **Step 5: Build bundle + deploy 3 Worker accounts**

```bash
node scripts/build-worker-bundle.mjs
# akun-1/2/3 deploy (see SKILL.md section 7)
# Run remote migration 0010 on each of 3 D1 DBs
```

### Task 3: Frontend BookmarkButton on MangaCard + homepage/search

**Files:**
- Modify: `apps/web/components/MangaCard.tsx` (add optional `bookmarkable` prop + overlay button)
- Modify: `apps/web/app/page.tsx` (pass `bookmarkable={true}` to Populer + Update Terbaru cards)
- Modify: `apps/web/app/search/page.tsx` (pass `bookmarkable={true}`; pass `source`)
- Test: playwright snapshot — homepage cards show bookmark toggle; guest click → /login

**Interfaces:**
- Consumes: existing `BookmarkButton` (`apps/web/components/BookmarkButton.tsx`).
- Produces: MangaCard with overlay button; bookmarks save with `source` context.

- [ ] **Step 1: Update `MangaCard.tsx`**

```tsx
export function MangaCard({ manga, source = 'komiku', sources, status, type, bookmarkable = false, bookmarkSlug }: {...}) {
  ...
  {bookmarkable && <BookmarkButton slug={bookmarkSlug ?? manga.slug} size="sm" />}
}
```
Overlay positioned `absolute top-2 right-2` inside the aspect-[3/4] container (`position: relative` already set). Use existing `BookmarkButton` styled for `size="sm"`.

Add `size` prop to BookmarkButton (small 36x36). 

- [ ] **Step 2: Wire homepage** — `app/page.tsx` Populer loop + Update Terbaru: `<MangaCard ... bookmarkable={true} />`.

- [ ] **Step 3: Wire search** — `app/search/page.tsx`: each item `<MangaCard bookmarkable={true} />`.

- [ ] **Step 4: Build + deploy Pages**

```bash
cd apps/web && rm -rf .next .vercel && <env vars> npx next-on-pages && wrangler pages deploy ...
```

### Task 4: Bookmark page — empty state, sort, clear-all

**Files:**
- Modify: `apps/web/app/bookmark/page.tsx` (empty state, sort confirmation server-side, Clear All button)
- Test: playwright — 0 bookmarks shows empty state; Clear All confirms + clears.

**Interfaces:**
- Consumes: `GET /api/user/bookmarks` shape from Task 2 (with `created_at`).

- [ ] **Step 1: Empty state** — when `items.length === 0 && !error`:
```tsx
<div className="text-center py-12">
  <BookmarkIcon .../>
  <p className="text-secondary">Belum ada bookmark.</p>
  <Link href="/search">Cari manga</Link>
</div>
```

- [ ] **Step 2: Clear All button** — `DELETE /api/user/bookmarks` via ConfirmModal (reuse `components/ConfirmModal.tsx`):
```tsx
<button onClick={() => confirmClear()}>Clear all</button>
```

- [ ] **Step 3: Sort** — server returns `created_at DESC` already (Task 2 SELECT). Show `relativeTime` next to title (e.g. "ditambahkan 2h lalu").

- [ ] **Step 4: Build + deploy**

### Task 5: Verify via Playwright + smoke

- [ ] Homepage cards render BookmarkButton (sm) — no click needed for guest.
- [ ] `/bookmark` empty state renders copy + "Cari manga" link.
- [ ] Rate limit: 60 POST/hit → 429 `Retry-After`.
- [ ] `smoke-user.mjs`: add + list + remove + clear-all returns ok.
- [ ] Worker logs: `recordHealth` source-status 200.

---

## Rollback

- Migration: `ALTER TABLE bookmarks DROP COLUMN source;` / `DROP COLUMN source_url;` / `DROP INDEX idx_bookmarks_source;` — D1 supports DROP COLUMN now.
- Worker: revert route changes — `bookmarks` LISTA SELECT ignores new cols (forward-compatible if dropped).
- Front: remove `bookmarkable` prop usage, revert MangaCard.
