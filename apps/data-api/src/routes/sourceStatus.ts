import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import type { Env, Context } from '../lib/context';
import { getDb, json } from '../lib/context';
import { retryUpstream } from '../lib/retry';

export const router = new Hono<{ Bindings: Env }>();

router.get('/source-status', async (c: Context) => {
  const sources: { source: string; healthy: boolean; latency_ms: number; last_checked_at: number; error?: string }[] = [];

  for (const key of ['komiku', 'mangadex'] as const) {
    const cacheKey = `source:health:${key}`;
    const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
    if (cached) { sources.push(cached as { source: string; healthy: boolean; latency_ms: number; last_checked_at: number; error?: string }); continue; }

    const adapter = getAdapter(key, c.env);
    if (!adapter?.healthCheck) {
      sources.push({ source: key, healthy: false, latency_ms: 0, last_checked_at: Math.floor(Date.now() / 1000), error: 'adapter missing healthCheck' });
      continue;
    }

    try {
      const result = await retryUpstream(() => adapter.healthCheck!(), 1);
      const snapshot = {
        source: key,
        healthy: result.healthy,
        latency_ms: result.latency_ms,
        last_checked_at: Math.floor(Date.now() / 1000),
        error: result.error,
      };
      sources.push(snapshot);
      c.executionCtx.waitUntil(c.env.CACHE_KV.put(cacheKey, JSON.stringify(snapshot), { expirationTtl: 60 }).catch(() => {}));
      c.executionCtx.waitUntil(getDb(c).recordSourceHealth({ source: key, healthy: result.healthy, latencyMs: result.latency_ms, error: result.error ?? null }).catch(() => {}));
    } catch (e) {
      sources.push({ source: key, healthy: false, latency_ms: 0, last_checked_at: Math.floor(Date.now() / 1000), error: String(e) });
    }
  }

  return json(c, { data: sources });
});
