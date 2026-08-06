import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import type { Env, Context } from '../lib/context';
import { json, sha256Hex } from '../lib/context';
import { retryUpstream } from '../lib/retry';

export const router = new Hono<{ Bindings: Env }>();

const normalizeTitle = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

router.get('/search', async (c: Context) => {
  const q = c.req.query('q');
  if (!q) return json(c, { error: 'query param "q" is required' }, 400);
  const limit = Math.min(Number(c.req.query('limit') ?? '20'), 50);

  const cacheKey = `search:${await sha256Hex(q)}`;
  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) return json(c, { ...cached, cached: true });

  const db = c.env.DB;
  const localResults = await db.prepare(
    "SELECT s.* FROM series_search f JOIN series s ON s.id = f.rowid WHERE series_search MATCH ?1 ORDER BY rank LIMIT ?2"
  ).bind(q, limit).all();

  const sourcesQueried: string[] = [];
  const [komikuResults, mangadexResults] = await Promise.allSettled([
    retryUpstream(() => {
      const a = getAdapter('komiku', c.env);
      if (!a) throw new Error('komiku adapter unavailable');
      sourcesQueried.push('komiku');
      return a.search({ q, limit });
    }),
    retryUpstream(() => {
      const a = getAdapter('mangadex', c.env);
      if (!a) throw new Error('mangadex adapter unavailable');
      sourcesQueried.push('mangadex');
      return a.search({ q, limit });
    }),
  ]);

  const allResults: Record<string, { data: any; sources: string[] }> = {};
  const addResult = (series: any, source: string) => {
    const key = normalizeTitle(series.title || series.slug || '');
    if (!key) return;
    if (allResults[key]) {
      if (!allResults[key].sources.includes(source)) allResults[key].sources.push(source);
    } else {
      allResults[key] = { data: { ...series, sources: [source] }, sources: [source] };
    }
  };

  for (const row of (localResults.results ?? []) as unknown as Array<Record<string, unknown>>) {
    addResult(row, (row.source as string) || 'local');
  }
  if (komikuResults.status === 'fulfilled') {
    for (const s of komikuResults.value) addResult(s, 'komiku');
  }
  if (mangadexResults.status === 'fulfilled') {
    for (const s of mangadexResults.value) addResult(s, 'mangadex');
  }

  const merged = Object.values(allResults).slice(0, limit);
  const payload = { data: merged, total: merged.length, sources_queried: sourcesQueried, cached: false };

  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 120 }).catch(() => {})
  );
  return json(c, payload);
});
