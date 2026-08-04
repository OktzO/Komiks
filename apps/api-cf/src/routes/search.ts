import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import { Env, json, sha256Hex } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

router.get('/search', async (c) => {
  const q = c.req.query('q');
  if (!q) return json(c, { error: 'query param "q" is required' }, 400);

  const cacheKey = `search:${await sha256Hex(q)}`;
  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) return json(c, cached);

  const adapter = getAdapter('mangadex', c.env);
  if (!adapter) return json(c, { error: 'unknown source' }, 500);
  try {
    const data = await adapter.search({ q, limit: 24 });
    const payload = { data };
    c.executionCtx.waitUntil(c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 120 }).catch(() => {}));
    return json(c, payload);
  } catch (e) {
    return json(c, { error: 'search failed', detail: String(e) }, 502);
  }
});
