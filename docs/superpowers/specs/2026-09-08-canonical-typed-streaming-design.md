# Design: Canonical Typed URLs + Streaming Detail Page

Tanggal: 2026-09-08 | Status: menunggu review user | Pendekatan: A (kanonik + streaming)

## 0. Latar & tujuan

Cold open halaman komik lambat (20-30s) karena `GET /sources` fan-out sinkron
(search 4 source + `enrichChapterCounts` 10s blocking, `apps/api-cf/src/routes/reader.ts:478-518,562-575,665`)
ditambah waterfall `Promise.all([detail, sources]) + 3x getSeries` sebelum render
(`apps/web/app/[source]/s/[slug]/page.tsx:17-26,117-124`) dalam satu Suspense.
URL mengandung nama source (`/:source/s/:slug`) — diminta menjadi kanonik per-type.

Tujuan: (1) shell (cover, judul, sinopsis) tampil dulu, chapter/source nyusul di
background; (2) URL bersih `/manga/{slug}`, `/manhwa/{slug}`, `/manhua/{slug}`;
(3) efisien, minim leak; (4) nol data user hilang (hapus total DIBATALKAN).

## 1. Routing + resolver (DISETUJUI)

- Route baru eksplisit: `app/manga/[slug]/`, `app/manhwa/[slug]/`, `app/manhua/[slug]/`
  (berbagi komponen di `_components/`). Sengaja BUKAN `app/[type]/[slug]` agar tidak
  menelan `/admin/...` dan sejenisnya; tanpa reserved-list.
- Endpoint baru `GET /api/resolve/:slug` → `{ type, source, sourceSlug,
  recommendedSource }`, di-backup `series.slug` UNIQUE + `manga_source_link`
  (`packages/db/schema.sql:7-27,171-181`). Cache two-tier `f:`/`s:` + peer fallback
  seperti `detail` (fresh 10m / stale 24h). Enrich count HANYA via `waitUntil`
  background, tidak pernah `await` blocking.
- Route lama `app/[source]/s/...` dipertahankan sebagai redirect 308 tipis ke
  kanonik typed (SEO + bookmark lama tetap jalan). API `/api/reader/:source/...`
  tetap (dipakai internal + resolver).
- Chapter: `/{type}/{slug}/{chapterId}` → resolve kanonik → fetch dari recommended
  source. `chapterId` selalu dalam namespace recommended source (link chapter dibangun
  dari daftar chapter-nya; pindah source di reader tetap via chapter-number seperti
  `SourceSwitcher` sekarang). Type di URL ≠ type resolver → 308 ke URL benar. Slug asing → `notFound()`.
- TIDAK diubah: B2 key (source tetap di path internal), `series.slug`,
  `manga_source_link`, bookmarks, history, `/api/_internal/*` (sharding).

## 2. Split streaming (DISETUJUI)

Page tipis kick-off 4 promise paralel (`resolveP`, `detailP`, `chaptersP`,
`sourcesP`), `await` HANYA `detailP` sebelum return shell:

- `<DetailShell/>` sync (LCP: cover + judul + sinopsis, bukan di Suspense).
- `<Suspense><ChapterSection data={chaptersP}/></Suspense>`,
  `<Suspense><SourceSection data={sourcesP}/></Suspense>` — skeleton sendiri.
- `generateMetadata` hanya `await resolve + detail` → stream mulai segera.
- `loading.tsx` per route typed untuk feedback navigasi instan.
- Merge genre/author 3-source (+2s blocking) pindah ke `SourceSection` background.
- Tepat 3 boundary (anti spinner-soup + anti single-boundary-gating).

## 3. Auto-pick + counter background (DISETUJUI)

- Pick tetap: `chapter_count` terbanyak → `last_scraped_at` → `SOURCE_WEIGHT`;
  pref user (`src-prefs`) menang. Pindah dari redirect 307 pra-render ke pick di
  dalam section background + notice *"menampilkan dari {source} — chapter terbanyak"*.
- Counter dari `chaptersP` (boleh stale/0 dulu); enrich selesai → client refetch
  MAKS 1x/mount (flag, bukan polling). Gate `enrich:<id>` 6h tidak berubah.
- `ChapterList` terima props, nol fetch tambahan.

## 4. Efisiensi + anti-leak (DISETUJUI)

- Budget: resolve KV (<100ms warm); detail 1 upstream (pengecualian: cold detail
  tetap dibatasi satu fetch upstream yang tak terhindarkan + retry 3x);
  chapters/sources
  `race(fan-out, 4s)` → stale + heal background. Target backend p95 <4s (muat di
  `apiWithFailover` 8s → retry storm hilang).
- Coalescing `inFlight` dipertahankan + ditambah untuk resolve dan `pages:*`
  (tutup stampede scrape gambar). Semua fetch `AbortSignal.timeout` + `alive`
  cleanup; tanpa `setInterval`; LRU caps dipertahankan.

## 5. Error, testing, rollout (DISETUJUI)

- `error.tsx`/`not-found.tsx` per route typed; section gagal → panel inline + retry,
  shell hidup. URL lama/wrong-type → 308.
- Uji: unit (pick, resolver), integrasi (resolve→detail→chapters), Playwright E2E
  cold-vs-warm (byte shell < chunk chapter, LCP di shell, abort saat navigasi pergi,
  308 lama, 404 asing). Verifikasi streaming chunked di OpenNext/Workers.
- Rollout berdampingan; sitemap/canonical ke typed; monitor Server-Timing +
  `recordHealth`; hapus kode lama tahap 2. Nol DROP tabel/kolom.
- Sukses: shell warm <300ms / cold <3s, chapter <+5s, nol 502 full-page fan-out,
  nol data hilang.

## 6. Non-tujuan

- Hapus data/kode lama sekaligus (dibatalkan user). Re-upload B2 massal.
- Client-side penuh (SEO chapter dikorbankan). Perubahan skema D1.
