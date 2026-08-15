import { Hono } from 'hono';
import { getAdapter, type AdapterEnv } from '@manga-platform/sources';
import type { Series, Chapter } from '@manga-platform/shared';
import { b2KeyFor } from '@manga-platform/shared/r2-routing';
import { drainResponse } from '@manga-platform/shared/http';
import { getDb } from '../lib/context';
import type { Env, Context } from '../lib/context';
import { allowedOriginFor } from '../lib/context';
import { retryUpstream } from '../lib/retry';
import { readThroughCache, matchEdgeCache, putEdgeCache, waitForLockClear } from '../lib/readThroughCache';
import { resolveB2Accounts, pickB2AccountIdx, type B2Account } from '../lib/b2Config.ts';
import { b2PutObject, b2PresignedGet } from '../lib/s3Upload.ts';
import { parseSlugFromChapterId } from '../lib/komikuSlug.ts';
import { evictStaleStorage } from '../lib/storageEviction.ts';

export const router = new Hono<{ Bindings: Env }>();

// Fail-closed CORS origin for image responses. Returns null when no origin
// matches — callers should omit the header entirely in that case.
const corsOriginFor = (env: Env, requestOrigin: string | undefined): string | null =>
  allowedOriginFor(env, requestOrigin);

const setCorsHeaders = (env: Env, headers: Headers, requestOrigin?: string): void => {
  const o = corsOriginFor(env, requestOrigin);
  if (o) {
    headers.set('Access-Control-Allow-Origin', o);
    headers.set('Vary', 'Origin');
  }
};

const cacheGet = async <T>(c: Context, key: string): Promise<T | null> => {
  const raw = await c.env.CACHE_KV.get(key, 'json').catch(() => null);
  return (raw as T) ?? null;
};

const cachePut = (c: Context, key: string, value: unknown, ttl: number): void => {
  c.executionCtx.waitUntil(c.env.CACHE_KV.put(key, JSON.stringify(value), { expirationTtl: ttl }).catch(() => {}));
};

// Passive source health: record outcome of user activity, no dedicated ping.
const recordHealth = (c: Context, source: string, start: number, ok: boolean, error?: string) => {
  c.executionCtx.waitUntil(
    getDb(c).recordSourceHealth({
      source,
      healthy: ok,
      latencyMs: Date.now() - start,
      error: ok ? null : (error ?? 'unknown error'),
    }).catch(() => {})
  );
};

// SSRF guard: allowlist of known image-host hostnames. Blocks proxying to
// arbitrary internal/private URLs that could be injected via scraped content.
const ALLOWED_IMAGE_HOSTS = new Set([
  'img.komiku.org',
  'komiku.org',
  // BacaKomik image hosts (chapter CDN rotates among these)
  'imageainewgeneration.lol',
  'himmga.lat',
  'gaimgame.pics',
  'komikcdn.me',
  'i0.wp.com',
  'i1.wp.com',
  'i2.wp.com',
  'i3.wp.com',
  // ManhwaIndo image hosts
  'kacu.gmbr.pro',
  'upload.gmbr.pro',
  // Thrive image hosts
  'cdn.thrive.moe',
  'backup.thrive.moe',
  'kuma.thrive.moe',
]);

const isPrivateIp = (host: string): boolean => {
  // Block RFC1918, loopback, link-local, metadata endpoint.
  if (host === 'localhost' || host === '169.254.169.254') return true;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|0\.)/.test(host)) return true;
  return false;
};

const isAllowedImageUrl = (raw: string): boolean => {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (isPrivateIp(host)) return false;
  // Allow known image hosts outright.
  if (ALLOWED_IMAGE_HOSTS.has(host)) return true;
  return false;
};

