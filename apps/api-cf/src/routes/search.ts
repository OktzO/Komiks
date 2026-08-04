import { Hono } from 'hono';
import { Env, getDb, json, sha256Hex } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

router.get('/search', async (c) => {
  const q = c.req.query('q');
  if (!q) {
    return json(c, { error: 'query param "q" is required' }, 400);
  }

  const cacheKey = `search:${await sha256Hex(q)}`;
  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) {
    return json(c, cached);
  }

  const results = await getDb(c).searchSeries(q);
  await c.env.CACHE_KV.put(cacheKey, JSON.stringify(results), { expirationTtl: 120 });
  return json(c, results);
});
