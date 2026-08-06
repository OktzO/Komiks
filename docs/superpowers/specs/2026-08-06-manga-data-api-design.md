# Manga Data API System Design (Scraping + Image Identification)

> Spec untuk service standalone: data manga/manhua/manhwa engine. Complements existing reader-platform spec (2026-08-04). Tidak supersede.

## 1. Konteks & Keputusan

Repo sudah punya reader platform (MangaDex-first, Hono Worker `manga-api`, D1+KV+R2). Service baru ini **deploy sebagai Worker terpisah** (folder `apps/data-api/`, Worker name `manga-data-api`) tapi **reuse resource CF yang sama** (D1 `manga-db`, KV `CACHE_KV`, R2 `manga-assets`) untuk hemat + join-query. Existing `apps/api-cf` (reader) tetap utuh, tidak diubah.

### Asumsi yang diputuskan (lanjut, bukan blocking)

| # | Ambigu | Keputusan | Alasan |
|---|---|---|---|
| A1 | Reuse vs new CF resources | Reuse D1/KV/R2 + migration baru | Hemat, metadata bisa join dengan series reader |
| A2 | Framework | Hono (sama) | Konsisten |
| A3 | Scraper runtime JS-heavy | `@cloudflare/puppeteer` + `browser` binding (CF Browser Rendering) prod; Playwright MCP untuk dev/test | Spec minta Playwright MCP — itu dev side. Worker ga bisa jalan Playwright murni, pakai native CF Browser Rendering |
| A4 | Source adapters | **Komiku = sumber utama** (web scraper, puppeteer), **MangaDex = sumber kedua** (API existing). Kedua-duanya aktif | Sesuai permintaan user |
| A5 | pHash algorithm | pHash 64-bit (8x8 DCT), decode via `OffscreenCanvas` bila ada, fallback aHash | Zero-dep |
| A6 | OCR fallback | Skip MVP | Butuh CF Workers AI binding, kompleks. pHash + title search cukup di MVP |
| A7 | External reverse image search | Skip MVP | Butuh API key Google/TinEye, out of scope |
| A8 | Image upload limit | 10MB, `multipart/form-data`, content-type image/* | Wajar untuk cover manga |
| A9 | Admin auth `/scrape` | `x-admin-api-key` header === `SCRAPE_API_KEY` env, constant-time compare | Simpler dari step-up LB |
| A10 | Cache key convention | `manga:meta:{slug}`, `search:{hash}`, `identify:{hash[:8]}`, `robots:{source}` | Sesuai spec |
| A11 | Rate limit | 60/min publik, 10/min identify, 600/min admin | Admin butuh throughput |
| A12 | Robots.txt | `checkRobots()` tiap adapter init, cache 24h di KV, skip path disallow | Hormati sumber |

### Keputusan user (override spec awal)

- **Komiku = sumber utama**, MangaDex = sumber kedua (jangan dihapus, existing tetap dipakai)
- **Halaman status sumber** (`/status`): cek hidup/mati pool Komiku + MangaDex realtime
- **Beranda merge** (`/`): tampil manga dari kedua sumber, dedup by title. Kalau judul sama di kedua sumber → tampilkan badge kecil + cover dari kedua sumber. Kalau cuma ada di satu sumber → cover dari sumber itu saja (menandakan "di sumber ini bisa, sumber lain tidak")

---

## 2. Arsitektur

```
┌──────────────────────────────────────────────────────────────┐
│ apps/data-api (Worker "manga-data-api", NEW app folder)      │
│ Hono app                                                     │
│ Routes:                                                      │
│   /api/search         (publik, merge komiku+mangadex)        │
│   /api/manga/:id      (publik, detail + chapters)            │
│   /api/identify       (publik, upload gambar → pHash match)   │
│   /api/scrape         (admin, trigger scrape manual)         │
│   /api/scrape/:job_id (admin, job status)                    │
│   /api/source-status  (publik, health pool komiku+mangadex)  │
│ Middleware: CORS, rateLimit, auth(admin), errorHandler       │
└──────┬──────────────┬──────────────┬─────────────────────────┘
       │              │              │
       ▼              ▼              ▼
  ┌─────────┐   ┌──────────┐   ┌──────────────┐
  │ D1      │   │ KV       │   │ R2           │
  │ manga-db│   │ CACHE_KV │   │ manga-assets │
  │ +migration│  │ +keys    │   │ +prefix      │
  │          │  │          │   │ covers/      │
  │          │  │          │   │ pages/       │
  │          │  │          │   │ uploads/     │
  └─────────┘   └──────────┘   └──────────────┘
       ▲
       │
  ┌────┴──────────────────────────────────┐
  │ packages/sources (adapter registry)    │
  │ - komiku (PRIMARY, web, puppeteer)     │
  │ - mangadex (SECONDARY, API, existing)  │
  │ - [future source]                      │
  └─────────────────────────────────────────┘
       ▲
       │
  ┌────┴────────────────────────────────────┐
  │ packages/vision (NEW)                   │
  │ - phash.ts (pHash 64-bit, OffscreenCanvas)│
  │ - hamming.ts (Hamming distance hex)     │
  │ - identify.ts (orchestrator)            │
  │   1. hash uploaded image                │
  │   2. query image_hashes D1              │
  │   3. return candidates + confidence     │
  └──────────────────────────────────────────┘
       │
  ┌────┴────────────────────────────────────┐
  │ apps/web (Next.js, extend existing)     │
  │ - / (beranda merge komiku+mangadex)     │
  │ - /status (status pool sumber)          │
  │ - /search (gabungan)                     │
  │ - /scrape (admin panel, opsional)       │
  └──────────────────────────────────────────┘
```

---

## 3. Data Schema (D1 migration)

File: `packages/db/migrations/0001_manga_data.sql`

Reuse existing `series` + `chapters` tables. Tambah kolom + tabel baru (additive, safe — tidak break existing reader).

```sql
-- 0001_manga_data.sql
-- Extends packages/db/schema.sql. Additive only.

-- 1. Add columns to existing series table
ALTER TABLE series ADD COLUMN alt_titles TEXT;      -- JSON '[{"lang":"en","title":"One Piece"}]'
ALTER TABLE series ADD COLUMN source_url TEXT;       -- canonical URL di situs sumber
ALTER TABLE series ADD COLUMN cover_r2_key TEXT;    -- R2 object key untuk cover cached
ALTER TABLE series ADD COLUMN language TEXT;         -- original language: ja/ko/zh/id

-- 2. image_hashes: perceptual hash index untuk reverse-lookup
CREATE TABLE image_hashes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  series_slug TEXT    NOT NULL REFERENCES series(slug) ON DELETE CASCADE,
  hash        TEXT    NOT NULL,         -- 16-char hex (64-bit pHash)
  r2_key      TEXT,                     -- R2 key of indexed image (nullable for external URL)
  image_type  TEXT    NOT NULL CHECK (image_type IN ('cover','page')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_image_hashes_hash ON image_hashes(hash);
CREATE INDEX idx_image_hashes_slug ON image_hashes(series_slug);

-- 3. scrape_jobs: track scraping operations
CREATE TABLE scrape_jobs (
  id          TEXT PRIMARY KEY,
  source      TEXT    NOT NULL,           -- 'komiku' | 'mangadex' | future
  source_url  TEXT,
  query       TEXT,                       -- for search-triggered scrape
  status      TEXT    NOT NULL CHECK (status IN ('pending','running','completed','failed','skipped_robots')) DEFAULT 'pending',
  series_slug TEXT    REFERENCES series(slug) ON DELETE SET NULL,
  error       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);
CREATE INDEX idx_scrape_jobs_status ON scrape_jobs(status);
CREATE INDEX idx_scrape_jobs_series ON scrape_jobs(series_slug);

-- 4. source_health: snapshot terakhir health check per source (untuk /status page)
-- KV juga dipakai (TTL 60s), tapi D1 buat history/audit
CREATE TABLE source_health (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,           -- 'komiku' | 'mangadex'
  healthy     INTEGER NOT NULL,           -- 0/1
  latency_ms  INTEGER,
  error       TEXT,
  checked_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_source_health_source ON source_health(source, checked_at DESC);
```

**Index existing reusable:** `idx_chapters_series_slug`, FTS5 `series_search`.

**Cache key convention (KV):**
- `manga:meta:{slug}` — metadata + chapter list, TTL 1h
- `search:{sha256(q)}` — search results merge, TTL 2min
- `identify:{hash[:8]}` — identify candidates, TTL 10min
- `robots:{source}` — robots.txt parsed, TTL 24h
- `source:health:{source}` — health snapshot, TTL 60s (realtime-ish)
- `source:list:{source}:{page}` — list per source, TTL 5min

---

## 4. API Endpoints (detail)

Semua response JSON. Error: `{ error: string, detail?: string, code?: string }`. No stack trace.

### Publik

#### `GET /api/search?q=<query>&limit=20&offset=0`
- Flow:
  1. KV cache `search:{sha256(q)}` → return if hit
  2. Query D1 FTS5 `series_search` lokal dulu
  3. Kalau <3 results atau force refresh: trigger **kedua adapter** paralel (`komiku.search` + `mangadex.search`)
  4. Merge + dedup by normalized title
  5. Upsert hasil ke D1 `series`
  6. Cache `search:{hash}` TTL 2min
- Response: `{ data: Series[], total: number, sources_queried: string[], cached: boolean }`
- Setiap `Series` objek punya field `sources: string[]` (mis `['komiku','mangadex']`)
- Rate: 60/min

#### `GET /api/manga/:id`
- `:id` = slug
- Flow: KV `manga:meta:{slug}` → D1 `series` + `chapters` join
- Response: `{ data: { ...Series, chapters: Chapter[], sources: string[] } }`
- Rate: 60/min

#### `POST /api/identify` (multipart/form-data, field `image`)
- Flow:
  1. Validate: content-type image/* , size ≤ 10MB
  2. Read bytes → R2 `uploads/{uuid}.{ext}` (TTL 1h via R2 lifecycle rule)
  3. Compute pHash (64-bit)
  4. Query D1 `image_hashes` — fetch all, compute Hamming distance in JS, threshold ≤ 8 bits
  5. Match (distance ≤ 8): candidate dengan confidence = `1 - distance/64`
  6. No match: `{ candidates: [], message: "no match in index" }`
- Response: `{ candidates: [{ series: Series, confidence: number, match_type: 'phash' }[]], uploaded_key: string }`
- Rate: 10/min (heavy)
- Cache: `identify:{hash[:8]}` TTL 10min

#### `GET /api/source-status`
- Flow:
  1. KV `source:health:komiku` + `source:health:mangadex` (TTL 60s)
  2. Kalau miss: probe health check (fetch `https://komiku.id/` + `https://api.mangadex.org/health`, timeout 5s, measure latency)
  3. Cache + return
- Response: `{ data: [{ source: 'komiku', healthy: true, latency_ms: 234, last_checked_at: 1234 }, ...] }`
- Rate: 60/min

### Admin (auth: `x-admin-api-key` === `SCRAPE_API_KEY`, constant-time compare)

#### `POST /api/scrape`
- Body: `{ source: 'komiku'|'mangadex', url?: string, query?: string }`
- Flow:
  1. Validate auth
  2. `adapter.checkRobots(url)` — skip if disallow, status `skipped_robots`
  3. Create `scrape_jobs` row (status=pending)
  4. `getAdapter(source, env)`
  5. `url` → `adapter.scrapeUrl(url)` ; `query` → `adapter.search(query)` + scrape top result
  6. Upsert `series` + `chapters` to D1
  7. Fetch cover image → R2 `covers/{slug}.jpg` → pHash → insert `image_hashes`
  8. Update job status `completed`
- Response: `{ job_id: string, status: 'running', series_slug?: string }`
- Async via `c.executionCtx.waitUntil()`, return immediately
- Rate: 600/min

#### `GET /api/scrape/:job_id`
- Job status detail
- Response: `{ data: ScrapeJob }`

#### `GET /api/scrape`
- List recent jobs (last 50)
- Response: `{ data: ScrapeJob[] }`

---

## 5. Adapter Pattern Extension

Extend existing `SourceAdapter` interface di `packages/sources/index.ts`:

```typescript
export type SourceKey = 'mangadex' | 'komiku';

export interface SourceAdapter {
  sourceKey: SourceKey;
  search(params: { q: string; limit?: number; offset?: number }): Promise<Series[]>;
  getSeries(sourceId: string): Promise<Series>;
  listChapters(sourceId: string, opts?: { lang?: string; chapter?: string }): Promise<Chapter[]>;
  getChapter(chapterSourceId: string): Promise<Chapter>;
  fetchPageUrls(chapterSourceId: string): Promise<PageUrl[]>;
  // NEW
  scrapeUrl?(url: string, opts?: { browser?: Browser }): Promise<ScrapeResult>;
  checkRobots?(url: string): Promise<RobotsResult>;
  healthCheck?(): Promise<{ healthy: boolean; latency_ms: number; error?: string }>;
}

export interface ScrapeResult {
  series: Series;
  chapters: Chapter[];
  coverImageUrl: string;
}

export interface RobotsResult {
  allowed: boolean;
  disallowedPaths: string[];
  crawlDelay?: number;
}
```

### Komiku adapter (`packages/sources/komiku/`)

```typescript
// packages/sources/komiku/index.ts
import puppeteer from '@cloudflare/puppeteer';

export const komikuAdapter = (env?: AdapterEnv): SourceAdapter => {
  const BASE = 'https://komiku.id';
  return {
    sourceKey: 'komiku',
    async search({ q, limit = 20 }) {
      // komiku.id/?s=<query> — WordPress search
      const browser = await puppeteer.launch(env?.MY_BROWSER);
      try {
        const page = await browser.newPage();
        await page.goto(`${BASE}/?s=${encodeURIComponent(q)}`, { waitUntil: 'networkidle0', timeout: 30000 });
        return await page.evaluate((lim) => {
          const list = Array.from(document.querySelectorAll('.listupd .bs'));
          return list.slice(0, lim).map((el) => {
            const a = el.querySelector('a');
            const img = el.querySelector('img');
            const title = el.querySelector('.tt')?.textContent?.trim() ?? '';
            return {
              slug: a?.href?.split('/').filter(Boolean).pop() ?? '',
              title,
              source: 'komiku',
              source_url: a?.href ?? '',
              cover_image: img?.src ?? null,
              // type/status/synopsis fetched on detail
            };
          });
        }, limit);
      } finally {
        await browser.close();
      }
    },
    async scrapeUrl(url) {
      const browser = await puppeteer.launch(env?.MY_BROWSER);
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        return await page.evaluate(() => {
          // Komiku: WordPress + JSON-LD + .entry-content selectors
          const title = document.querySelector('h1.entry-title')?.textContent?.trim() ?? '';
          const synopsis = document.querySelector('.entry-content[itemprop="description"]')?.textContent?.trim();
          const cover = document.querySelector('.thumb img')?.src;
          const chapters = Array.from(document.querySelectorAll('#chapter_list li')).map(li => {
            const a = li.querySelector('a');
            return {
              id: a?.href?.split('/').filter(Boolean).pop() ?? '',
              title: a?.textContent?.trim() ?? '',
              series_slug: '', // filled by caller
              chapter_number: 0, // parsed from title
              language: 'id',
            };
          });
          return { series: { title, synopsis, cover_image: cover, source: 'komiku' }, chapters, coverImageUrl: cover };
        });
      } finally {
        await browser.close();
      }
    },
    async checkRobots(url) { /* fetch /robots.txt, parse */ },
    async healthCheck() {
      const start = Date.now();
      try {
        const res = await fetch(BASE, { signal: AbortSignal.timeout(5000) });
        return { healthy: res.ok, latency_ms: Date.now() - start };
      } catch (e) {
        return { healthy: false, latency_ms: Date.now() - start, error: String(e) };
      }
    },
    // getSeries, listChapters, getChapter, fetchPageUrls: implement via puppeteer scrape
  };
};
```

**Per-site selectors** sebagai config object di `komiku/selectors.ts`, core logic di adapter. Tambah sumber = tambah config object.

### MangaDex adapter (existing, extend)

Existing `mangadexAdapter` tetap API-based. Tambah method `healthCheck()`:

```typescript
// packages/sources/mangadex/index.ts (extend)
async healthCheck() {
  const start = Date.now();
  try {
    const res = await fetch('https://api.mangadex.org/health', { signal: AbortSignal.timeout(5000) });
    return { healthy: res.ok, latency_ms: Date.now() - start };
  } catch (e) {
    return { healthy: false, latency_ms: Date.now() - start, error: String(e) };
  }
}
```

---

## 6. Image Recognition (packages/vision)

Zero-dependency pHash di Workers:

```
packages/vision/
├── phash.ts          # pHash: image bytes → 64-bit hex (OffscreenCanvas decode + DCT)
├── hamming.ts        # Hamming distance antar hex strings
├── identify.ts       # orchestrator: hash → D1 query → candidates
├── index.ts          # exports
└── test/
    └── phash.test.mjs  # known image → known hash self-check (fixture: reader-ch1.jpeg)
