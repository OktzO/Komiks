# Architecture Redesign: Data Caching, D1 Split, R2 All-Source, Source Switcher

**Date:** 2026-08-08
**Status:** Approved
**Author:** User + AI

## Overview

Lima perubahan arsitektur untuk Manga Platform:

1. Homepage data cache ke KV + CF cache 15 menit + lazy daily refresh
2. D1 akun-2 (tzok5555) sebagai primary storage, akun-1 (oktz) sebagai overflow
3. R2 on-demand cache-aside untuk semua source (bukan cuma Komiku)
4. Source switcher UI di detail page + reader gear panel (lazy load)
5. DB-first pattern untuk semua data: D1 dulu, fetch upstream kalau miss

## 1. Homepage Data: KV + CF Cache 15 min + Daily Refresh

### Current
- `page.tsx` calls `searchMerged('')` which fetches 4 sources every request
- KV cache TTL 300s (5 min)
- `revalidate = 300`

### Design

**New endpoint:** `GET /api/homepage`

Worker logic:
1. Read KV `homepage:feed` + `homepage:feed:last_updated`
2. If data exists and `last_updated` < 24h ago → serve from KV immediately
3. If stale > 24h or missing → serve stale data (if available) + background fetch 4 sources paralel, merge, write KV `homepage:feed` + update `homepage:feed:last_updated`
4. If no stale data at all (first ever request) → block and fetch 4 sources, merge, write KV, serve

**KV keys:**
- `homepage:feed` — JSON payload `{ data: [...], sources_queried: [...], total: N }`
- `homepage:feed:last_updated` — Unix timestamp string

**TTL:** KV `homepage:feed` TTL = 90000s (25h, slightly more than 24h so stale data is always available during refresh). CF `Cache-Control: public, s-maxage=900, stale-while-revalidate=86400` (15 min edge cache, 24h stale-while-revalidate).

**Frontend change:**
- `page.tsx` replaces `searchMerged('')` with `fetchHomepage()` calling `GET /api/homepage`
- Remove `revalidate = 300` from page (handled by CF cache headers + KV)
- Homepage sections (Populer, Update Terbaru, Semua Komik) all use same `homepage:feed` payload

**Health recording:** Source health still recorded during the daily refresh fetch (passive health, same as now).

### Migration path
- Old `searchMerged('')` empty-query homepage logic stays in search route for backward compat
- New `/api/homepage` endpoint added to `routes/homepage.ts`
- Fronten switches to new endpoint

## 2. D1 Strategy: Akun-2 Primary, Akun-1 Overflow

### Current
- D1 main (akun-1, oktz, `manga-db` id `76606365...`) = source of truth
- D1 akun-2 (tzok5555, `manga-db` id `61cbf1b1...`) = separate for LB origins, not synced

### Design

**Primary:** D1 akun-2 (tzok5555) stores all tables (series, chapters, chapter_pages, users, bookmarks, reading_history, manga_source_link, manga_merge_queue, image_hashes, scrape_jobs, source_health, r2_last_access, lb_usage, lb_settings, lb_accounts, lb_origins, lb_audit_log).

**Overflow:** D1 akun-1 (oktz) receives writes when akun-2 approaches quota threshold.

**Wrangler config:** Worker needs 2 D1 bindings:
- `DB` (primary, akun-2, id `61cbf1b1-508e-4b00-a0e6-dd68528e54ba`)
- `DB_OVERFLOW` (fallback, akun-1, id `76606365-0fa5-4c1e-9b55-18a8366ef92a`)

**Auto-overflow logic in `lib/context.ts`:**
- New `getDbWithFallback(c)` function
- Before write operations, check D1 akun-2 usage via KV counter `d1:usage` (approximate byte count, incremented on each batch write, reset monthly)
- If usage > 80% threshold → route writes to `DB_OVERFLOW`
- Reads: akun-2 first, if table/row missing → fallback akun-1

**Usage tracking:** KV key `d1:usage` stores approximate byte count. Updated on each batch write. Reset monthly (CF D1 quota is monthly).

