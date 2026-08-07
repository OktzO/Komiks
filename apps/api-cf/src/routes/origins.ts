import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { getDb, json } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

// Return enabled origins from D1 (passive health — no live ping).
// Earlier code did a live fetch to every origin's /api/health on each call,
// which burned N upstream fetches per 30s window per client. Health is
// recorded passively via search/reader activity (recordSourceHealth), so
// /api/origins now simply reflects last-known DB state. KV-cached 300s.
router.get('/origins', async (c: Context) => {
  const cacheKey = 'origins:healthy';
  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' });
  if (cached) {
    c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return json(c, cached);
  }

  const origins = await getDb(c).listOrigins();
  const enabled = origins
    .filter((o) => o.enabled === 1)
    .map((o) => ({
      url: o.origin_url,
      priority: o.priority,
      weight: o.weight,
      // Never-checked origins (null) are treated as usable; "unhealthy"
      // origins are filtered out. This matches router.ts getHealthyOrigin.
      healthy: o.last_health_status === 'healthy' || o.last_health_status === null,
    }));

  const payload = { data: enabled };
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 }).catch(() => {})
  );

  // Quota tracking (approximation): tiap pengambilan daftar origin = 1 cycle
  // round-robin klien. Exact per-request count butuh telemetri per-browser
  // atau Durable Object — out of scope (lihat spec section 7).
  const today = new Date().toISOString().slice(0, 10);
  c.executionCtx.waitUntil(
    (async () => {
      const db = getDb(c);
      for (const o of enabled) {
        await db.incrementLbUsage({ originUrl: o.url, dateKey: today }).catch(() => {});
      }
    })()
  );

  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return json(c, payload);
});
