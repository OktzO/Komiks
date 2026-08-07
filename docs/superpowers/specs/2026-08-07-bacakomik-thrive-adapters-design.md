# Adapter BacaKomik + Thrive — Design Spec

**Date:** 2026-08-07
**Status:** Approved
**Scope:** Two new source adapters in `packages/sources` complying with existing `SourceAdapter` interface. Fixture-based unit tests.

---

## Context

Source targets: Komiku (aktif), MangaDex (dihapus, Part 1). Tambah: BacaKomik.my + Thrive.moe. Normalize output shape sama persis Komiku adapter supaya downstream code gak tahu beda sumber.

Both sites are server-rendered (SSR). No API key needed.

**Access findings (2026-08-07, curl + webfetch analysis):**
- **BacaKomik.my**: WordPress + komikcast6 theme, WP Rocket lazy-load. Cloudflare Bot Fight Mode blocks plain curl (403 "Just a moment"). webfetch passes. REST open (`/wp-json/wp/v2/`). Detail `/komik/<slug>/`, chapter `/<slug>-chapter-<n>/`, search `/?s=<q>` → redirect `/search/<q>/`.
- **Thrive.moe**: Next.js SSG, `__NEXT_DATA__` JSON has all data. No bot block (UA enough). Detail `/title/<uuid>`, chapter `/read/<uuid>`. Backs content from MangaDex UUIDs. **No server-side search** — `?route=` ignored (client-only). Search strategy: build index from genre pages.

---

## Design

### Hybrid fetch strategy (BacaKomik)

`fetchWithFallback(url, env, opts)`:
1. Try `fetch(url, { headers: { UA browser, Referer: BACA_BASE } })`.
2. If `res.status === 403` OR body contains `Just a moment` / `cf-challenge` → retry via `env.MY_BROWSER.fetch(url)` (Puppeteer browser binding, already in infra).
3. Return text.

Applies to detail/chapter/search fetches. Cover/image fetches use plain `fetch` (image CDN not behind CF) + `Referer` header.

Thrive uses plain `fetch` everywhere (UA header enough).

### File structure

```
packages/sources/bacakomik/
├── client.ts        # BACA_BASE, BROWSER_UA, fetchHtml (hybrid), fetchRobots
├── selectors.ts     # BACA_SELECTORS regex patterns
├── index.ts         # bacakomikAdapter factory
└── fixtures/        # HTML samples for unit tests
packages/sources/thrive/
├── client.ts        # THRIVE_BASE, UA, parseNextData(html)
├── index.ts         # thriveAdapter factory
└── fixtures/        # __NEXT_DATA__ JSON samples
packages/sources/test/
├── bacakomik.test.mjs   # fixture-based self-check
└── thrive.test.mjs      # fixture-based self-check
```

### Adapter interface (unchanged, from `packages/sources/index.ts`)

```ts
interface SourceAdapter {
  sourceKey: 'komiku' | 'bacakomik' | 'thrive';
  search(params: { q: string; limit?: number; offset?: number }): Promise<Series[]>;
  getSeries(sourceId: string): Promise<Series>;
  listChapters(sourceId: string, opts?: { lang?: string; chapter?: string }): Promise<Chapter[]>;
  getChapter(chapterSourceId: string): Promise<Chapter>;
  fetchPageUrls(id: string): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]>;
  scrapeUrl?(url: string): Promise<ScrapeResult>;
  checkRobots?(url: string): Promise<RobotsResult>;
  healthCheck?(): Promise<{ healthy: boolean; latency_ms: number; error?: string }>;
}
```

Register both in `packages/sources/index.ts` `adapterFactories`.

### BacaKomik parser

