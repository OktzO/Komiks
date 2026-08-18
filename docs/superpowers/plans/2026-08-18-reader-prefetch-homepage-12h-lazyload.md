# Reader Prefetch + Homepage 12h Cross-Account + Lazy Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefetch hanya 1 bab berikutnya di reader, homepage refresh 12 jam via cron cross-account, dan lazy loading tertarget — plus dead code cleanup.

**Architecture:**
- API: mount `/api/homepage` (sudah ada, dead code), tambah endpoint internal `POST /api/_internal/kv/put` + `peerKvSet` untuk push feed KV dari akun-1 ke 3 akun lain. Cron `scheduled` akun-1 (`EVICTION_OWNER=1`) scrape tiap jam tapi tulis feed hanya jika >12 jam sejak terakhir.
- Web: homepage pindah dari `searchMerged('')` ke `fetchHomepage()`; reader prefetch bab berikutnya via `getChapter` saat halaman terakhir; chapter sheet windowed render; poster detail lazy.
- Skor populer: `chapter_count` + `updated_at` recency + source priority, dihitung di cron, disimpan dalam feed JSON.

**Tech Stack:** Hono (Worker), Cloudflare KV/D1, Next.js App Router (edge), React.

## Global Constraints

- TTL feed 12 jam (43200s) — `HOMEPAGE_TTL = 43200`.
- Push KV hanya untuk key prefix `homepage:feed` (allowlist server-side, auth `x-db-forward-key`).
- Prefetch bab: max 1 bab ke depan, fire sekali per chapter.
- Reader tetap windowed (WINDOW=3, BEHIND=1) — tidak dirombak.
- Chapter sheet windowed: 40 item awal + sentinel IntersectionObserver.
- Image proxy TIDAK support resize → **srcset di-skip** (no-op aman, sesuai design "bila didukung").
- Skor populer tidak mengubah payload shape feed: `{ data: [...], sources_queried: [...] }` — item feed mendapat field tambahan `popularity` + `source_priority`.

---

### Task 1: Mount `/api/homepage` + skor populer + TTL 12 jam

**Files:**
- Modify: `apps/api-cf/src/routes/homepage.ts`
- Modify: `apps/api-cf/src/index.ts`

**Interfaces:**
- Produces: `router.get('/homepage')` — serve `{ data, sources_queried, cached, updated_at, popularity: Record<slug, number> }`.
- Produces: `computePopularity(items)` → array items diberi `popularity` number.

- [ ] **Step 1: Edit `homepage.ts` — TTL 12 jam + skor populer**

```ts
const HOMEPAGE_TTL = 43200;                    // 12 jam
const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 jam

// Source priority: komiku=4, bacakomik=3, thrive=2, manhwaindo=1 (cron-fill).
const SOURCE_PRIORITY: Record<string, number> = {
  komiku: 4, bacakomik: 3, thrive: 2, manhwaindo: 1, local: 0,
};
```

Tambahkan di `fetchHomepageFromSources` setelah merge: beri `popularity` ke tiap item:

```ts
const now = Date.now();
for (const item of merged) {
  const d = item.data ?? item;
  const chCount = Number(d.chapter_count ?? 0);
  const updated = Number(d.updated_at ?? 0);
  const ageDays = updated > 0 ? (now - updated * 1000) / 86400000 : 999;
  const recency = Math.max(0, 1 - ageDays / 30);          // 1 = baru, 0 = >30 hari
  const prio = SOURCE_PRIORITY[d.source ?? 'local'] ?? 0;
  item.popularity = Math.round((prio * 2 + chCount * 0.25 + recency * 5) * 100) / 100;
}
```

Urutkan `merged` by `popularity` desc (populer) — tapi feed juga dipakai "Update Terbaru". **Solusi**: simpan dua urutan — `data` tetap insertion order (terbaru), tambah field `popularity` per item; frontend urutkan sendiri untuk section Populer.

- [ ] **Step 2: `index.ts` — mount router + rate limit**

```ts
import { router as homepageRouter } from './routes/homepage';
// setelah seriesRouter mount:
app.route('/api', homepageRouter);
```

- [ ] **Step 3: typecheck**

Run: `npx tsc --noEmit -p apps/api-cf/tsconfig.json`
Expected: hanya error pre-existing `packages/db/index.ts(652,25)`.

- [ ] **Step 4: Commit**