```

**pHash algorithm:**
1. Decode image bytes → `OffscreenCanvas` (bila tersedia di Worker runtime)
2. Resize ke 32x32 grayscale
3. DCT 2D → ambil top-left 8x8
4. Threshold median → 64-bit hash
5. Fallback bila `OffscreenCanvas` tidak ada: aHash (average hash, simpler, 8x8 mean threshold)

**Hamming distance** (in-app JS, bukan SQL UDF): fetch candidates from D1 by hash prefix (first 4 hex = 16-bit window), compute distance, filter ≤ 8.

**Self-check** (rules: 1 runnable check): `phash.test.mjs` assert `hashImage(fixtureBytes) === 'expected_hash'`.

---

## 7. Frontend (apps/web, extend)

### Beranda `/` (rewrite existing)

```typescript
// apps/web/app/page.tsx (rewrite)
// Flow:
// 1. Fetch /api/search?q= (popular, atau fetch /api/manga list)
// 2. Setiap manga punya sources: string[]
// 3. Dedup by normalized title (case-insensitive, strip punctuation)
// 4. Untuk duplikat: tampilkan cover dari kedua sumber (badge kecil per source)
// 5. Untuk single-source: cover dari sumber itu saja, badge sumber
```

UI:
- Grid card. Tiap card: cover + title + badge sumber (kecil, pill shape).
- Kalau 2 sumber: 2 badge (Komiku, MangaDex), cover dari Komiku (primary), small thumbnail MangaDex di corner.
- Kalau 1 sumber: 1 badge, cover dari sumber itu.

Komponen baru: `SourceBadge.tsx` (pill: "Komiku" / "MangaDex" / keduanya).

### Status page `/status`

```typescript
// apps/web/app/status/page.tsx
// Fetch /api/source-status
// Tampilkan: per source, status (hidup/mati), latency, last checked
// Auto-refresh tiap 60s (client-side interval)
```

UI: card per source, hijau=healthy, merah=down, latency badge. Polling client-side.

### Search `/search` (extend existing)

Sudah ada. Update: query ke `/api/search?q=` baru (merge komiku+mangadex). Dedup same logic.

### Scrape admin `/admin/scrape` (opsional, bila time permits)

Form: source select (komiku/mangadex), URL or query input, submit → trigger `/api/scrape`. Tampilkan job status table.

---

## 8. Error Handling & Security

- **All endpoints**: try/catch, `{ error, detail? }`, no stack trace (pattern `app.onError` existing)
- **Admin auth**: `x-admin-api-key` header, constant-time compare (copy pattern dari `auth.ts` constantTimeEqual)
- **Rate limit**: 60/min publik, 10/min identify, 600/min admin. Reuse pattern `rateLimit.ts`, extend dengan per-route limit
- **Robots.txt**: `checkRobots()` sebelum scrape, skip kalau disallow, status `skipped_robots`
- **R2 upload validation**: content-type image/* only, size ≤ 10MB
- **SSRF prevention**: scraper hanya URL dari adapter whitelist (komiku.id, api.mangadex.org), no arbitrary user URL tanpa validation
- **Secrets**: semua via env var. `.dev.vars` local, `wrangler secret put` prod
- **Backoff/retry**: promote `retryUpstream()` dari reader.ts ke shared util, reuse untuk semua outgoing fetch

---

## 9. Testing & Verification

- **Self-check pHash**: `packages/vision/test/phash.test.mjs` (node, assert-based, fixture `reader-ch1.jpeg`)
- **Komiku adapter self-check**: `packages/sources/test/komiku.test.mjs` (fixture HTML, no network)
- **D1 schema smoke**: extend `scripts/smoke-db.mjs` dengan tabel baru
- **Type check**: `npx tsc --noEmit` per package
- **Playwright MCP smoke test** (sesuai spec): setelah deploy, hit semua endpoint live, verify 200 + valid JSON
  - `GET /api/health`
  - `GET /api/search?q=naruto`
  - `GET /api/manga/<slug>`
  - `POST /api/identify` (upload fixture image)
  - `POST /api/scrape` (admin)
  - `GET /api/source-status`

---

## 10. Deployment

### wrangler.toml (apps/data-api/wrangler.toml, NEW)

```toml
name = "manga-data-api"          # beda dari existing "manga-api" (apps/api-cf)
main = "./src/index.ts"
compatibility_date = "2024-08-01"
account_id = "4ce21aec2dd478bf380b7b59990a9165"

