# Manga Aggregation (multi-source) — Design Spec

**Date:** 2026-08-07
**Status:** Approved
**Scope:** D1 schema extension + dedup/matching logic + admin merge endpoints.

---

## Context

4 sources (komiku, bacakomik, thrive, manhwaindo) masing-masing produce row `series` terpisah untuk manga yang sama. Tujuan: 1 manga canonical + banyak source link; UI menampilkan badge multi-source + switcher.

**Keputusan arsitektur:** tabel `series` yang ada sudah berisi semua field canonical (title, cover, genres, status, type, slug unique, FTS5, FK bookmarks/history). Tidak dibuat tabel `manga` baru — `series` BERPERAN sebagai canonical. Ditambah:

- `manga_source_link` — hubungkan satu series (canonical) ke (source, source_slug) rows
- `manga_merge_queue` — ambiguous matches menunggu review manual
- `series.alt_titles` — kolom baru (JSON array string)

**Alasan:** menghindari migration rename berat + mempertahankan FK existing (bookmarks/history/FTS5 tetap valid). `manga_source_link.mangaId → series.id`.

---

## Schema (migration 0004)

```sql
ALTER TABLE series ADD COLUMN alt_titles TEXT;  -- JSON array string

CREATE TABLE manga_source_link (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  manga_id       INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  source_slug    TEXT NOT NULL,
  has_chapter_list INTEGER NOT NULL DEFAULT 1,
  chapter_count  INTEGER NOT NULL DEFAULT 0,
  last_scraped_at INTEGER,
  UNIQUE (source, source_slug)
);
CREATE INDEX idx_msl_manga ON manga_source_link(manga_id);

CREATE TABLE manga_merge_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_slug   TEXT NOT NULL,
  title         TEXT NOT NULL,
  candidate_ids TEXT NOT NULL,       -- JSON array of series.id candidates
  confidence    REAL NOT NULL,       -- 0..1
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','rejected')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at   INTEGER
);
```

---

## Matching/dedup logic (`packages/db/src/matching.ts` baru — pure function, testable)

```ts
normalizeTitle(s): lowercase, NFKD, strip non-alnum, strip noise words
  (season|chapter|vol(ume)?|full color|special), collapse spaces

levenshtein(a, b): int distance
jaroWinkler(a, b): 0..1 similarity

matchCandidate(title, candidates: {id,title,alt_titles[]}[]):
  1. exact: normalizeTitle match → return {type:'exact', id}
  2. fuzzy: jaroWinkler(normalize(title), normalize(c.title)) >= 0.92
     OR levenshtein normalized >= 0.85 → best match
  3. ambiguous: top-2 candidates within 0.05 of each other → {type:'queue'}
  4. none → {type:'new'}
```

Threshold: jw >= 0.92 = confident merge; dua kandidat beda <= 0.05 → queue.

---

## DB helpers baru (`packages/db/index.ts`)

```ts
upsertSourceLink(params: { mangaId; source; sourceSlug; hasChapterList?; chapterCount?; lastScrapedAt? }): Promise<{ id }>
getSourceLinksByManga(mangaId): Promise<{ source, source_slug, chapter_count, has_chapter_list, last_scraped_at }[]>
getMangaBySource(source, sourceSlug): Promise<{ id, slug, title, source } | null>  // via msl join
listMergeQueue(status?): Promise<MergeQueueItem[]>
resolveMergeQueue(id, action: 'merge'|'reject', targetMangaId?): Promise<{success}>
mergeSeries(targetSlug, sourceSlug): move source rows + chapters into target
splitSeries(mangaId, source, newSlug): create new series row, move source link + chapters
```

`mergeSeries`: pindahkan semua chapters + source_link dari series lain ke target; delete source series row (kecuali keep cover/genres tertua).

---

## API endpoints (admin, step-up `x-admin-stepup`)

| Method | Path | Desc |
|--------|------|------|
| GET | `/api/admin/merge/queue` | list pending queue |
| POST | `/api/admin/merge/queue/:id` | `{action:'merge'\|'reject', targetMangaId?}` |
| POST | `/api/admin/merge/series` | `{targetSlug, sourceSlug}` manual merge |
| POST | `/api/admin/merge/split` | `{mangaId, source, newSlug}` manual split |

Semua di file baru `apps/api-cf/src/routes/admin/merge.ts`, mount di index.ts, `requireAdminKey` + step-up.

---

## Integration — scrape flow

Saat scrape/upsert series dari source:
1. `getMangaBySource(source, slug)` → ada? update link + return canonical.
2. Tidak ada → `matchCandidate(title, allSeriesTitles)` (D1 query semua id/title/alt_titles — skala kecil OK).
3. exact/fuzzy confident → `upsertSourceLink` ke canonical; migrate chapters ke canonical slug (update `chapters.series_slug`); delete duplicate row kalau fuzzy-match slug beda.
4. ambiguous → insert `manga_merge_queue`.
5. none → insert series baru + `upsertSourceLink`.

---

## Files touched

| File | Change |
|------|--------|
| `packages/db/migrations/0004_aggregation.sql` | new schema |
| `packages/db/src/matching.ts` | new pure matching functions + test |
| `packages/db/index.ts` | +7 helpers |
| `packages/shared/types.ts` | +MergeQueueItem, SourceLink types |
| `apps/api-cf/src/routes/admin/merge.ts` | new admin routes |
| `apps/api-cf/src/index.ts` | mount merge router |
| `apps/api-cf/src/routes/admin/scrape.ts` | integration: dedup saat scrape |
| `packages/db/test/matching.test.mjs` | unit test matching |

---

## Skipped (YAGNI)

- Full-text fuzzy index (skala kecil — query semua title tiap match OK, cache di memory).
- Auto-merge otomatis di background — manual queue review dulu (user spec: "ambiguous → review manual").
- API relasi ke `manga_merge_queue` untuk UI — hanya endpoint admin minimal.