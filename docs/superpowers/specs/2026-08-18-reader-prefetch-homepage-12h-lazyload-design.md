# Design: Reader Prefetch, Homepage 12h Cross-Account, Lazy Loading Tertarget + Dead Code Cleanup

> Date: 2026-08-18
> Status: Approved (brainstorming, 2026-08-18)

## 1. Latar Belakang

Tiga permintaan user + satu tambahan:

1. **Chapter load**: jangan download seluruh chapter 1 komik — hanya beberapa chapter / sampai bab yang belum dibaca.
2. **Homepage**: jangan scrape setiap ada user — auto-scrape tiap 12 jam untuk refresh populer, cross-account CF (semua 4 worker serve feed konsisten).
3. **Lazy loading**: device user tidak berat.
4. **Dead code cleanup menyeluruh** setelah perubahan besar.

### Temuan audit (2026-08-18)

- **Reader SUDAH lazy**: virtualized window (`WINDOW=3, BEHIND=1`, ~5 halaman awal), B2 upload per-page on-demand (`reader.ts:230-263`), `loading="lazy"` pada img. **Tidak ada bulk download seluruh chapter.**
- **Gap chapter**: tidak ada prefetch bab berikutnya yang berarti — hanya `router.prefetch(nextChapterUrl)` RSC payload saat halaman terakhir (`Reader.tsx:102-107`), dan `nextChapterUrl` dihitung dari `chapter_number + 1` (rapuh).
- **Homepage**: feed lewat `/api/search?q=` (KV TTL 300s, scrape 4 source sinkron di request path saat miss). Route `/api/homepage` **dead code — tidak pernah di-mount** di `index.ts`.
- **"Populer Hari Ini"** = `slice(0,10)` urutan scrape (bukan metrik sungguhan).
- **Cron hourly** (`EVICTION_OWNER=1`) hanya eviction B2 — tidak ada refresh feed.
- **Lazy loading gap**: poster detail series eager; chapter sheet render semua chapter sekaligus; tidak ada `srcset`.
- **Dead code teridentifikasi**: `routes/homepage.ts` (belum di-mount), komentar stale di `lib/api.ts:89-92` (`getSeriesList` mengklaim dipakai homepage), plus audit menyeluruh saat implementasi.

## 2. Design

### 2.1 Chapter: prefetch bab berikutnya (1 bab)

- `Reader.tsx`: saat `visibleCount >= pages.length` (user di halaman terakhir), fetch **hanya 1 bab berikutnya** via `getChapter(nextChapterId)` → simpan di ref/state. Data = metadata + array URL halaman (ringan, bukan gambar).
- Klik "Bab Berikutnya" → render langsung dari cache; gambar tetap lazy.
- **Batasan**: max 1 bab ke depan, fire sekali per chapter, tidak pernah prefetch bab kedua.
- `page.tsx` (RSC): kirim `prevChapterId`/`nextChapterId` asli ke client (bukan kalkulasi `chapter_number+1`) — ambil dari chapter list yang sudah di-fetch ReaderShell.
- Error prefetch → silent fallback ke RSC normal.

### 2.2 Homepage: cron 12 jam cross-account

1. **Mount `/api/homepage`** (`routes/homepage.ts`): baca `homepage:feed` KV; hit → serve; miss → scrape + tulis; TTL 12 jam (43200s). Rate limit: `rateLimit` global. Tambah ke `ORIGIN_PATH_ALLOWLIST` (frontend) supaya round-robin.
2. **Cron akun-1** (existing `scheduled`): jika `EVICTION_OWNER === '1'`, tambah task scrape feed → hitung **skor populer sederhana** (chapter_count + updated_at + source priority) → tulis `homepage:feed` + `homepage:feed:last_updated` KV akun-1 → **push ke 3 akun lain** via endpoint internal baru `POST /api/_internal/kv/put` (key-prefix allowlist `homepage:feed`, auth `DB_FORWARD_KEY`/`x-db-forward-key`, pola `peerKvGet`).
3. **Frontend `page.tsx`**: ganti `searchMerged('')` → `fetchHomepage()` (`/api/homepage`). Sections Populer (skor) + Update Terbaru dipisah berdasarkan data feed.
4. Push KV gagal → log, retry cycle berikutnya; akun lain serve stale feed (fail-open di serve, tidak pernah 404).
5. Skor populer: `score = source_priority + chapter_count_weight + updated_at_recency`. Detail formula di implementasi, unit-tested.

### 2.3 Lazy loading tertarget

1. Poster detail series (`[slug]/page.tsx:122`) → `loading="lazy"`.
2. Chapter sheet (`ChapterList.tsx` + `ReaderShell.tsx`) → windowed render: ~40 item awal + IntersectionObserver sentinel untuk tambah (pola Reader, tanpa library baru).
3. `CoverImage.tsx` → `srcSet`/`sizes` memakai query resize image proxy bila didukung; fallback `src` saja bila tidak.

### 2.4 Dead code cleanup menyeluruh

- Mount `routes/homepage.ts` (jadi live) → bukan dead lagi.
- Hapus/update: komentar stale `lib/api.ts:89-92`, unused imports, fungsi tidak terpakai di `apps/api-cf` + `apps/web`, route/helper yang tak pernah dipanggil (audit via grep + typecheck).
- **Tidak merombak**: struktur yang masih dipakai, hanya hapus yang benar-benar dead.

## 3. Error Handling

- Prefetch bab: gagal → silent, load normal via RSC.
- Cron scrape: source gagal → `Promise.allSettled` sudah ada, source yang sukses tetap dipakai.
- Push KV cross-account: gagal → log; akun lain stale feed.
- `/api/homepage` miss + scrape gagal semua → 503 dengan error message (frontend fallback ke skeleton/empty).

## 4. Testing

- Unit: skor populer (formula + tie-break).
- Smoke: cron → KV akun-1 → push → 4 akun serve feed identik.
- Playwright: prefetch bab berikutnya (tidak ada request bab+2), chapter sheet windowed, poster lazy.
- `npx tsc --noEmit -p apps/api-cf/tsconfig.json` + `apps/web` typecheck + build.
- Deploy 4 worker + verify `/api/health` + CSRF (origin evil → 403).

## 5. Out of Scope (YAGNI)

- Virtualisasi grid homepage/search/bookmark (ditunda — card count kecil, 22-60 item).
- `srcset` multi-breakpoint penuh.
- Metrik populer berbasis views/analytics.
- Wire `POST /api/user/history` dari reader (fitur resume — terpisah, bisa jadi iterasi berikutnya).