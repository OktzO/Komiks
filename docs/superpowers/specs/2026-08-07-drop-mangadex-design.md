# Hapus MangaDex Total — Design Spec

**Date:** 2026-08-07
**Status:** Approved
**Scope:** Platform cleanup — remove all MangaDex references from code, files, docs, DB.

---

## Context

Source saat ini: Komiku (aktif) + MangaDex (mau dihapus total). Target akhir: Komiku + BacaKomik.my + Thrive.moe. MangaDex removal is part 1 of the multi-source overhaul. Pure deletion — no new features.

---

## Design

### Source registry change

`packages/sources/index.ts`:
- Hapus `import { mangadexAdapter }` + `import type { MangadexAdapter, AdapterEnv }` dari file.
- `SourceKey` union: `'mangadex' | 'komiku'` → `'komiku' | 'bacakomik' | 'thrive'`. (Adapter `bacakomik`/`thrive` belum dibuat — placeholder key akan return null adapter. Part 2 build-nya.)
- Hapus `mangadex` dari `adapterFactories`.
- Hapus export `mangadexAdapter`, `type MangadexAdapter`.
- Pertahankan `AdapterEnv` export (diperluas ke `packages/sources/komiku/index.ts`).

### Files delete

- `packages/sources/mangadex/index.ts`
- `packages/sources/mangadex/client.ts`
- `packages/sources/mangadex/` (directory)

### Files modify

| File | Change |
|------|--------|
| `packages/sources/index.ts` | Remove mangadex imports/registry/export, add placeholders |
| `apps/api-cf/src/lib/context.ts` | Remove `MANGADEX_API_KEY` from `Env` type |
| `apps/api-cf/src/routes/search.ts` | Remove mangadex multi-source branch (Komiku single-source) |
| `apps/api-cf/src/routes/reader.ts` | Remove mangadex proxy branch |
| `apps/api-cf/src/routes/sourceStatus.ts` | Remove mangadex status |
| `apps/api-cf/src/routes/admin/scrape.ts` | Remove mangadex from allowed sources |
| `apps/web/components/SourceBadge.tsx` | Remove mangadex badge case |
| `apps/web/components/MangaCard.tsx` | Remove mangadex source detection |
| `apps/web/app/status/page.tsx` | Remove mangadex from status page |
| `apps/web/app/history/page.tsx` | Remove mangadex reference |
| `packages/shared/types.ts` | Remove mangadex from source union |
| `packages/db/schema.sql` | `series.source` default `'mangadex'` → `'komiku'` |
| `packages/db/migrations/0003_drop_mangadex.sql` | **New** migration — delete mangadex rows |
| `docs/DEPLOY.md` | Remove `MANGADEX_API_KEY` from secrets docs |
| `docs/TOS-REVIEW.md` | Remove mangadex lines |
| `README.md` | Remove mangadex mentions |
| `.env.example` | Remove `MANGADEX_*` if present |

### Migration `packages/db/migrations/0003_drop_mangadex.sql`

```sql
-- Hapus semua data manga/chapter/sourceLink sumber mangadex.
-- Cascade via FK: chapters -> series (ON DELETE CASCADE),
-- chapter_pages -> chapters (CASCADE), bookmarks/history -> series (CASCADE).

DELETE FROM series WHERE source = 'mangadex';
DELETE FROM source_health WHERE source = 'mangadex';
```

`source_health` table ada? Perlu verifikasi — kalau kolom `source` ada di sana, hapus baris mangadex. Kalau tabel beda nama, sesuaikan.

### Files preserved (sengaja)

- `docs/superpowers/specs/*.md` + `docs/superpowers/plans/*.md` — historical record.
- `.superpowers/sdd/*` — task reports.
- `.opencode/skills/manga/SKILL.md` — skill file; update terpisah (skill ini source of truth, perlu reflect state tanpa mangadex). **Keputusan:** update skill = optional, dimasukkan kalau grep masih kena. Prinsip Part 1: bersihkan code, skill doc ditangani di akhir overhaul (Part 7).

---

## Verification

```bash
# Typecheck semua package — no new errors
npx tsc --noEmit -p apps/api-cf
npx tsc --noEmit -p apps/web
npx tsc --noEmit -p packages/db
npx tsc --noEmit -p packages/sources
npx tsc --noEmit -p packages/lb
npx tsc --noEmit -p packages/vision

# Grep 'mangadex' case-insensitive di code/files
# Expected remaining: hanya docs/superpowers/** + .superpowers/** (historical)
grep -ri "mangadex" -l --include="*.ts" --include="*.tsx" --include="*.sql" --include="*.toml" --include="*.json" .
```

---

## Skipped (YAGNI)

- Rewrite how to the new `manga_source_link` structure — that's Part 3. This part only removes mangadex.
- Update `.opencode/skills/manga/SKILL.md` — deferred to post-overhaul (Part 7).
- Update UI to "source switcher" — Part 5.
- Any migration to backfill/remap komiku rows — not needed (komiku rows keep `source='komiku'`).

→ Add real `bacakomik`/`thrive` adapter in Part 2. DB aggregation structure in Part 3.