```bash
git add apps/api-cf/src/routes/homepage.ts apps/api-cf/src/index.ts
git commit -m "feat(api): mount /api/homepage with 12h TTL + popularity score"
```

---

### Task 2: Internal KV put + peerKvSet + cron push cross-account

**Files:**
- Modify: `apps/api-cf/src/routes/internal.ts` (tambah `POST /kv/put`)
- Modify: `apps/api-cf/src/lib/peers.ts` (tambah `peerKvSet`)
- Modify: `apps/api-cf/src/index.ts` (cron: scrape + tulis + push)

**Interfaces:**
- Consumes: `getPeers(env)`, `forwardKey` pattern dari peers.ts.
- Produces: `peerKvSet(env, key, value, expirationTtl?) → boolean` (push ke semua non-self peer).
- Produces: `router.post('/kv/put')` — body `{ key, value, expirationTtl? }`, key harus prefix `homepage:feed`, auth `x-db-forward-key`.

- [ ] **Step 1: `peers.ts` — tambah `peerKvSet`**

```ts
// KV write-forward to every non-self peer (homepage feed push). Best-effort:
// returns false if ALL peers fail; caller keeps serving its own local KV.
export const peerKvSet = async (
  env: Env,
  key: string,
  value: string,
  expirationTtl?: number
): Promise<boolean> => {
  const k = forwardKey(env);
  if (!k) return false;
  const results = await Promise.allSettled(
    getPeers(env)
      .filter((p) => !p.self)
      .map((peer) =>
        fetch(`${peer.url}/api/_internal/kv/put`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-db-forward-key': k },
          body: JSON.stringify({ key, value, expirationTtl }),
          signal: AbortSignal.timeout(5000),
        }).then((r) => r.ok)
      )
  );
  return results.some((r) => r.status === 'fulfilled' && r.value);
};
```

- [ ] **Step 2: `internal.ts` — tambah route `/kv/put`**

```ts
const KV_WRITE_ALLOW_PREFIXES = ['homepage:feed'];

router.post('/kv/put', async (c: Context) => {
  const forwardKey = c.req.header('x-db-forward-key');
  if (!forwardKey || !c.env.DB_FORWARD_KEY || !constantTimeEqualStr(forwardKey, c.env.DB_FORWARD_KEY as string)) {
    return c.json({ error: 'invalid forward key' }, 401);
  }
  let payload: { key?: string; value?: string; expirationTtl?: number };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const { key, value, expirationTtl } = payload;
  if (typeof key !== 'string' || typeof value !== 'string' || !KV_WRITE_ALLOW_PREFIXES.some((p) => key.startsWith(p))) {
    return c.json({ error: 'key not allowed' }, 403);
  }
  if (value.length > 512 * 1024) return c.json({ error: 'payload too large' }, 413);
  await c.env.CACHE_KV.put(key, value, expirationTtl ? { expirationTtl } : undefined).catch(() => null);
  return c.json({ ok: true });
});
```

- [ ] **Step 3: `index.ts` cron — scrape feed 12 jam + push ke semua akun**

Dalam `scheduled`, setelah eviction (masih dalam blok `EVICTION_OWNER === '1'`):

```ts
import { fetchHomepageFromSources } from './routes/homepage';
// ...di dalam run():
const lastUpdatedStr = await kv.get('homepage:feed:last_updated').catch(() => null);
const lastUpdated = lastUpdatedStr ? parseInt(lastUpdatedStr, 10) : 0;
if (Date.now() - lastUpdated > 12 * 60 * 60 * 1000) {
  try {
    const feed = await fetchHomepageFromSources(env as Env);
    const body = JSON.stringify({ ...feed, updated_at: Date.now() });
    await kv.put('homepage:feed', body, { expirationTtl: 43200 });
    await kv.put('homepage:feed:last_updated', String(Date.now()), { expirationTtl: 43200 });
    const pushed = await peerKvSet(env as Env, 'homepage:feed', body, 43200);
    await kv.put('homepage:feed:last_updated', String(Date.now()), { expirationTtl: 43200 });
    console.log(`[cron] homepage feed refreshed (${feed.sources_queried.length} sources), pushed=${pushed}`);
  } catch (e) {
    console.error('[cron] homepage refresh failed:', e);
  }
}
```

Perlu export `fetchHomepageFromSources` dari homepage.ts (ubah `const` → `export const`).

