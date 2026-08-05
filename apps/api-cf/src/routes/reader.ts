import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import type { Env, Context } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

const corsOrigin = (env: Env): string => (env.ALLOWED_ORIGINS || '*').split(',')[0].trim();

const cacheGet = async <T>(c: Context, key: string): Promise<T | null> => {
  const raw = await c.env.CACHE_KV.get(key, 'json').catch(() => null);
  return (raw as T) ?? null;
};

const cachePut = (c: Context, key: string, value: unknown, ttl: number): void => {
  c.executionCtx.waitUntil(c.env.CACHE_KV.put(key, JSON.stringify(value), { expirationTtl: ttl }).catch(() => {}));
};

const retryUpstream = async <T>(fn: () => Promise<T>, attempts = 3): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      last = e;
      const msg = String(e);
      // 429 rate-limited → exponential backoff
      if (msg.includes('429') || msg.includes('Too Many Requests')) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
      } else if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      }
    }
  }
  throw last;
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

// Series detail: GET /api/reader/:source/series/:sourceId
router.get('/:source/series/:sourceId', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const cacheKey = `series:detail:${source}:${sourceId}`;
  const cached = await cacheGet<{ data: unknown }>(c, cacheKey);
  if (cached) return c.json(cached);

  const adapter = getAdapter(source, c.env);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  try {
    const data = await retryUpstream(() => adapter.getSeries(sourceId));
    cachePut(c, cacheKey, { data }, 600);
    return c.json({ data });
  } catch (e) {
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
  try {
    const data = await retryUpstream(() => adapter.listChapters(sourceId, { lang }));
    cachePut(c, cacheKey, { data }, 300);
    return c.json({ data });
  } catch (e) {
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
  try {
    const chapter = await retryUpstream(() => adapter.getChapter(chapterId));
    const pages = await fetchPageUrlsWithCache(c, source, chapterId);
    const proxyBase = `/api/reader/${source}/page/${encodeURIComponent(chapterId)}`;
    const data = {
      ...chapter,
      pages: pages.map((_, i) => ({ proxyUrl: `${proxyBase}/${i + 1}` }))
    };
    cachePut(c, cacheKey, { data }, 300);
    return c.json({ data });
  } catch (e) {
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Image proxy: GET /api/reader/:source/page/:chapterId/:pageNo
router.get('/:source/page/:chapterId/:pageNo', async (c: Context) => {
  const { source, chapterId, pageNo } = c.req.param();
  const n = Number(pageNo);
  if (!Number.isInteger(n) || n < 1) return c.json({ error: 'bad page number' }, 400);

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

  // Check Cloudflare Cache API first — avoids re-fetching from MangaDex CDN
  // and reduces Worker execution cost.
  let cachedImg: Response | null = null;
  if (typeof caches !== 'undefined') {
    const cache = caches.default;
    cachedImg = (await cache.match(c.req.raw)) ?? null;
  }
  if (cachedImg) {
    const h = new Headers(cachedImg.headers);
    h.set('Access-Control-Allow-Origin', corsOrigin(c.env));
    h.set('Vary', 'Origin');
    return new Response(cachedImg.body, { status: 200, headers: h });
  }

  // MangaDex at-home nodes occasionally fail transiently (502/503/connection
  // reset). Retry up to 3 times before surfacing the error.
  // Only accept HTTP 200 — earlier code accepted any < 500 status, which
  // silently served 429/404 error pages as images.
  let upstream: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(page.url, {
        headers: { 'User-Agent': 'manga-platform/1.0', ...(page.proxyHeaders || {}) }
      });
      if (r.status === 200) { upstream = r; break; }
      // 3xx/4xx/5xx → retry
    } catch {
      // network error → retry
    }
    if (attempt < 2) await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
  }

  if (!upstream) {
    const h = new Headers();
    h.set('Content-Type', 'application/json');
    h.set('Cache-Control', 'no-store');
    h.set('Access-Control-Allow-Origin', corsOrigin(c.env));
    h.set('Vary', 'Origin');
    return new Response(JSON.stringify({ error: 'upstream image fetch failed after retries', detail: page.url }), { status: 502, headers: h });
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=300');
  headers.set('Access-Control-Allow-Origin', corsOrigin(c.env));
  headers.set('Vary', 'Origin');

  const response = new Response(upstream.body, { status: 200, headers });

  // Store in Cloudflare edge cache for subsequent requests
  if (typeof caches !== 'undefined') {
    const cache = caches.default;
    c.executionCtx.waitUntil(cache.put(c.req.raw, response.clone()).catch(() => {}));
  }

  return response;
});