**Migration:**
1. Run all migrations on akun-2 D1 (already done — it was provisioned with schema)
2. Update `wrangler.toml` to add `DB_OVERFLOW` binding
3. Update `lib/context.ts` `getDb()` → `getDbWithFallback()`
4. Deploy Worker with both bindings

## 3. R2 On-Demand Cache-Aside for All Sources

### Current
- `reader.ts:484` guards R2 upload with `if (source === 'komiku')`
- Key pattern: `komiku/{slug}/{chapterId}/{pageNo}`
- Frontend `r2UrlFor()` only generates R2 URLs for Komiku

### Design

**Remove guard:** All sources (komiku, bacakomik, thrive, manhwaindo) upload to R2 on-demand when user reads.

**Key pattern:** `{source}/{slug}/{chapterId}/{pageNo}` (was `komiku/...`)

**Worker `reader.ts` changes:**
- Remove `if (source === 'komiku')` check (line 484)
- `uploadToR2()` uses `source` param for key prefix
- `resolveKomikuSlug()` → rename to `resolveSlug()` — works for all sources (D1 lookup + fallback parse)
- Slug resolution: D1 `chapters.series_slug` first, KV cache 1h, fallback parse from chapterId format

**Frontend `lib/api.ts` changes:**
- `r2UrlFor(slug, chapterId, pageNo)` → `r2UrlFor(source, slug, chapterId, pageNo)`
- Key: `{source}/{slug}/{chapterId}/{pageNo}`
- R2-first attempt for ALL sources, error → proxy fallback (which also uploads to R2)

**R2 lifecycle:** Eviction rule per source prefix: `{source}/` with `R2_EVICTION_DAYS` TTL.

**SSRF guard:** Already covers all source image hosts. No change needed.

## 4. Source Switcher UI: Detail Page + Reader Gear Panel

### Current
- `SourceSwitcher` component exists with 3 modes: `detail` (dropdown), `reader` (sticky bar), `embedded` (in chapter sheet)
- Detail page uses `mode='detail'` dropdown below title
- Reader uses `embedded` in chapter sheet

### Design

**4a. Detail page source switcher (pojok kanan):**
- Move/reposition SourceSwitcher to top-right of detail page, next to "Beranda" link
- Layout: `flex justify-between` — left: "Beranda" link, right: SourceSwitcher badge+name
- Badge icon + source name, clickable dropdown with all sources
- Lazy: fetch `/api/reader/:source/series/:sourceId/sources` only when user clicks the dropdown (already lazy in current code)

**4b. Reader gear panel source switcher:**
- Add new section "Ganti Source" inside `.reader-settings` panel (gear icon)
- Shows list of all sources (badge + name) as clickable buttons
- Selecting a source navigates to same chapter number on that source
- Lazy: only fetch `/sources` when user opens the settings panel
- Does NOT pre-load sources on page load

**4c. Chapter list per source:**
- When user switches source in reader, `ReaderShell` fetches chapters from the NEW source (not Komiku)
- `getChapters(source, slug)` already calls `/api/reader/:source/series/:sourceId/chapters` — works for all sources
- Chapter list in bottom sheet shows chapters from currently selected source

**Component changes:**
- `SourceSwitcher.tsx`: add `mode='settings'` for the gear panel layout
- `ReaderShell.tsx`: add SourceSwitcher inside `.reader-settings` panel
- `page.tsx` (detail): reposition SourceSwitcher to top-right

## 5. DB-First Pattern for All Data

### Current
- Frontend calls Worker which fetches upstream directly
- D1 only used for auto-index and FTS5 search

### Design

**All data access follows cache-aside pattern at D1 level:**

**Series detail (nama komik):**
```
Worker GET /api/reader/:source/series/:sourceId
  → Check D1 series table (by source_slug via manga_source_link)
  → If hit → serve from D1 (fast, no upstream call)
  → If miss → fetch upstream adapter → persist to D1 (upsertSeries + upsertSourceLink) → serve
```