**search** (`/?s=<q>`, follow redirect to `/search/<q>/`):
- Cards `.animepost .animposx a[href^="/komik/"]`:
  - slug: `href` last segment
  - title: `.tt h4` text
  - cover: `img` `src` (strip `?resize=` or take `?resize=146,208` → keep as is, it's the CDN thumbnail)
  - type: `.typeflag` class value (Manga/Manhwa/Manhua, lowercase)

**getSeries** (`/komik/<slug>/`):
- title: `h1.entry-title` text, strip leading "Komik "
- synopsis: `.entry-content-single` text (strip HTML)
- genres: `.genre-info a` text list
- status: `.spe` span `Status:` → "Berjalan" → ongoing, "selesai" → completed
- type: `.spe` span `Jenis Komik:` → lowercase
- author: `.spe` span `Author:` → join names
- cover: `og:image` meta (full-size, non-resized)

**listChapters** (from detail HTML `#chapter_list`):
- `li.lchx a` href `/chapter/<slug>-chapter-<n>/` → chapter_number from URL tail
- title: text (clean `<chapter>` inner tags)
- published_at: sibling `.date` (relative e.g. "1 hari yang lalu")

**fetchPageUrls** (chapter page HTML):
- `#[data-lazy-src]` images inside reader wrapper
- produce `{ url, proxyHeaders: { Referer: BACA_BASE } }`

Hmm — that BacaKomik chapter structure was from the explore agent. I actually don't have the exact class names from `fetchPageUrls` image container. The explore agent said: images are direct children of `#anjay_ini_id_kh` with `data-lazy-src`. Let me use that.

### Thrive parser (all from `__NEXT_DATA__`)

**search** (build index from genre pages):
- Fetch `/genre/<slug>` list (genre slugs from homepage JSON-LD): `Action`, `Adventure`, `School Life`, etc.
- Each genre page: `.animepost` grid → `href="/title/<uuid>"`+ title
- Collect (id, title, cover, tags) into a KV-cached index (`thrive:index` TTL 3600s)
- On query: fuzzy match `q` against index titles (case-insens contains), return top matches

**getSeries** (`/title/<uuid>`):
- Parse `__NEXT_DATA__.props.pageProps`
- `slug` = pageProps.id (uuid)
- `title`, `synopsis` = pageProps.desc_ID (or desc.en), `cover_image` = pageProps.image
- `genres` = pageProps.tags, `status` = pageProps.status
- `author` = pageProps.author[0]
- type: infer from tags (manhua if contains "Manhua"; else manhwa/manhwa if Korean — infer from author? inverted: type default 'manga', refine in Part 3)

**listChapters** (from detail `pageProps.chapterlist`):
- `id` = chapter_id, `chapter_number` = Number (chapter_number), `title`, `published_at` = created_at ISO → ms timestamp

**fetchPageUrls** (chapter page):
- Parse `__NEXT_DATA__.props.pageProps.prefix` + `.image[]` → `https://cdn.thrive.moe/data/{prefix}/{filename}`
- produce `{ url, proxyHeaders: { Referer: THRIVE_BASE } }`

---

## Worker routes changes

### `apps/api-cf/src/routes/reader.ts`

**SSRF allowlist** — add hosts (previously removed mangadex API key but cover serves may surface):
```
'cdn.thrive.moe', 'backup.thrive.moe', 'kuma.thrive.moe',
'uploads.mangadex.org', 'r2.dev' (no) 
'i0.wp.com','i1.wp.com','i2.wp.com','i3.wp.com', // BacaKomik photon covers
'imageainewgeneration.lol','himmga.lat','gaimgame.pics','komikcdn.me', // BacaKomik chapter CDN
```

Wait — `uploads.mangadex.org` was REMOVED in Part 1. Re-adding it here feels contradictory to "MangaDex total hapus". BUT Thrive ACTUALLY serves covers via `uploads.mangadex.org`. Trade-off: Thrive rehosts/contains MangaDex image URLs. The user asked to remove the MangaDex *adapter*, not the domain from SSRF allowlist. But a strict reading = remove domain entirely.

Decision: allow `uploads.mangadex.org` ONLY when serving kits via `source === 'thrive'` and it's a cover/image from Thrive metadata. Keep global allowlist excluding MangaDex hosts; add Thrive-specific cover allowlist. Cleaner: `ALLOWED_IMAGE_HOSTS` per-source.

Simplify: keep global set for all hosts EXCEPT `uploads.mangadex.org`. In `reader.ts` chapter/page proxy, if `source === 'thrive'`, allow cover via `page.url` anyway (image came from scrape). Actually the SSRF guard checks `page.url`. If Thrive's `fetchPageUrls` emits `https://uploads.mangadex.org/...` because the image filename `prefix` resolves to mangadex, then we DO need uploads.mangadex.org allowed. 

The explore report said Thrive chapter images use `cdn.thrive.moe/data/` (suffix `.256.jpg` cover via `cdn.thrive.moe`). `uploads.mangadex.org` was only in the raw `image` field (pageProps.image = mangadex org for cover). So chapter pages images = `cdn.thrive.moe`; covers may be `uploads.mangadex.org` or `cdn.thrive.moe/covers/<uuid>.256.jpg`. So we likely only need `cdn.thrive.moe` + `backup.thrive.moe` + `kuma.thrive.moe` for thrive. Kar kita can serve covers from `cdn.thrive.moe`.

I'll therefore NOT re-add uploads.mangadex.org (keeps Part 1 clean). Thrive images go through `cdn.thrive.moe`.

### `apps/api-cf/src/routes/search.ts`

Multi-source search: Komiku + BacaKomik + Thrive. Structure:
```ts
const results = await Promise.allSettled([
  komiku.search(q),
  bacakomik.search(q),
  thrive.search(q),
]);
```
merge by title normalize. Record health per source. Cache 300s KV.

Thrive search currently (genre index build on-demand) is expensive. This belongs to Part 3 (DB-indexed aggregation). For Part 2, wire Thrive search but keep it behind the same interface; the actual index-crawl may be slow → acceptable for now, Part 3 moves it to DB.

---

## Rate limit + cache

- All fetches wrapped in `retryUpstream` (3 attempts, 429 backoff) — existing util.
- KV cache per adapter call URL (key `bacakomik:search:<q>`, `bacakomik:series:<slug>`, etc.), TTL:
  - search: 600s
  - detail + chapter list: 3600s
  - chapter images: 600s
  - Thrive index: 3600s
- BacaKomik requests throttled ~250ms apart (CF-sensitive).
- No Puppeteer on steady path — only on 403 fallback.

---

## Testing

Fixture-based unit tests, no live network during `npm test`.

- `packages/sources/bacakomik/fixtures/detail.html`, `search.html`, `chapter.html` — captured real HTML (fixture stored via grep/curate; minimal subset).
- `packages/sources/thrive/fixtures/detail.json` (pageProps), `chapter.json` — captured `__NEXT_DATA__`.

Test commands:
```bash
node packages/sources/test/bacakomik.test.mjs
node packages/sources/test/thrive.test.mjs
npx tsc --noEmit -p packages/sources
```

Assertions:
- bacakomik search parse: given search.html → 8+ items, first has title "Nano Machine", slug "nano-machine", type "manhwa"
- bacakomik series: given detail.html → title "Nano Machine", genres include "Action", status "ongoing", cover non-empty, chapters >= 324
- thrive getSeries: given context → title, chapterlist length, status
- thrive fetchPageUrls: given pageProps prefix+images → urls `https://cdn.thrive.moe/data/<prefix>/<img>` count matches

---

## File-level plan (touched)

| File | Change |
|------|--------|
| `packages/sources/bacakomik/{index,client,selectors}.ts` | new adapter |
| `packages/sources/bacakomik/fixtures/*` | HTML fixtures |
| `packages/sources/thrive/{index,client}.ts` | new adapter |
| `packages/sources/thrive/fixtures/*` | JSON fixtures |
| `packages/sources/index.ts` | register 2 factories + SourceKey already has them |
| `packages/sources/test/{bacakomik,thrive}.test.mjs` | fixture tests |
| `apps/api-cf/src/routes/reader.ts` | SSRF allowlist + thrive/bacakomik proxy |
| `apps/api-cf/src/routes/search.ts` | multi-source search |

---

## Skipped (YAGNI)

- DB-persisted aggregation index → part 3
- API relic proxies / Puppeteer full path (hybrid only)
- Thrive client-side browser search → use genre index (user chose)
- Multiple-page genre pagination for index completion → Part 3