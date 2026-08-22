import { Hono } from 'hono';
import { Env, getDb, json } from '../lib/context';
import type { Series } from '@manga-platform/shared/types';

export const router = new Hono<{ Bindings: Env }>();

interface CachedSeriesList {
  data: Series[];
  ts: number;
}

router.get('/series', async (c) => {
  const genre = c.req.query('genre') ?? undefined;
  const page = Number(c.req.query('page') ?? '1') || 1;
  const limit = Math.min(Number(c.req.query('limit') ?? '20') || 20, 100);
  const cacheKey = `series:list:${genre ?? ''}:${page}:${limit}`;

  const cachedRaw = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cachedRaw) {
    const cached = cachedRaw as CachedSeriesList;
    const age = Math.floor(Date.now() / 1000) - cached.ts;
    if (age < 600) {
      c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
      return json(c, cached.data);
    }
  }

  const series = await getDb(c).listSeries({ genre, page, limit });
  const now = Math.floor(Date.now() / 1000);
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify({ data: series, ts: now }), { expirationTtl: 600 }).catch(() => {})
  );
  c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
  return json(c, series);
});

router.get('/series/:slug', async (c) => {
  const slug = c.req.param('slug');
  const cacheKey = `series:detail:${slug}`;

  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) {
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return json(c, cached);
  }

  const series = await getDb(c).getSeriesBySlug(slug);
  if (!series) {
    return json(c, { error: 'Series not found' }, 404);
  }
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(series), { expirationTtl: 600 }).catch(() => {})
  );
  c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
  return json(c, series);
});

router.get('/series/:slug/:chapterId', async (c) => {
  const chapterId = c.req.param('chapterId');
  const cacheKey = `series:chapter:${chapterId}`;
  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) {
    c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
    return json(c, cached);
  }
  const chapter = await getDb(c).getChapter(chapterId);
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify({ chapter }), { expirationTtl: 300 }).catch(() => {})
  );
  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
  return json(c, { chapter });
});
