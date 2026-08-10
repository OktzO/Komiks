import { Hono } from 'hono';
import { getAdapter, type AdapterEnv } from '@manga-platform/sources';
import type { Env, Context } from '../lib/context';
import { getDb, json } from '../lib/context';
import { retryUpstream } from '../lib/retry';

export const router = new Hono<{ Bindings: Env }>();

const normalizeTitle = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, '')
    .replace(/\b(komik|comic|manga|manhwa|manhua)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();

const HOMEPAGE_TTL = 90000;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const recordHealth = (c: Context, source: string, start: number, ok: boolean, error?: string) => {
  c.executionCtx.waitUntil(
    getDb(c).recordSourceHealth({
      source, healthy: ok, latencyMs: Date.now() - start,
      error: ok ? null : (error ?? 'unknown error'),
    }).catch(() => {})
  );
};

const fetchHomepageFromSources = async (c: Context): Promise<{ data: any[]; sources_queried: string[] }> => {
  const sourceDefs = [
    { key: 'komiku', start: Date.now() },
    { key: 'bacakomik', start: Date.now() },
    { key: 'thrive', start: Date.now() },
    { key: 'manhwaindo', start: Date.now() },
  ];
  const settled = await Promise.allSettled(
    sourceDefs.map(({ key, start }) =>
      retryUpstream(async () => {
        const a = getAdapter(key, c.env as unknown as AdapterEnv);
        if (!a) throw new Error(`${key} adapter unavailable`);
        return { key, start, results: await a.search({ q: '', limit: 24 }) };
      })
    )
  );

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

  const sourcesQueried: string[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      sourcesQueried.push(r.value.key);
      recordHealth(c, r.value.key, r.value.start, true);
      for (const s of r.value.results) addResult(s, r.value.key);
    } else {
      const reason = String((r as PromiseRejectedResult).reason ?? '');
      const errKey = ['bacakomik', 'thrive', 'manhwaindo'].find((k) => reason.includes(k)) ?? 'komiku';
      recordHealth(c, errKey, Date.now(), false, reason.slice(0, 200));
    }
  }

  try {
    const dbRes = await c.env.DB.prepare('SELECT * FROM series ORDER BY updated_at DESC LIMIT 60').all();
    for (const row of dbRes.results ?? []) {
      addResult(row, (row as any).source || 'local');
    }
  } catch {}

  const merged = Object.values(allResults).slice(0, 60);
  return { data: merged, sources_queried: sourcesQueried };
};

router.get('/homepage', async (c: Context) => {
  const cached = await c.env.CACHE_KV.get('homepage:feed', { type: 'json' }).catch(() => null);
  const lastUpdatedStr = await c.env.CACHE_KV.get('homepage:feed:last_updated').catch(() => null);
  const lastUpdated = lastUpdatedStr ? parseInt(lastUpdatedStr, 10) : 0;
  const ageMs = Date.now() - lastUpdated;

  if (cached && ageMs < STALE_THRESHOLD_MS) {
    c.header('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=86400');
    return json(c, { ...(cached as object), cached: true });
  }

  if (cached) {
    c.executionCtx.waitUntil(
      (async () => {
        const fresh = await fetchHomepageFromSources(c);
        await c.env.CACHE_KV.put('homepage:feed', JSON.stringify(fresh), { expirationTtl: HOMEPAGE_TTL });
        await c.env.CACHE_KV.put('homepage:feed:last_updated', String(Date.now()), { expirationTtl: HOMEPAGE_TTL });
      })().catch(() => {})
    );
    c.header('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=86400');
    return json(c, { ...(cached as object), cached: true });
  }

  try {
    const fresh = await fetchHomepageFromSources(c);
    c.executionCtx.waitUntil(
      c.env.CACHE_KV.put('homepage:feed', JSON.stringify(fresh), { expirationTtl: HOMEPAGE_TTL })
        .then(() => c.env.CACHE_KV.put('homepage:feed:last_updated', String(Date.now()), { expirationTtl: HOMEPAGE_TTL }))
        .catch(() => {})
    );
    c.header('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=86400');
    return json(c, { ...fresh, cached: false });
  } catch (e) {
    console.error('[homepage] fetch failed:', e);
    return json(c, { error: 'homepage fetch failed' }, 502);
  }
});
