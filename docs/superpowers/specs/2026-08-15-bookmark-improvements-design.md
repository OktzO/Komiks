# Bookmark Improvements — Design Spec

Date: 2026-08-15
Status: approved

## TL;DR

Make bookmarks multi-source aware and spam-resistant:
- Store the original `source` + `source_url` when bookmarking so the bookmark
  points to a specific source (not just the canonical slug).
- `/api/user/bookmarks` returns the original source per row; the page resolves
  live series detail (cover/title/type) via `/api/reader/{source}/series/{id}`
  with KV fallback (1h) so the bookmark grid shows the right cover even when the
  original source is the healthy one.
- Empty state, sort by newest-first, "Clear all" button.
- Add BookmarkButton to MangaCard (homepage + search grid) so "add komik ke
  bookmark" works from anywhere — guest click → `/login`.
- Rate-limit the destructive mutate endpoints (POST/DELETE bookmark) with an
  in-memory limiter: **60/hour per IP+user** (separate bucket for signed-in vs
  guest). Returns 429 `Retry-After`.

## Data model

`bookmarks` gains two nullable columns. Migration `0010_bookmark_source.sql`:

```sql
ALTER TABLE bookmarks ADD COLUMN source TEXT;        -- 'komiku'|'bacakomik'|'thrive'|'manhwaindo'
ALTER TABLE bookmarks ADD COLUMN source_url TEXT;    -- original series URL
CREATE INDEX idx_bookmarks_source ON bookmarks (source, created_at DESC);
```

Backward-compatible: existing rows have `source=NULL` → resolved to `komiku` by
convention (D1 `series` rows are source-tagged; bookmark fallback = komiku).

`POST /api/user/bookmark` accepts optional `source` + `source_url` in the body;
defaults to the canonical source of the series row (komiku).

## API routes (apps/api-cf/src/routes/user.ts)

- `GET /api/user/bookmarks` — now returns `[{ slug, title, cover_image, source, source_url, type, status, created_at }]`:
join `series` (live cover/title/type/status) + `bookmarks.source/source_url`. KV
cache keyed by `bookmarks:user:{uid}` TTL 600s (invalidate on mutate).
- `POST /api/user/bookmark` — body `{ seriesSlug, source?, source_url? }`.
  **Rate limit applied** (middleware on `/bookmark` POST + `/bookmark/:slug` DELETE).
- `DELETE /api/user/bookmarks` (clear all) — **rate limited**.
- `DELETE /api/user/bookmark/:slug` — **rate limited**.

New shared limiter in `lib/rateLimit.ts`:
```ts
export const rateLimitMutate: MiddlewareHandler<...> = makeLimiter(60, 3600);
```
Applied via `router.use('/bookmark*', requireSession, rateLimitMutate)` (session
required; per-IP bucket).

## Frontend

### Bookmark page (`app/bookmark/page.tsx`)
- Replace skeleton with empty-state copy + "Cari manga" link when 0 items.
- Sort: server returns `ORDER BY created_at DESC`.
- "Clear all" button (DELETE `/api/user/bookmarks`) with ConfirmModal.
- Pass `source` to MangaCard so links point to the bookmarked source.
- Show SourceBadge on each card (multi-source aware).

### MangaCard (`components/MangaCard.tsx`)
- Add optional `bookmarkable?: boolean` prop + `BookmarkButton` overlay
  (top-right of cover, 44x44, border-white bg-black like reader button).
- On `app/page.tsx` (Populer + Update Terbaru) and `app/search/page.tsx`:
  set `bookmarkable={true}` → "add komik ke bookmark" langsung dari homepage.
- Guest click → `BookmarkButton` redirects `/login` (existing behavior).

### Reader (`[chapterId]/page.tsx`)
- `BookmarkButton` sudah ada di toolbox. Tambah `source` context ke slug
  supaya bookmark disimpan ke source yang tepat.

## Rate limiting (apps/api-cf/src/lib/rateLimit.ts)

In-memory bucket = `makeLimiter(60, 3600)` per IP. 429 body:
```json
{ "error": "rate limit exceeded", "retry_after": 1200 }
```
Applied **only** on mutating bookmark routes (POST/DELETE), not reads.

## Testing

- Unit: `packages/sources/test/komiku.test.mjs` — verify `sanitizeCoverUrl` strips
  `?resize=450,235` → portrait.
- Smoke: `scripts/smoke-user.mjs` — add/remove bookmark, clear-all, verify 429 after 60x/hour.
- Playwright: homepage `BookmarkButton` renders; guest click → `/login`.
