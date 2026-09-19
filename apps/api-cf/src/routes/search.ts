import { Hono } from 'hono';
import { getAdapter, type AdapterEnv } from '@manga-platform/sources';
import type { Series } from '@manga-platform/shared';
import type { Env, Context } from '../lib/context';
import { getDb, json, sha256Hex } from '../lib/context';
import { retryUpstream } from '../lib/retry';
import { withBudget } from './reader.ts';

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
  const t0 = Date.now();
  const q = c.req.query('q')?.trim() || '';
  const limit = parseLimit(c.req.query('limit'));

  // KV cache lookup (now also caches empty-query homepage result).
  const cacheKey = `search:${await sha256Hex(q)}`;
  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  console.log(`[search-timing] kv-get=${Date.now() - t0}ms q=${q.slice(0, 20)}`);
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
      const r = await db.prepare("SELECT * FROM series WHERE title LIKE ?1 ESCAPE '\\' OR synopsis LIKE ?1 ESCAPE '\\' OR alt_titles LIKE ?1 ESCAPE '\\' ORDER BY title LIMIT ?2").bind(like, limit).all();
      localResults = r.results ?? [];
    }
  } else {
    const r = await db.prepare('SELECT * FROM series ORDER BY updated_at DESC LIMIT ?1').bind(limit).all();
    localResults = r.results ?? [];
  }
  console.log(`[search-timing] d1=${Date.now() - t0}ms q=${q.slice(0, 20)}`);

  // Empty query → homepage feed. Merge local D1 rows WITH live homepage
  // listings from all sources, deduped by normalized title so a manga on
  // multiple sources gets all its source badges.
  if (!q) {
    const sourceDefs: Array<{ key: string; start: number }> = [
      { key: 'komiku', start: Date.now() },
      { key: 'bacakomik', start: Date.now() },
      { key: 'thrive', start: Date.now() },
      { key: 'shinigami', start: Date.now() },
      { key: 'manhwaindo', start: Date.now() },
      { key: 'webtoon', start: Date.now() },
    ];
    // Budget total 6.5s: source stall (Komiku DDoS-guard, 15s×attempt) tidak
    // boleh block response — frontend timeout di 8s. Partial results tetap ok.
    const settled = await withBudget(
      Promise.allSettled(
        sourceDefs.map(({ key, start }) =>
          retryUpstream(async () => {
            const a = getAdapter(key, c.env as unknown as AdapterEnv);
            if (!a) throw new Error(`${key} adapter unavailable`);
            return { key, start, results: await a.search({ q: '', limit: limit > 20 ? limit : 24 }) };
          })
        )
      ),
      6500,
      [] as PromiseSettledResult<{ key: string; start: number; results: Series[] }>[]
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
        const errKey = ['bacakomik', 'thrive', 'shinigami', 'manhwaindo', 'webtoon'].find((k) => reason.includes(k)) ?? 'komiku';
        recordHealth(c, errKey, Date.now(), false, reason.slice(0, 200));
      }
    }
    // Local D1 rows join the feed (source badge from row.source).
    for (const row of localResults as unknown as Array<Record<string, unknown>>) {
      addResult(row, (row.source as string) || 'local');
    }
    // Flatten FeedItem → row (frontend searchMerged baca m.title/m.slug langsung).
    const merged = Object.values(allResults).map((v) => ({ ...v.data, sources: v.sources })).slice(0, limit > 20 ? limit : 60);
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
    { key: 'shinigami', start: Date.now() },
    { key: 'manhwaindo', start: Date.now() },
    { key: 'webtoon', start: Date.now() },
  ];

  // Budget total 7.5s (< frontend timeout 8s). Per-source 6.5s — tanpa ini,
  // satu source yang lambat (mis. webtoon render browser 3–20s) menggagalkan
  // denganBudget → PROMISE.allSettled tak settle → seluruh search jadi kosong.
  const settled = await withBudget(
    Promise.allSettled(
      sourceDefs.map(({ key, start }) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const p = retryUpstream(async () => {
          const a = getAdapter(key, c.env as unknown as AdapterEnv);
          if (!a) throw new Error(`${key} adapter unavailable`);
          const results = await a.search({ q, limit });
          return results;
        });
        // Webtoon search butuh browser fallback (challenge) — window lebih
        // lebar dari source lain agar hasilnya keluar, tapi tetap < frontend 8s.
        const budget = key === 'webtoon' ? 7200 : 6500;
        const withLimit = Promise.race([
          p.then((results) => ({ key, start, results })),
          new Promise<{ key: string; start: number; results: Series[] }>((_, rej) => {
            timer = setTimeout(() => rej(new Error(`${key} search timeout after ${budget}ms`)), budget);
          }),
        ]);
        return withLimit.finally(() => timer && clearTimeout(timer));
      })
    ),
    8000,
    [] as PromiseSettledResult<{ key: string; start: number; results: Series[] }>[]
  );

  const resultsBySource: Record<string, Series[]> = {};
  console.log(`[search-timing] adapters-done=${Date.now() - t0}ms settled=${settled.length} q=${q.slice(0, 20)}`);
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      resultsBySource[r.value.key] = r.value.results;
      sourcesQueried.push(r.value.key);
      recordHealth(c, r.value.key, r.value.start, true);
    } else {
      const reason = String((r as PromiseRejectedResult).reason ?? '');
      const errKey = ['bacakomik', 'thrive', 'shinigami', 'manhwaindo', 'webtoon'].find((k) => reason.includes(k)) ?? 'komiku';
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
  for (const s of resultsBySource.shinigami ?? []) addResult(s, 'shinigami');
  for (const s of resultsBySource.manhwaindo ?? []) addResult(s, 'manhwaindo');
  for (const s of resultsBySource.webtoon ?? []) addResult(s, 'webtoon');

  // Flatten FeedItem → row (frontend searchMerged baca m.title/m.slug langsung).
  const merged = Object.values(allResults).map((v) => ({ ...v.data, sources: v.sources })).slice(0, limit);
  const payload = { data: merged, total: merged.length, sources_queried: sourcesQueried, cached: false };

  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 }).catch(() => {})
  );
  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return json(c, payload);
});