- [ ] **Step 4: typecheck + commit**

Run: `npx tsc --noEmit -p apps/api-cf/tsconfig.json` (hanya error pre-existing).
Commit: `feat(api): internal KV put + peerKvSet + 12h homepage cron push`

---

### Task 3: Frontend homepage → `/api/homepage`

**Files:**
- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Produces: `fetchHomepage(): Promise<{ data: MergedManga[]; sources_queried: string[]; popularity?: Record<string, number> }>`
- Consumes: `/api/homepage` — tambah ke `ORIGIN_PATH_ALLOWLIST`.

- [ ] **Step 1: `lib/api.ts` — tambah `fetchHomepage` + allowlist**

```ts
export const fetchHomepage = (): Promise<{ data: MergedManga[]; sources_queried: string[] }> =>
  apiWithFailover(`/api/homepage`);
```

Tambah `'/api/homepage'` ke `ORIGIN_PATH_ALLOWLIST`.

- [ ] **Step 2: `page.tsx` — ganti `searchMerged('')` → `fetchHomepage()`**

```tsx
import { fetchHomepage } from '@/lib/api';
// di HomeFeed:
const res = await fetchHomepage();
manga = res.data;
```

Section Populer: urutkan berdasarkan `popularity` desc, ambil 10. Update Terbaru: pertahankan urutan data (sudah insertion order = update terbaru), slice 10-22.

```tsx
const popular = [...manga].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)).slice(0, 10);
const updates = manga.slice(10, 22);
```

- [ ] **Step 3: hapus komentar stale di `lib/api.ts:89-92`**

`getSeriesList` sudah tidak dipakai — hapus fungsi + komentarnya (dead code, Task 6 formal).

- [ ] **Step 4: typecheck web + commit**

Run: `cd apps/web && npx tsc --noEmit`
Commit: `feat(web): homepage via /api/homepage (12h feed) + popularity-sorted popular`

---

### Task 4: Reader prefetch bab berikutnya (1 bab)

**Files:**
- Modify: `apps/web/components/Reader.tsx`
- Modify: `apps/web/components/ReaderShell.tsx`
- Modify: `apps/web/app/[source]/s/[slug]/[chapterId]/page.tsx`

**Interfaces:**
- Consumes: `getChapters(source, slug)` (sudah ada), `getChapter(source, chapterId)` (sudah ada).
- Produces: Reader menerima `nextChapterId?: string | null` (id asli, bukan URL) — prefetch via `getChapter` saat halaman terakhir.

- [ ] **Step 1: `Reader.tsx` — ganti prop `nextChapterUrl` → `nextChapterId` + prefetch data**

```tsx
import { getChapter } from '@/lib/api';
// props: nextChapterId?: string | null (ganti nextChapterUrl)

// Prefetch bab berikutnya: hanya 1 bab, sekali, saat user di halaman terakhir.
const prefetchedRef = useRef<string | null>(null);
useEffect(() => {
  if (!nextChapterId || visibleCount < pages.length || prefetchedRef.current === nextChapterId) return;
  prefetchedRef.current = nextChapterId;
  const t = setTimeout(() => {
    getChapter(source, nextChapterId).catch(() => {});
  }, 800);
  return () => clearTimeout(t);
}, [visibleCount, pages.length, nextChapterId, source]);
```

Note: Reader perlu prop `source` baru. Tambahkan ke interface.

- [ ] **Step 2: `page.tsx` (chapter) — ganti `nextChapterUrl` kalkulasi rapuh → id asli via chapters**

Karena ReaderShell sudah fetch `getChapters`, paling bersih: **hapus** `nextChapterUrl` dari RSC page, biarkan ReaderShell menghitung dari chapter list yang sudah di-fetch (sudah punya semua id asli):

- Hapus `nextChapterUrl`/`chapterUrl()` kalkulasi `slug-chapter-N` dari `page.tsx` dan `ReaderShell.tsx`.
- Di `ReaderShell`: dari `chapters` (sudah ada state), cari index current, ambil `chapters[i+1]?.id` (sesuai urutan sort desc? — chapters dari API urut terbaru dulu) → `nextChapterId`.

```tsx
const currentIdx = chapters.findIndex((c) => c.id === chapterId);
const nextChapterId = currentIdx >= 0 ? chapters[currentIdx - 1]?.id ?? null : null;
const prevChapterId = currentIdx >= 0 ? chapters[currentIdx + 1]?.id ?? null : null;
```

