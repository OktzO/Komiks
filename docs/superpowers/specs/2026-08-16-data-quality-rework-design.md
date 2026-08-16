# Design: Data Quality Rework (merge, alt titles, entities, chapter parser, UI polish)

Date: 2026-08-16
Status: Approved (brainstormed 2026-08-16; user answers: auto-merge for exact + queue for fuzzy; merge target = most chapters; tie komiku > bacakomik > thrive > manhwaindo; examples from DB itself)

## Objective

Fix data-quality issues confirmed by DB forensics (D1 `manga-db` remote, akun-1):

1. Raw HTML entities in series titles (e.g. `Once-Divorced Fox &#038; Travel Meals` id27, `Akari … ~I&#8217;m …` id53, quote-wrapped titles id40/49/62/92 incl. `I, the Outcast Hero, Built the World's Most Powerful Dungeon.`).
2. Duplicate series across (and within) sources: `Eleceed` id43 bacakomik slug `883432-eleceed` + id115 bacakomik slug `eleceed`. `alt_titles` never populated (`alt_nonempty = 0`).
3. Chapter list bug: komiku seri `outcast-hero` → 4 chapter rows all `chapter_number = 39` (ids right: `chapter-1..4`); bacakomik `883432-eleceed` returns 200 with empty chapters (failed live-resolve / missing links).
4. No dedup on the hot index path: `addMergeQueue` called only from `admin/scrape.ts:97` manual path.
5. UI: default scrollbar; no blockquote styling (target: dark-light like oktz.qzz.io).

## Design (approved)

### A. HTML entity decoding
- Add `decodeHtmlEntities(str)` util in `packages/shared` (decode `&amp;` `&#038;` `&#8217;` `&quot;` `&ldquo;` `&rdquo;` `&#0-9]+;` etc. — via DOM-free decoder: `he`-style map + numeric fallback; keep codebase-dep-free).
- Apply in all 4 adapters where titles/descs parsed: komiku, bacakomik, manhwaindo, thrive.
- Backfill SQL: `UPDATE series SET title = decode(title), alt_titles = decode(alt_titles)` run via `wrangler d1 execute --remote` (decode = SQL string replace per entity or app-side node script reading D1 rows; prefer app-side script for correctness).

### B. Merge system on hot path
- New `dedupeOnIndex(seriesRow, ctx)` in `packages/db` called from:
  - `apps/api-cf/src/routes/admin/scrape.ts` (after upsert, replacing the manual-only path) and
  - `apps/api-cf/src/routes/reader.ts` `/sources` aggregation (before serving, lazy dedup of an exact-match candidate).
- Matching: `matchCandidate` (already supports alt_titles) over `normalizeTitle`; **exact match → auto-merge immediately** (merge into target series chosen by `resolveMergeQueue` rules); **fuzzy ≥ 0.92 → insert `manga_merge_queue`** for admin.
- Target selection: row with MAX `SUM(chapter_count)` across its `manga_source_link` rows; tie-break priority: komiku > bacakomik > thrive > manhwaindo.
- `resolveMergeQueue` must: re-map `manga_source_link`, `chapters`, `chapter_pages`-owner, series stats, alt_titles union, delete merged row, keep `canonicalId` pointing to target.

### C. Alt titles indexing
- Parse komiku source "Judul Lain" (`komiku/index.ts` scrape detail) → `series.alt_titles` (JSON array string).
- FTS migration: recreate `series_search` FTS table including `alt_titles` column; search fallback uses `LIKE` against `title OR alt_titles` (spread via JSON `json_each` or app-side tokenization). Update `search.ts` to match alt_titles.

### D. Chapter parser fix (komiku)
- Scope selection to `#daftarChapter` container.
- Chapter number priority: from slug id `chapter-<n>` (present in links) over title regex `/(\d+(?:\.\d+)?)/` (current bug grabs first number in title, e.g. `39` from "…39 volumes…").
- Dedup chapters by chapter_number during parse; keep ids `chapter-N`.
- bacakomik: apply entity decode only (parser fine).

### E. Admin UI `/admin/merge`
- Route page using existing `manga_merge_queue` API (`resolveMergeQueue`/queue listing): list queue rows (source series, target, score via `matchCandidate`), accept/reject per row, run now button.

### F. UI polish (globals.css)
- **Scrollbar**: dark modern — width 8-10px, transparent track, thumb using foreground alpha 18%, hover 40%, `scrollbar-width: thin`, `::-webkit-scrollbar*`.
- **Blockquote**: dark-light style like oktz.qzz.io/quote-typewriter — glassy dark card, left accent border (accent color), rounded, `color-mix(in oklab, ...)` background, subtle glow (user asked "dark-light seperti di web aku"; glow variant presented as option, default = border-left + soft glow).
- **::selection**: accent-tinted.

## Non-goals
- No re-scraping all series now (backfill via SQL only, re-scrape happens naturally on next index).
- No frontend merge UX beyond admin page (fuzzy queue stays admin-managed).
- No changes to D1 shard layout or chapter_pages migration for id stability.