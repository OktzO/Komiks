import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import type { Series } from '@manga-platform/shared';
import type { Env, Context } from '../lib/context';
import { getDb, json, sha256Hex } from '../lib/context';
import { retryUpstream } from '../lib/retry';

export const router = new Hono<{ Bindings: Env }>();

const normalizeTitle = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

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

  // Empty query → prefer local D1 list (saves upstream fetches when DB has
  // data). BUT if D1 is empty (cold DB / fresh deploy), fall back to Komiku
  // popular listings so the homepage isn't blank.
  // its empty-query search returns random results, not useful for browsing.
  if (!q) {
    if (localResults.length === 0) {
      // D1 cold — fetch Komiku popular listings as homepage feed.
      const a = getAdapter('komiku', c.env);
      if (a) {
        const start = Date.now();
        try {
          const komiku = await retryUpstream(() => a.search({ q: '', limit }));
          recordHealth(c, 'komiku', start, true);
          const merged = komiku.map((s) => ({ data: { ...s, sources: ['komiku'] }, sources: ['komiku'] }));
          const payload = { data: merged, total: merged.length, sources_queried: ['komiku'], cached: false };
          c.executionCtx.waitUntil(
            c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 }).catch(() => {})
          );
          c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
          return json(c, payload);
        } catch (e) {
          recordHealth(c, 'komiku', start, false, String(e));
        }
      }
    }
    const merged = (localResults as unknown as Array<Record<string, unknown>>).map((row) => ({
      data: { ...row, sources: [(row.source as string) || 'local'] },
      sources: [(row.source as string) || 'local'],
    }));
    const payload = { data: merged, total: merged.length, sources_queried: ['local'], cached: false };
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
        const a = getAdapter(key, c.env);
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