// Fetch page URLs with KV caching to avoid re-hitting the source CDN
// on every image request (prevents 429 rate-limit → 502 cascade).
const fetchPageUrlsWithCache = async (
  c: Context,
  source: string,
  chapterId: string
): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> => {
  const cacheKey = `pages:${source}:${chapterId}`;
  const cached = await cacheGet<{ url: string; proxyHeaders?: Record<string, string> }[]>(c, cacheKey);
  if (cached) return cached;

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) throw new Error('unknown source');

  const pages = await retryUpstream(() => adapter.fetchPageUrls(chapterId));
  cachePut(c, cacheKey, pages, 600);
  return pages;
};

// Resolve slug manga dari chapterId: D1 dulu (akurat), cache KV 1 jam,
// fallback parse dari format '<slug>-chapter-<num>'.
const resolveKomikuSlug = async (c: Context, chapterId: string): Promise<string | null> => {
  const cacheKey = `slug:${chapterId}`;
  const cached = await cacheGet<string>(c, cacheKey);
  if (cached) return cached;
  try {
    const ch = await getDb(c).getChapter(chapterId);
    if (ch?.series_slug) {
      cachePut(c, cacheKey, ch.series_slug, 3600);
      return ch.series_slug;
    }
  } catch { /* fall through to parse */ }
  const parsed = parseSlugFromChapterId(chapterId);
  if (parsed) cachePut(c, cacheKey, parsed, 3600);
  return parsed;
};

// Update chapter:detail KV cache setelah upload sukses — biar request
// berikutnya dapat b2Url langsung (KV TTL 300s, tanpa refresh).
const touchChapterDetailKv = async (
  c: Context,
  source: string,
  chapterId: string,
  pageNo: number,
  b2Accounts: B2Account[],
  b2Key: string,
  accountIdx: number
): Promise<void> => {
  const key = `chapter:detail:${source}:${chapterId}`;
  const raw = await c.env.CACHE_KV.get(key).catch(() => null);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { data?: { pages?: Array<{ proxyUrl: string; b2Url?: string | null }> } };
    if (!parsed.data?.pages) return;
    const idx = pageNo - 1;
    if (idx < 0 || idx >= parsed.data.pages.length) return;
    // accountIdx < 0 → B2 account -(idx+1). R2 path removed.
    if (accountIdx < 0 && b2Accounts.length > 0) {
      const arrIdx = -(accountIdx + 1);
      const b2 = b2Accounts[arrIdx];
      if (b2) parsed.data.pages[idx].b2Url = await b2PresignedGet(b2, b2Key).catch(() => null);
    }
    await c.env.CACHE_KV.put(key, JSON.stringify(parsed), { expirationTtl: 300 }).catch(() => {});
  } catch { /* corrupt cache → ignore, next refresh repopulates */ }
};

// Resolve B2 account for a given accountIdx (negative = B2).
const b2AccountByIdx = (b2Accounts: B2Account[], accountIdx: number): B2Account | null => {
  if (accountIdx >= 0 || b2Accounts.length === 0) return null;
  const arrIdx = -(accountIdx + 1);
  if (arrIdx < 0 || arrIdx >= b2Accounts.length) return null;
  return b2Accounts[arrIdx];
};

// Upload gambar ke B2 storage tier (background) + catat D1. Idempoten:
// key sama → overwrite sama. Race 2 request paralel aman.
// Hash-pick → mulai dari akun itu; gagal → fallback ke akun lain (wrapping).
// R2 path removed per projek: semua asset ke B2.
const uploadToStorage = async (c: Context, opts: { source: string; slug: string; chapterId: string; pageNo: number; imageUrl: string; contentType: string; body: ReadableStream | ArrayBuffer }): Promise<void> => {
  const b2Key = b2KeyFor(opts.source, opts.slug, opts.chapterId, opts.pageNo);
  const b2Accounts = resolveB2Accounts(c.env.B2_CONFIG, c.env.B2_ACCOUNTS);

  // Hash pick → start at that account; on failure fall back to the others
  // (wrapping) instead of a fixed ordered chain.
  const startIdx = pickB2AccountIdx(b2Accounts, b2Key);
  for (let k = 0; k < b2Accounts.length; k++) {
    const i = (startIdx + k) % b2Accounts.length;
    const b2 = b2Accounts[i];
    const accountIdx = -(i + 1); // -1, -2, ... → B2 account index
    try {
      const res = await b2PutObject(b2, b2Key, opts.body as ArrayBuffer, opts.contentType);
      if (res.ok) {
        await getDb(c).markPageB2Uploaded({
          chapterId: opts.chapterId,
          pageNumber: opts.pageNo,
          imageUrl: opts.imageUrl,
          b2Key,
          b2AccountIdx: accountIdx,
        });
        await touchChapterDetailKv(c, opts.source, opts.chapterId, opts.pageNo, b2Accounts, b2Key, accountIdx);
        return;
      }
      console.error(`[b2:${b2.name}] upload ${res.status} → next tier: ${opts.source}/${opts.slug}/${opts.chapterId}/${opts.pageNo}`);
    } catch (e) {
      console.error(`[b2:${b2.name}] upload failed → next tier: ${String(e)}`);
    }
  }

  // Semua B2 gagal → proxy-only mode (response user tetap jalan).
};

