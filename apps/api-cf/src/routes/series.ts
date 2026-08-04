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
  const limit = Number(c.req.query('limit') ?? '20') || 20;
  const cacheKey = `series:list:${genre ?? ''}:${page}:${limit}`;

  const cachedRaw = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cachedRaw) {
    const cached = cachedRaw as CachedSeriesList;
    const age = Math.floor(Date.now() / 1000) - cached.ts;
    if (age < 300) {
      return json(c, cached.data);
    }
  }

  const series = await getDb(c).listSeries({ genre, page, limit });
  const now = Math.floor(Date.now() / 1000);
  await c.env.CACHE_KV.put(
    cacheKey,
    JSON.stringify({ data: series, ts: now }),
    { expirationTtl: 600 }
  );
  return json(c, series);
});

router.get('/series/:slug', async (c) => {
  const slug = c.req.param('slug');
  const cacheKey = `series:detail:${slug}`;

  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) {
    return json(c, cached);
  }

  const series = await getDb(c).getSeriesBySlug(slug);
  if (!series) {
    return json(c, { error: 'Series not found' }, 404);
  }
  await c.env.CACHE_KV.put(cacheKey, JSON.stringify(series), { expirationTtl: 600 });
  return json(c, series);
});

router.get('/series/:slug/:chapterId', async (c) => {
  const chapterId = c.req.param('chapterId');
  return json(c, { chapter: await getDb(c).getChapter(chapterId) });
});
