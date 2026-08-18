import { Hono } from 'hono';
import { getAdapter, type AdapterEnv } from '@manga-platform/sources';
import type { Env, Context } from '../lib/context';
import { db } from '@manga-platform/db';
import { json } from '../lib/context';
import { retryUpstream } from '../lib/retry';

export const router = new Hono<{ Bindings: Env }>();

const normalizeTitle = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, '')
    .replace(/\b(komik|comic|manga|manhwa|manhua)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();

export const HOMEPAGE_TTL = 43200; // 12 jam
const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;

export const SOURCE_PRIORITY: Record<string, number> = {
  komiku: 4, bacakomik: 3, thrive: 2, manhwaindo: 1, local: 0,
};

// Skor populer sederhana: source priority + chapter_count + recency update.
// Murni & deterministik — di-test terpisah (test/homepage.test.mjs).
export const computePopularity = (
  d: Record<string, unknown>,
  now: number = Date.now()
): number => {
  const chCount = Number(d.chapter_count ?? 0);
  const updated = Number(d.updated_at ?? 0);
  const ageDays = updated > 0 ? (now - updated * 1000) / 86400000 : 999;
  const recency = Math.max(0, 1 - ageDays / 30);
  const prio = SOURCE_PRIORITY[(d.source as string) ?? 'local'] ?? 0;
  return Math.round((prio * 2 + chCount * 0.25 + recency * 5) * 100) / 100;
};

// Health rekaman fire-and-forget: pakai waitUntil kalau di request context,
// inline await kalau di cron.
const recordHealth = (
  env: Env,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  source: string, start: number, ok: boolean, error?: string
) => {
  const p = db(env.DB).recordSourceHealth({
    source, healthy: ok, latencyMs: Date.now() - start,
    error: ok ? null : (error ?? 'unknown error'),
  }).catch(() => {});
  if (waitUntil) waitUntil(p);
};

export type FeedItem = { data: Record<string, unknown> & { source?: string }; sources: string[]; popularity?: number };

export const fetchHomepageFromSources = async (
  env: Env,
  waitUntil?: (p: Promise<unknown>) => void
): Promise<{ data: FeedItem[]; sources_queried: string[] }> => {
  const sourceDefs = [
    { key: 'komiku', start: Date.now() },
    { key: 'bacakomik', start: Date.now() },
    { key: 'thrive', start: Date.now() },
    { key: 'manhwaindo', start: Date.now() },
  ];
  const settled = await Promise.allSettled(
    sourceDefs.map(({ key, start }) =>
      retryUpstream(async () => {
        const a = getAdapter(key, env as unknown as AdapterEnv);
        if (!a) throw new Error(`${key} adapter unavailable`);
        return { key, start, results: await a.search({ q: '', limit: 24 }) };
      })
    )
  );

  const allResults: Record<string, FeedItem> = {};
  const addResult = (series: Record<string, unknown>, source: string) => {
    const key = normalizeTitle(String(series.title ?? series.slug ?? ''));
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
      recordHealth(env, waitUntil, r.value.key, r.value.start, true);
      for (const s of r.value.results) addResult(s as Record<string, unknown>, r.value.key);
    } else {
      const reason = String((r as PromiseRejectedResult).reason ?? '');
      const errKey = ['bacakomik', 'thrive', 'manhwaindo'].find((k) => reason.includes(k)) ?? 'komiku';
      recordHealth(env, waitUntil, errKey, Date.now(), false, reason.slice(0, 200));
    }
  }

  try {
    const dbRes = await env.DB.prepare('SELECT * FROM series ORDER BY updated_at DESC LIMIT 60').all();
    for (const row of dbRes.results ?? []) {
      addResult(row, (row as Record<string, unknown>).source as string || 'local');
    }
  } catch {}

  const merged = Object.values(allResults).slice(0, 60);
  const now = Date.now();
  for (const item of merged) {
    item.popularity = computePopularity(item.data, now);
  }
  return { data: merged, sources_queried: sourcesQueried };
};

router.get('/homepage', async (c: Context) => {
  const waitUntil = (p: Promise<unknown>) => c.executionCtx.waitUntil(p);
  const cached = await c.env.CACHE_KV.get('homepage:feed', { type: 'json' }).catch(() => null);
  const lastUpdatedStr = await c.env.CACHE_KV.get('homepage:feed:last_updated').catch(() => null);
  const lastUpdated = lastUpdatedStr ? parseInt(lastUpdatedStr, 10) : 0;
  const ageMs = Date.now() - lastUpdated;

  if (cached && ageMs < STALE_THRESHOLD_MS) {
    c.header('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=43200');
    return json(c, { ...(cached as object), cached: true });
  }

  if (cached) {
    waitUntil(
      (async () => {
        const fresh = await fetchHomepageFromSources(c.env, waitUntil);
        await c.env.CACHE_KV.put('homepage:feed', JSON.stringify(fresh), { expirationTtl: HOMEPAGE_TTL });
        await c.env.CACHE_KV.put('homepage:feed:last_updated', String(Date.now()), { expirationTtl: HOMEPAGE_TTL });
      })().catch(() => {})
    );
    c.header('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=43200');
    return json(c, { ...(cached as object), cached: true });
  }

  try {
    const fresh = await fetchHomepageFromSources(c.env, waitUntil);
    waitUntil(
      c.env.CACHE_KV.put('homepage:feed', JSON.stringify(fresh), { expirationTtl: HOMEPAGE_TTL })
        .then(() => c.env.CACHE_KV.put('homepage:feed:last_updated', String(Date.now()), { expirationTtl: HOMEPAGE_TTL }))
        .catch(() => {})
    );
    c.header('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=43200');
    return json(c, { ...fresh, cached: false });
  } catch (e) {
    console.error('[homepage] fetch failed:', e);
    return json(c, { error: 'homepage fetch failed' }, 502);
  }
});
