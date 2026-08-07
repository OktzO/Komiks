import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { getDb, json } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

router.get('/manga/:id', async (c: Context) => {
  const slug = c.req.param('id');
  const cacheKey = `manga:meta:${slug}`;

  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) return json(c, cached);

  const db = getDb(c);
  const series = await db.getSeriesBySlug(slug);
  if (!series) return json(c, { error: 'manga not found' }, 404);

  const chapters = await c.env.DB.prepare(
    'SELECT * FROM chapters WHERE series_slug = ?1 ORDER BY chapter_number ASC'
  ).bind(slug).all();

  const sources = await c.env.DB.prepare(
    "SELECT DISTINCT source FROM series WHERE slug = ?1 OR title = (SELECT title FROM series WHERE slug = ?1)"
  ).bind(slug).all();

  const payload = {
    data: {
      ...series,
      chapters: chapters.results ?? [],
      sources: (sources.results ?? []).map((r: any) => r.source),
    }
  };

  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {})
  );
  return json(c, payload);
});
