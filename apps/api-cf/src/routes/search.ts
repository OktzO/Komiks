import { Hono } from 'hono';
import { getAdapter, type AdapterEnv } from '@manga-platform/sources';
import type { Series } from '@manga-platform/shared';
import type { Env, Context } from '../lib/context';
import { getDb, json, sha256Hex } from '../lib/context';
import { retryUpstream } from '../lib/retry';

export const router = new Hono<{ Bindings: Env }>();

const normalizeTitle = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, '')
    .replace(/\b(komik|comic|manga|manhwa|manhua)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();

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

// Parse limit with NaN fallback — earlier code passed NaN to SQLite LIMIT
// which silently returned 0 rows.
const parseLimit = (raw: string | undefined, def = 20, max = 50): number => {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
};

router.get('/search', async (c: Context) => {
  const q = c.req.query('q')?.trim() || '';
  const limit = parseLimit(c.req.query('limit'));

  // KV cache lookup (now also caches empty-query homepage result).
  const cacheKey = `search:${await sha256Hex(q)}`;
  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) {
    c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return json(c, { ...(cached as object), cached: true });
  }

  const db = c.env.DB;

  // Local D1 lookup. Empty query → latest series list (no external fetch).
  // Non-empty query → FTS5 match with LIKE fallback on FTS syntax errors.
  let localResults: unknown[];
  if (q) {
    try {
      const r = await db.prepare("SELECT s.* FROM series_search f JOIN series s ON s.id = f.rowid WHERE series_search MATCH ?1 ORDER BY rank LIMIT ?2").bind(q, limit).all();
      localResults = r.results ?? [];
    } catch {
      // FTS5 MATCH can throw on unmatched quotes / special chars. Fall back
      // to a LIKE search so the endpoint never 500s on malformed queries.
      const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
      const r = await db.prepare("SELECT * FROM series WHERE title LIKE ?1 ESCAPE '\\' OR synopsis LIKE ?1 ESCAPE '\\' ORDER BY title LIMIT ?2").bind(like, limit).all();
      localResults = r.results ?? [];
    }
  } else {
    const r = await db.prepare('SELECT * FROM series ORDER BY updated_at DESC LIMIT ?1').bind(limit).all();
    localResults = r.results ?? [];
  }

  // Empty query → homepage feed. Merge local D1 rows WITH live homepage
  // listings from all sources, deduped by normalized title so a manga on
  // multiple sources gets all its source badges.
  if (!q) {
    const sourceDefs: Array<{ key: string; start: number }> = [
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
          return { key, start, results: await a.search({ q: '', limit: limit > 20 ? limit : 24 }) };
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
    // Local D1 rows join the feed (source badge from row.source).
    for (const row of localResults as unknown as Array<Record<string, unknown>>) {
      addResult(row, (row.source as string) || 'local');
    }
    const merged = Object.values(allResults).slice(0, limit > 20 ? limit : 60);
    const payload = { data: merged, total: merged.length, sources_queried: sourcesQueried, cached: false };
    c.executionCtx.waitUntil(
      c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 }).catch(() => {})
    );
    c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return json(c, payload);
  }

  const sourcesQueried: string[] = [];
  const sourceDefs: Array<{ key: string; start: number }> = [
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
        sourcesQueried.push(key);
        return { key, start, results: await a.search({ q, limit }) };
      })
    )
  );

  const resultsBySource: Record<string, Series[]> = {};
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      resultsBySource[r.value.key] = r.value.results;
      recordHealth(c, r.value.key, r.value.start, true);
    } else {
      const reason = String((r as PromiseRejectedResult).reason ?? '');
      const errKey = reason.includes('bacakomik') ? 'bacakomik' : reason.includes('thrive') ? 'thrive' : 'komiku';
      recordHealth(c, errKey, Date.now(), false, reason);
      console.error('[search]', errKey, 'failed:', reason.slice(0, 200));
    }
  }

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

  for (const row of localResults as unknown as Array<Record<string, unknown>>) {
    addResult(row, (row.source as string) || 'local');
  }
  for (const s of resultsBySource.komiku ?? []) addResult(s, 'komiku');
  for (const s of resultsBySource.bacakomik ?? []) addResult(s, 'bacakomik');
  for (const s of resultsBySource.thrive ?? []) addResult(s, 'thrive');
  for (const s of resultsBySource.manhwaindo ?? []) addResult(s, 'manhwaindo');

  const merged = Object.values(allResults).slice(0, limit);
  const payload = { data: merged, total: merged.length, sources_queried: sourcesQueried, cached: false };

  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 }).catch(() => {})
  );
  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return json(c, payload);
});
