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

// Series detail: GET /api/reader/:source/series/:sourceId
router.get('/:source/series/:sourceId', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const cacheKey = `series:detail:${source}:${sourceId}`;
  const cached = await cacheGet<{ data: unknown }>(c, cacheKey);
  if (cached) return c.json(cached);

  const adapter = getAdapter(source, c.env);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  try {
    const data = await adapter.getSeries(sourceId);
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
    const data = await adapter.listChapters(sourceId, { lang });
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
    const chapter = await adapter.getChapter(chapterId);
    const pages = await adapter.fetchPageUrls(chapterId);
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
    pages = await adapter.fetchPageUrls(chapterId);
  } catch (e) {
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }

  const page = pages[n - 1];
  if (!page) return c.json({ error: 'page not found' }, 404);

  const upstream = await fetch(page.url, {
    headers: { 'User-Agent': 'manga-platform/1.0', ...(page.proxyHeaders || {}) }
  });

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=300');
  headers.set('Access-Control-Allow-Origin', corsOrigin(c.env));

  return new Response(upstream.body, { status: upstream.status, headers });
});