(check urutan: `chapters` dari `getChapters` — urut terbaru ke lama; pastikan dengan log kecil saat tes).

Pass `nextChapterId` + `source` ke `<Reader>`.

- [ ] **Step 3: `ReaderShell.tsx` — pakai id asli untuk prev/next Link**

```tsx
const prevUrl = prevChapterId ? `/${source}/s/${slug}/${prevChapterId}` : null;
const nextUrl = nextChapterId ? `/${source}/s/${slug}/${nextChapterId}` : null;
```

`nextDisabled` tetap dari `maxNum` (atau `!nextChapterId`).

- [ ] **Step 4: typecheck + commit**

Commit: `feat(web): reader prefetch 1 next chapter by real id + accurate prev/next nav`

---

### Task 5: Lazy loading tertarget

**Files:**
- Modify: `apps/web/app/[source]/s/[slug]/page.tsx` (poster lazy)
- Modify: `apps/web/components/ChapterList.tsx` (windowed render)
- Modify: `apps/web/components/ReaderShell.tsx` (sheet windowed)

**Interfaces:**
- Consumes: pola IntersectionObserver yang sudah ada di Reader.tsx.

- [ ] **Step 1: Poster detail series → lazy**

`[slug]/page.tsx:122` — tambah `loading="lazy"` + `decoding="async"` ke `<img>` poster (pakai `CoverImage` bila memungkinkan; cek struktur dulu).

- [ ] **Step 2: `ChapterList.tsx` — windowed render**

```tsx
const SHEET_PAGE = 40;
const [visible, setVisible] = useState(SHEET_PAGE);
const sentinelRef = useRef<HTMLDivElement | null>(null);
const ioRef = useRef<IntersectionObserver | null>(null);

useEffect(() => {
  if (!open) return;
  setVisible(SHEET_PAGE); // reset tiap buka
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) setVisible((v) => Math.min(ordered.length, v + SHEET_PAGE));
    }
  }, { rootMargin: '200px' });
  ioRef.current = io;
  if (sentinelRef.current) io.observe(sentinelRef.current);
  return () => io.disconnect();
}, [open]); // eslint-disable-line react-hooks/exhaustive-deps

// render: ordered.slice(0, visible).map(...)
// setelah map: {visible < ordered.length && <div ref={sentinelRef} className="h-8" />}
```

- [ ] **Step 3: `ReaderShell.tsx` sheet — windowed render** (pola sama, SHEET_PAGE=40)

- [ ] **Step 4: typecheck + commit**

Commit: `perf(web): lazy poster + windowed chapter sheets`

---

### Task 6: Dead code cleanup menyeluruh

**Files:**
- Modify: `apps/web/lib/api.ts` (hapus `getSeriesList` + komentar stale)
- Audit: `apps/api-cf/src` + `apps/web` via grep

- [ ] **Step 1: grep audit unused exports**

```bash
# api-cf: fungsi export tidak dipakai (selain route mount)
grep -rn "export const\|export function" apps/api-cf/src/lib | head -50
# web: komponen/lib tidak diimport
grep -rn "getSeriesList" apps/web
```

- [ ] **Step 2: hapus yang terbukti dead** (`getSeriesList`, komentar stale; hal lain yang muncul di audit)

- [ ] **Step 3: typecheck + commit**

Commit: `chore: remove dead code (getSeriesList, stale comments)`

---

### Task 7: Audit — typecheck, build, smoke test

**Files:** none (verifikasi)

- [ ] **Step 1: typecheck semua**

```bash
npx tsc --noEmit -p apps/api-cf/tsconfig.json
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 2: build bundle + web build**

```bash
node scripts/build-worker-bundle.mjs
```

- [ ] **Step 3: smoke test homepage API lokal** (bila wrangler dev feasible; minimal: pastikan bundle compile)

---

### Task 8: Deploy 4 worker + verify

- [ ] **Step 1: deploy akun-1..4** (perintah di skill §5, pakai `set -a && source .env`)
- [ ] **Step 2: verify** `/api/health` 4 worker, `/api/homepage` 200 + `cached:true` setelah 2x hit, CSRF evil origin → 403
- [ ] **Step 3: commit + push final** (pastikan semua commit terdorong)