[[d1_databases]]
binding = "DB"
database_name = "manga-db"
database_id = "76606365-0fa5-4c1e-9b55-18a8366ef92a"  # reuse existing

[[kv_namespaces]]
binding = "CACHE_KV"
id = "6205fceab7b64f9d80f6f67e4189316b"  # reuse existing

[[r2_buckets]]
binding = "ASSETS_R2"
bucket_name = "manga-assets"  # reuse existing

[browser]
binding = "MY_BROWSER"  # CF Browser Rendering
remote = true
```

### Steps

1. Buat folder `apps/data-api/` (sibling dari `apps/api-cf/`), scaffold Hono app + wrangler.toml
2. Buat migration file `packages/db/migrations/0001_manga_data.sql`
3. `npx wrangler d1 execute manga-db --file=packages/db/migrations/0001_manga_data.sql --remote`
3. Setup secrets:
   ```bash
   wrangler secret put SCRAPE_API_KEY     # random 32-byte string
   # reuse: MANGADEX_API_KEY, LB_ENCRYPTION_KEY, ALLOWED_ORIGINS
   ```
4. `npx wrangler deploy` (Worker name `manga-data-api`)
5. Smoke test via Playwright MCP
6. Update `apps/web/.env.production` dengan `NEXT_PUBLIC_DATA_API_URL=https://manga-data-api.<sub>.workers.dev`

### Frontend deploy

`apps/web` tetap CF Pages. Update `lib/api.ts` dengan `DATA_API_URL` untuk endpoint baru. Rewrite `app/page.tsx` (beranda merge). Tambah `app/status/page.tsx`. Deploy Pages.

---

## 11. Yang Skipped (Next Steps)

- **OCR fallback** (A6): tambah bila pHash match rate < 70% di real data. Upgrade path: CF Workers AI binding `@cf/meta/llama-3.2-11b-vision-instruct`
- **External reverse image search** (A7): tambah bila index lokal < 1000 entries dan no-match rate tinggi
- **Image decode di Worker**: kalau `OffscreenCanvas` tidak supported, fallback ke aHash atau decode via puppeteer browser session
- **Scheduled scrape refresh**: cron job untuk re-scrape series yang updated_at > 7 hari. Cron `0 */6 * * *` (6 jam) — beda dari existing LB health `* * * * *`
- **Scrape admin panel**: `/admin/scrape` page — opsional MVP, bisa via curl/Postman dulu
- **Deduplication smarter**: normalized title matching saja di MVP. Kalau perlu, fuzzy matching (Levenshtein) di next iteration
