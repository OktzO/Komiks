import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import { buildRing, accountFor } from '@manga-platform/shared/r2-routing';
import { getDb } from '../lib/context';
import type { Env, Context } from '../lib/context';
import { allowedOriginFor } from '../lib/context';
import { retryUpstream } from '../lib/retry';
import { parseR2Accounts } from '../lib/r2Accounts.ts';
import { s3PutObject } from '../lib/s3Upload.ts';
import { parseSlugFromChapterId } from '../lib/komikuSlug.ts';

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
  'uploads.mangadex.org',
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
  // MangaDex at-home nodes use *.mangadex-network.app / *.mangadex.org — allow subdomains.
  if (host.endsWith('.mangadex-network.app') || host.endsWith('.mangadex.org')) return true;
  return false;
};

// Fetch page URLs with KV caching to avoid re-hitting MangaDex at-home
// on every image request (prevents 429 rate-limit → 502 cascade).
const fetchPageUrlsWithCache = async (
  c: Context,
  source: string,
  chapterId: string
): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> => {
  const cacheKey = `pages:${source}:${chapterId}`;
  const cached = await cacheGet<{ url: string; proxyHeaders?: Record<string, string> }[]>(c, cacheKey);
  if (cached) return cached;

  const adapter = getAdapter(source, c.env);
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

// R2 config dibangun sekali per request — murah (2 akun × 32 vnodes).
const r2RingFor = (c: Context): { accounts: ReturnType<typeof parseR2Accounts>; ring: ReturnType<typeof buildRing> } | null => {
  const accounts = parseR2Accounts(c.env.R2_ACCOUNTS);
  if (accounts.length === 0) return null;
  const vnodes = Number(c.env.R2_RING_VNODES) || 32;
  return { accounts, ring: buildRing(accounts.map((a) => a.public_domain), vnodes) };
};

// Upload gambar ke R2 target account (background) + catat D1. Idempoten:
// key sama → overwrite sama. Race 2 request paralel aman (R2 1 write/s/key).
const uploadToR2 = async (c: Context, opts: { slug: string; chapterId: string; pageNo: number; imageUrl: string; contentType: string; body: ReadableStream }): Promise<void> => {
  try {
    const cfg = r2RingFor(c);
    if (!cfg) return; // R2 belum dikonfigurasi → proxy-only mode (old behavior)
    const idx = accountFor(opts.slug, cfg.ring);
    const account = cfg.accounts[idx];
    const r2Key = `komiku/${opts.slug}/${opts.chapterId}/${opts.pageNo}`;
    const res = await s3PutObject(account, r2Key, opts.body, opts.contentType);
    if (!res.ok) throw new Error(`r2 upload ${res.status}`);
    await getDb(c).markPageR2Uploaded({
      chapterId: opts.chapterId,
      pageNumber: opts.pageNo,
      imageUrl: opts.imageUrl,
      r2Key,
      r2AccountIdx: idx,
    });
  } catch (e) {
    console.error('[r2] upload failed:', String(e)); // jangan gagalkan response user
  }
};

// Consolidated series detail + chapters in a single Worker invocation.
// GET /api/reader/:source/series/:sourceId/detail?lang=id
// Returns { data: { ...series, chapters: [...] } } cached under one KV key,
// halving the Worker + KV-read cost vs separate getSeries + getChapters calls.
router.get('/:source/series/:sourceId/detail', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const lang = c.req.query('lang') || 'id';
  const cacheKey = `series:full:${source}:${sourceId}:${lang}`;
  const cached = await cacheGet<{ data: { chapters: unknown[] } & Record<string, unknown> }>(c, cacheKey);
  if (cached) {
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return c.json(cached);
  }

  const adapter = getAdapter(source, c.env);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const [series, chapters] = await Promise.all([
      retryUpstream(() => adapter.getSeries(sourceId)),
      retryUpstream(() => adapter.listChapters(sourceId, { lang })),
    ]);
    const data = { ...series, chapters };
    cachePut(c, cacheKey, { data }, 600);
    recordHealth(c, source, start, true);
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return c.json({ data });
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Series detail: GET /api/reader/:source/series/:sourceId
router.get('/:source/series/:sourceId', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const cacheKey = `series:detail:${source}:${sourceId}`;
  const cached = await cacheGet<{ data: unknown }>(c, cacheKey);
  if (cached) return c.json(cached);

  const adapter = getAdapter(source, c.env);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const data = await retryUpstream(() => adapter.getSeries(sourceId));
    cachePut(c, cacheKey, { data }, 600);
    recordHealth(c, source, start, true);
    return c.json({ data });
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
  const cached = await cacheGet<{ data: unknown[] }>(c, cacheKey);
  if (cached) return c.json(cached);

  const adapter = getAdapter(source, c.env);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const data = await retryUpstream(() => adapter.listChapters(sourceId, { lang }));
    cachePut(c, cacheKey, { data }, 300);
    recordHealth(c, source, start, true);
    return c.json({ data });
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Chapter detail + proxy page URLs: GET /api/reader/:source/chapter/:chapterId
router.get('/:source/chapter/:chapterId', async (c: Context) => {
  const { source, chapterId } = c.req.param();
  const cacheKey = `chapter:detail:${source}:${chapterId}`;
  const cached = await cacheGet<{ data: unknown }>(c, cacheKey);
  if (cached) return c.json(cached);

  const adapter = getAdapter(source, c.env);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const chapter = await retryUpstream(() => adapter.getChapter(chapterId));
    const pages = await fetchPageUrlsWithCache(c, source, chapterId);
    const proxyBase = `/api/reader/${source}/page/${encodeURIComponent(chapterId)}`;
    const data = {
      ...chapter,
      pages: pages.map((_, i) => ({ proxyUrl: `${proxyBase}/${i + 1}` }))
    };
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

  const adapter = getAdapter(source, c.env);
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

  // Check Cloudflare Cache API first — avoids re-fetching from MangaDex CDN
  // and reduces Worker execution cost.
  let cachedImg: Response | null = null;
  if (typeof caches !== 'undefined') {
    const cache = caches.default;
    cachedImg = (await cache.match(c.req.raw)) ?? null;
  }
  if (cachedImg) {
    const h = new Headers(cachedImg.headers);
    setCorsHeaders(c.env, h, c.req.header('origin'));
    return new Response(cachedImg.body, { status: 200, headers: h });
  }

  // MangaDex at-home nodes occasionally fail transiently (502/503/connection
  // reset). Retry up to 2 times (reduced from 3 to cap CPU time) before
  // surfacing the error. Only accept HTTP 200.
  let upstream: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
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
      // 3xx/4xx/5xx → retry
    } catch {
      // network error → retry
    }
    if (attempt < 1) await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
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

  // Cache-aside R2 (komiku saja — MangaDex tetap 100% proxy, ToS):
  // clone stream SEBELUM Response dibuat — setelah `new Response(upstream.body)`
  // stream terkunci dan clone() melempar "ReadableStream locked to a reader".
  // Upload di background; request berikutnya diserve langsung dari R2 tanpa
  // lewat Worker. Upload idempoten (key sama → overwrite).
  let r2Upload: Promise<void> | null = null;
  if (source === 'komiku') {
    const slug = await resolveKomikuSlug(c, chapterId);
    const body = upstream.clone().body;
    if (slug && body) {
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      r2Upload = uploadToR2(c, { slug, chapterId, pageNo: n, imageUrl: page.url, contentType, body }).catch(() => {});
    }
  }

  const response = new Response(upstream.body, { status: 200, headers });

  // Store in Cloudflare edge cache for subsequent requests
  if (typeof caches !== 'undefined') {
    const cache = caches.default;
    c.executionCtx.waitUntil(cache.put(c.req.raw, response.clone()).catch(() => {}));
  }

  if (r2Upload) c.executionCtx.waitUntil(r2Upload);

  return response;
});