// Consolidated series detail + chapters in a single Worker invocation.
// GET /api/reader/:source/series/:sourceId/detail?lang=id
// Returns { data: { ...series, chapters: [...] } }.
//
// Cache strategy: two-tier (fresh 10min + stale 24h) with stale-while-revalidate
// + circuit breaker per source. When the upstream DDoS-guard 502s (Komiku),
// we serve last-known-good stale instead of failing the reader. This is the
// primary mitigation for the intermittent 502s on detail pages.
router.get('/:source/series/:sourceId/detail', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const lang = c.req.query('lang') || 'id';
  const cacheKey = `series:full:${source}:${sourceId}:${lang}`;

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);

  const start = Date.now();
  try {
    const result = await readThroughCache<{ data: { chapters: Chapter[] } & Record<string, unknown> }>(
      c,
      cacheKey,
      async () => {
        // Prefer getSeriesDetail (single upstream fetch) — falls back to
        // Promise.all([getSeries, listChapters]) for adapters that don't implement it.
        // The single-fetch path avoids double-requesting the same detail-page URL,
        // which triggered intermittent 502s from Komiku's DDoS-guard edge.
        let r: { series: Series; chapters: Chapter[] };
        if (adapter.getSeriesDetail) {
          const detail = adapter.getSeriesDetail;
          r = await retryUpstream(() => detail(sourceId, { lang }));
        } else {
          const [series, chapters] = await Promise.all([
            retryUpstream(() => adapter.getSeries(sourceId)),
            retryUpstream(() => adapter.listChapters(sourceId, { lang })),
          ]);
          r = { series, chapters };
        }
        const { series, chapters } = r;
        // Index chapterId → slug (KV 1 jam) supaya R2 cache-aside bisa resolve
        // slug dari chapterId (thrive pakai uuid yang tidak bisa di-parse).
        //
        // KV WRITE THROTTLE: Previously this loop wrote a KV key for EVERY chapter
        // in the series (e.g. 200 chapters = 200 KV writes). Now we batch-write
        // only the first 50 chapters — enough for the most-accessed recent
        // chapters, and the rest lazily resolve via D1 on first page proxy request.
        // This cuts KV writes by ~75% for large series.
        c.executionCtx.waitUntil(
          (async () => {
            const maxToIndex = Math.min(chapters.length, 50);
            for (let i = 0; i < maxToIndex; i++) {
              const ch = chapters[i];
              try { await cachePut(c, `slug:${ch.id}`, series.slug, 3600); } catch { /* best-effort */ }
            }
          })()
        );
        return { data: { ...series, chapters } };
      },
      { circuitKey: `reader:${source}:detail` }
    );
    recordHealth(c, source, start, true);
    const maxAge = result.source === 'stale' ? 30 : 600;
    c.header('Cache-Control', `public, s-maxage=${maxAge}, stale-while-revalidate=1800`);
    if (result.source === 'stale') c.header('X-Cache', 'stale');
    return c.json(result.data);
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Series detail: GET /api/reader/:source/series/:sourceId
// Two-tier cache (fresh 10min + stale 24h) — serves last-known-good when
// the upstream DDoS-guard 502s instead of failing the reader.
router.get('/:source/series/:sourceId', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const cacheKey = `series:detail:${source}:${sourceId}`;

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const result = await readThroughCache<{ data: Series }>(
      c,
      cacheKey,
      async () => ({ data: await retryUpstream(() => adapter.getSeries(sourceId)) }),
      { circuitKey: `reader:${source}:detail` }
    );
    recordHealth(c, source, start, true);
    return c.json(result.data);
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Chapter list for a series: GET /api/reader/:source/series/:sourceId/chapters?lang=id
router.get('/:source/series/:sourceId/chapters', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const lang = c.req.query('lang') || 'id';
  const cacheKey = `chapters:list:${source}:${sourceId}:${lang}`;

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const result = await readThroughCache<{ data: Chapter[] }>(
      c,
      cacheKey,
      async () => ({ data: await retryUpstream(() => adapter.listChapters(sourceId, { lang })) }),
      { freshTtl: 300, circuitKey: `reader:${source}:detail` }
    );
    recordHealth(c, source, start, true);
    return c.json(result.data);
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Aggregated sources for a manga: GET /api/reader/:source/series/:sourceId/sources
// 1) Uses manga_source_link aggregation (D1) when rows exist.
// 2) Fallback (live-resolve): searches the OTHER sources for the same title so
//    the source switcher works even before any scrape has persisted rows.
router.get('/:source/series/:sourceId/sources', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const cacheKey = `sources:${source}:${sourceId}`;
  const cached = await cacheGet<{ data: unknown }>(c, cacheKey);
  if (cached) return c.json(cached);

  const db = getDb(c);
  try {
    // 1. Aggregated rows first.
    const manga = await db.getMangaBySource(source, sourceId).catch(() => null);
    let canonicalId: number | null = null;
    if (manga) {
      canonicalId = manga.id;
    } else {
      const row = await c.env.DB.prepare('SELECT id FROM series WHERE slug = ?1 LIMIT 1').bind(sourceId).first<{ id: number }>();
      canonicalId = row?.id ?? null;
    }

    let links: Array<{ source: string; sourceSlug: string; hasChapterList: boolean; chapterCount: number }> = [];
    let canonicalSlug: string | null = null;
    if (canonicalId) {
      const rows = await db.getSourceLinksByManga(canonicalId);
      links = rows.map((l) => ({ source: l.source, sourceSlug: l.source_slug, hasChapterList: l.has_chapter_list === 1, chapterCount: l.chapter_count }));
      const canonicalRow = await c.env.DB.prepare('SELECT slug FROM series WHERE id = ?1').bind(canonicalId).first<{ slug: string }>();
      canonicalSlug = canonicalRow?.slug ?? null;
    }

    // 2. Live-resolve when aggregation is empty (or missing current source).
    const hasCurrent = links.some((l) => l.source === source);
    if (links.length === 0 || !hasCurrent) {
      const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
      if (adapter) {
        const series = await adapter.getSeries(sourceId).catch(() => null);
        if (series?.title) {
          const norm = series.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const resolved: Array<{ source: string; sourceSlug: string; hasChapterList: boolean; chapterCount: number }> = [];
          const all = await Promise.all(
            (['komiku', 'bacakomik', 'manhwaindo', 'thrive'] as const)
              .filter((s) => s !== source)
              .map(async (s) => {
                const a = getAdapter(s, c.env as unknown as AdapterEnv);
                if (!a) return null;
                const results = await a.search({ q: series!.title.slice(0, 60), limit: 10 }).catch(() => []);
                // Prefer exact normalized title match; fallback to prefix match.
                const exact = results.find((r) => {
                  const n = r.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                  return n === norm;
                });
                const hit = exact ?? results.find((r) => {
                  const n = r.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                  return norm.length > 10 && n.startsWith(norm.slice(0, 20));
                });
                return hit ? { source: s, sourceSlug: hit.slug, hasChapterList: true, chapterCount: 0 } : null;
              })
          );
          for (const r of all) {
            if (r) resolved.push(r);
          }
          // Merge with any aggregated links (dedupe by source).
          const seen = new Set(resolved.map((r) => r.source));
          for (const l of links) {
            if (!seen.has(l.source)) {
              resolved.push(l);
              seen.add(l.source);
            }
          }
          links = resolved;

          // Auto-index (background, best-effort): persist resolved links to D1
          // so the aggregation index builds itself from user activity without
          // needing manual scrape jobs. The current source's series row is the
          // canonical entry.
          c.executionCtx.waitUntil((async () => {
            try {
              const slug = series!.slug || sourceId;
              await db.upsertSeries({
                slug,
                title: series!.title,
                external_id: series!.external_id ?? sourceId,
                source,
                synopsis: series!.synopsis ?? null,
                type: series!.type,
                status: series!.status ?? 'ongoing',
                author: series!.author ?? null,
                artist: series!.artist ?? null,
                cover_image: series!.cover_image ?? null,
                genres: series!.genres,
                source_url: (series as unknown as Record<string, unknown>).source_url as string ?? null,
                language: (series as unknown as Record<string, unknown>).language as string ?? null,
              });
              const row = await c.env.DB.prepare('SELECT id FROM series WHERE slug = ?1 LIMIT 1').bind(slug).first<{ id: number }>();
              if (!row) return;
              await db.upsertSourceLink({
                mangaId: row.id,
                source,
                sourceSlug: sourceId,
                hasChapterList: 1,
                chapterCount: 0,
                lastScrapedAt: Math.floor(Date.now() / 1000),
              });
              for (const r of resolved) {
                await db.upsertSourceLink({
                  mangaId: row.id,
                  source: r.source,
                  sourceSlug: r.sourceSlug,
                  hasChapterList: r.hasChapterList ? 1 : 0,
                  chapterCount: r.chapterCount,
                  lastScrapedAt: Math.floor(Date.now() / 1000),
                });
              }
            } catch (e) { console.error('[sources] auto-index failed:', String(e)); }
          })());
        }
      }
    }

    const data = {
      sources: links.map((l) => ({
        source: l.source,
        sourceSlug: l.sourceSlug,
        hasChapterList: l.hasChapterList,
        chapterCount: l.chapterCount,
      })),
      canonicalSlug,
    };
    cachePut(c, cacheKey, { data }, 600);
    return c.json({ data });
  } catch {
    return c.json({ data: { sources: [], canonicalSlug: null } });
  }
});

// Chapter detail + proxy page URLs: GET /api/reader/:source/chapter/:chapterId
router.get('/:source/chapter/:chapterId', async (c: Context) => {
  const { source, chapterId } = c.req.param();
  const cacheKey = `chapter:detail:${source}:${chapterId}`;
  const cached = await cacheGet<{ data: unknown }>(c, cacheKey);
  if (cached) return c.json(cached);

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const chapter = await retryUpstream(() => adapter.getChapter(chapterId));
    const pages = await fetchPageUrlsWithCache(c, source, chapterId);
    const proxyBase = `/api/reader/${source}/page/${encodeURIComponent(chapterId)}`;
    // Storage lookup: object yang sudah di-upload → URL langsung (B2 presigned
    // atau R2 public domain) biar serve tidak lewat Worker. r2_account_idx=-1
    // = B2, >=0 = akun R2 ring. Object new → null → frontend pakai proxy
    // (yang sekaligus meng-upload → request berikutnya dapat URL langsung).
    const stored = await c.env.DB.prepare(
      'SELECT page_number, r2_key, r2_account_idx FROM chapter_pages WHERE chapter_id = ?1'
    ).bind(chapterId).all<{ page_number: number; r2_key: string; r2_account_idx: number }>().catch(() => null);
    const storedByPage = new Map<number, { r2Key: string; accountIdx: number }>();
    for (const row of stored?.results ?? []) storedByPage.set(row.page_number, { r2Key: row.r2_key, accountIdx: row.r2_account_idx });
    const b2Accounts = resolveB2Accounts(c.env.B2_CONFIG, c.env.B2_ACCOUNTS);
    const data = {
      ...chapter,
      // B2 presign per page — Promise.all biar paralel.
      pages: await Promise.all(pages.map(async (_, i) => {
        const pageNo = i + 1;
        const row = storedByPage.get(pageNo);
        let b2Url: string | null = null;
        if (row && row.accountIdx < 0) {
          const b2 = b2AccountByIdx(b2Accounts, row.accountIdx);
          if (b2) b2Url = await b2PresignedGet(b2, row.r2Key).catch(() => null);
        }
        return { proxyUrl: `${proxyBase}/${pageNo}`, b2Url };
      })),
    };
    // LRU touch: update last_access untuk pages yang diakses (background).
    c.executionCtx.waitUntil((async () => {
      for (let i = 0; i < pages.length; i++) {
        await getDb(c).touchPageLastAccess(chapterId, i + 1).catch(() => {});
      }
      // Eviction trigger: every 100th chapter detail request, run LRU evict.
      // eviction:tick gets a 24h TTL so the key doesn't persist forever.
      const tickRaw = await c.env.CACHE_KV.get('eviction:tick').catch(() => '0');
      const tick = (Number(tickRaw) || 0) + 1;
      c.executionCtx.waitUntil(c.env.CACHE_KV.put('eviction:tick', String(tick), { expirationTtl: 86400 }).catch(() => {}));
      if (tick % 100 === 0) {
        c.executionCtx.waitUntil(evictStaleStorage(c.env).catch(() => {}));
      }
    })());
    cachePut(c, cacheKey, { data }, 300);
    recordHealth(c, source, start, true);
    return c.json({ data });
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Image proxy: GET /api/reader/:source/page/:chapterId/:pageNo
router.get('/:source/page/:chapterId/:pageNo', async (c: Context) => {
  const { source, chapterId, pageNo } = c.req.param();
  const n = Number(pageNo);
  if (!Number.isInteger(n) || n < 1 || n > 10000) return c.json({ error: 'bad page number' }, 400);

  const retry = Number(c.req.query('retry')) || 0;

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);

  let pages: { url: string; proxyHeaders?: Record<string, string> }[];
  try {
    pages = await fetchPageUrlsWithCache(c, source, chapterId);
  } catch (e) {
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }

  const page = pages[n - 1];
  if (!page) return c.json({ error: 'page not found' }, 404);

  // SSRF guard: block proxying to untrusted/non-image hosts.
  if (!isAllowedImageUrl(page.url)) {
    return c.json({ error: 'upstream image host not allowed' }, 403);
  }

  // Check Cloudflare Cache API first — avoids re-fetching from source CDN
  // and reduces Worker execution cost.
  let cachedImg: Response | null = null;
  if (typeof caches !== 'undefined') {
    const cache = (caches as unknown as { default: Cache }).default;
    cachedImg = (await cache.match(c.req.raw)) ?? null;
  }
  if (cachedImg) {
    const h = new Headers(cachedImg.headers);
    setCorsHeaders(c.env, h, c.req.header('origin'));
    return new Response(cachedImg.body, { status: 200, headers: h });
  }

  // Stampede protection: when many concurrent requests fetch the SAME upstream
  // image URL (popular chapter page), Cloudflare coalesces identical
  // cache.match() calls. We key the upstream URL itself (not our proxy URL
  // which differs per request via `retry` query param).
  const upstreamReq = new Request(page.url, {
    headers: { 'User-Agent': 'manga-platform/1.0', 'Referer': 'https://komiku.org/', ...(page.proxyHeaders || {}) },
  });
  const edgeHit = await matchEdgeCache(upstreamReq);
  if (edgeHit && edgeHit.status === 200) {
    const h = new Headers(edgeHit.headers);
    h.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    setCorsHeaders(c.env, h, c.req.header('origin'));
    const resp = new Response(edgeHit.body, { status: 200, headers: h });
    // Mirror to proxy cache for next request.
    if (typeof caches !== 'undefined') {
      const cache = (caches as unknown as { default: Cache }).default;
      c.executionCtx.waitUntil(cache.put(c.req.raw, resp.clone()).catch(() => {}));
    }
    return resp;
  }

  // Source CDNs occasionally fail transiently (502/503/connection reset).
  // reset). Retry up to 2 times (reduced from 3 to cap CPU time) before
  // surfacing the error. Only accept HTTP 200.
  let upstream: Response | null = null;
  let retryCount = Number(c.req.query('retry')) || 0;
  for (let attempt = 0; attempt < 2 + retryCount; attempt++) {
    try {
      const r = await fetch(page.url, {
        headers: {
          'User-Agent': 'manga-platform/1.0',
          'Referer': 'https://komiku.org/',
          ...(page.proxyHeaders || {})
        },
        signal: AbortSignal.timeout(10000),
        // Hint Cloudflare CDN to cache this response at the edge so
        // subsequent identical requests skip Worker execution entirely.
        cf: { cacheEverything: true, cacheTtl: 3600 },
      });
      if (r.status === 200) { upstream = r; break; }
      // Non-2xx: drain the body before retrying so the subrequest (bounded by
      // the 6-concurrent-fetch limit) is released. Un-drained bodies keep the
      // fetch "in flight" and can trip CF's deadlock-avoidance cancellation.
      await drainResponse(r);
      // 3xx/4xx/5xx → retry
    } catch {
      // network error → retry
    }
    if (attempt < 1) await new Promise(res => setTimeout(res, 200 * (attempt + 1)));
  }

  if (!upstream) {
    const h = new Headers();
    h.set('Content-Type', 'application/json');
    h.set('Cache-Control', 'no-store');
    setCorsHeaders(c.env, h, c.req.header('origin'));
    return new Response(JSON.stringify({ error: 'upstream image fetch failed after retries', detail: page.url }), { status: 502, headers: h });
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  // Long edge cache: images are immutable chapter pages. CDN edge serves
  // subsequent hits without invoking the Worker.
  headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  setCorsHeaders(c.env, headers, c.req.header('origin'));

  // Cache-aside R2 (semua source — komiku + bacakomik + thrive + manhwaindo):
  // clone stream SEBELUM Response dibuat — setelah `new Response(upstream.body)`
  // stream terkunci dan clone() melempar "ReadableStream locked to a reader".
  // Upload di background; request berikutnya diserve langsung dari R2 tanpa
  // lewat Worker. Upload idempoten (key sama → overwrite).
  // Buffer body (bukan stream): PUT stream tanpa Content-Length ditolak R2
  // (411 Length Required) untuk sebagian upstream — gambar chapter kecil,
  // buffer aman di limit 128MB.
  const slug = await resolveKomikuSlug(c, chapterId);
  let r2Upload: Promise<void> | null = null;
  if (slug) {
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buf = await new Response(upstream.clone().body).arrayBuffer();
    if (buf.byteLength > 0) {
      r2Upload = uploadToStorage(c, { source, slug, chapterId, pageNo: n, imageUrl: page.url, contentType, body: buf }).catch(() => {});
    }
  }

  const response = new Response(upstream.body, { status: 200, headers });

  // Store in Cloudflare edge cache for subsequent requests. We populate
  // BOTH the proxy-keyed cache (for next /api/reader/*/page/* hit) AND the
  // upstream-URL-keyed cache (for stampede coalescing on concurrent fetches
  // of the same source CDN URL).
  if (typeof caches !== 'undefined') {
    const cache = (caches as unknown as { default: Cache }).default;
    c.executionCtx.waitUntil(cache.put(c.req.raw, response.clone()).catch(() => {}));
    c.executionCtx.waitUntil(cache.put(upstreamReq, response.clone()).catch(() => {}));
  }

  if (r2Upload) c.executionCtx.waitUntil(r2Upload);

  return response;
});