**Chapter detail (pages):**
```
Worker GET /api/reader/:source/chapter/:chapterId
  → Check D1 chapters + chapter_pages
  → If hit → serve from D1 (page URLs from D1, R2-first for images)
  → If miss → fetch upstream adapter → persist chapters + chapter_pages to D1 → serve
```

**Bookmark:**
- Already D1-native. No Worker origin call needed.
- `bookmark/page.tsx` calls `/api/user/bookmarks` which reads D1 directly.

**Search:**
- `searchMerged(q)` for non-empty query: D1 FTS5 first, fallback to upstream if results < 5
- Homepage: KV `homepage:feed` (section 1)

**New D1 methods needed:**
- `db.getChapterPagesFromD1(chapterId)` — read pages from chapter_pages table
- `db.upsertChapter(chapter)` — persist chapter metadata to D1
- `db.upsertChapterPages(chapterId, pages)` — batch persist page URLs

**KV caching remains** for:
- Homepage feed (daily)
- Series detail (600s)
- Chapter list (300s)
- Search results (120s)
- Source health (60s)

## Data Flow Summary

```
User → Frontend → Worker API
                    │
                    ├─ Homepage? → KV homepage:feed (daily refresh)
                    │              CF cache 15 min
                    │
                    ├─ Series detail? → D1 first (by manga_source_link)
                    │                   miss → upstream adapter → persist D1 → KV cache
                    │
                    ├─ Chapter pages? → D1 first (chapters + chapter_pages)
                    │                   miss → upstream adapter → persist D1 → KV cache
                    │                   R2-first for images (all sources)
                    │
                    ├─ Search? → D1 FTS5 first
                    │            miss → upstream → persist D1 → KV cache
                    │
                    ├─ Bookmark? → D1 native (no upstream)
                    │
                    └─ Source switch? → /sources endpoint (D1 manga_source_link)
                                       miss → live-resolve → persist D1
```

## D1 Overflow Flow

```
Worker write operation
  │
  ├─ Check KV d1:usage (approximate byte count)
  │
  ├─ < 80% quota? → Write to DB (akun-2, primary)
  │
  └─ ≥ 80% quota? → Write to DB_OVERFLOW (akun-1, overflow)
                   Update KV d1:usage:overflow = true

Worker read operation
  │
  ├─ Read from DB (akun-2)
  │
  └─ If not found AND overflow flag set → Read from DB_OVERFLOW (akun-1)
```

## Files to Change

| File | Change |
|------|--------|
| `apps/api-cf/src/routes/homepage.ts` | NEW: `/api/homepage` endpoint, KV daily refresh |
| `apps/api-cf/src/routes/reader.ts` | R2 all-source, DB-first pattern, remove komiku-only guard |
| `apps/api-cf/src/routes/search.ts` | DB-first search, persist results to D1 |
| `apps/api-cf/src/lib/context.ts` | Add `DB_OVERFLOW` binding, `getDbWithFallback()` |
| `apps/api-cf/wrangler.toml` | Add `DB_OVERFLOW` D1 binding |
| `apps/web/app/page.tsx` | Use `fetchHomepage()` instead of `searchMerged('')` |
| `apps/web/lib/api.ts` | `r2UrlFor(source, slug, chapterId, pageNo)`, `fetchHomepage()` |
| `apps/web/components/SourceSwitcher.tsx` | Add `mode='settings'` for gear panel |
| `apps/web/components/ReaderShell.tsx` | SourceSwitcher in settings panel, chapter list per source |
| `apps/web/app/[source]/s/[slug]/page.tsx` | Reposition SourceSwitcher to top-right |
| `packages/db/index.ts` | New methods: upsertChapter, upsertChapterPages, getChapterPagesFromD1 |
| `packages/shared/src/r2-routing.ts` | Key pattern include source prefix |

## Implementation Order

1. D1 overflow (wrangler.toml + context.ts + db methods)
2. Homepage KV cache (new endpoint + frontend)
3. R2 all-source (reader.ts + api.ts)
4. DB-first pattern (reader.ts + search.ts + db/index.ts)
5. Source switcher UI (SourceSwitcher + ReaderShell + detail page)
6. Test all flows end-to-end
7. Deploy to production
