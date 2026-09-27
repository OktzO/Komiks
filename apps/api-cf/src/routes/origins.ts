import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { getDb, json } from '../lib/context';
import { getRoutableTopology } from '../lib/peers';
import { buildOriginPool, indexOriginsByUrl, originCacheKey, parseCachedPool } from '../lib/originPool';
import type { LbOrigin } from '@manga-platform/shared/types';

export const router = new Hono<{ Bindings: Env }>();

const describeError = (error: unknown): string =>
  error instanceof Error
    ? `${error.name}: ${error.message.replace(/\s+/g, ' ').slice(0, 120)}`
    : 'non-Error throw';

// Membership comes from PEER_URLS (topology), not local D1: two-row
// `lb_origins` seed used to cap the real pool at two. A D1 row is metadata
// only — it can override priority/weight/enabled/health for a URL the topology
// already declares, and is ignored when it does not. Health stays passive
// (recorded via search/reader activity), so no live /api/health ping.
// Cache key carries the topology hash, so a topology deploy invalidates the
// Worker's own KV pool immediately; D1 override edits land within the existing
// 300s TTL. Overrides are per-Worker: each account reads its own D1, so a
// priority/weight/enable change must be applied per account (the admin
// inventory lists each peer's own metadata).
router.get('/origins', async (c: Context) => {
  const { snapshot: topology, malformed } = getRoutableTopology(c.env);
  const cacheKey = originCacheKey(topology.hash);
  const cached = parseCachedPool(await c.env.CACHE_KV.get(cacheKey, { type: 'json' }));
  if (cached) {
    c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return json(c, { data: cached });
  }

  let rows: LbOrigin[] | null = null;
  try {
    rows = await getDb(c).listOrigins();
  } catch (error) {
    console.error(`[origins] ORIGIN_D1_READ_FAILED ${describeError(error)}`);
  }

  // D1 tidak terbaca = tidak ada bukti peer mana pun yang enabled. Pool kosong
  // lebih jujur daripada pool all-enabled: yang di-arm manual (enabled=0) tidak
  // boleh ikut dilayani hanya karena D1 sempat down. Klien jatuh ke fallback
  // statis; pool ini tidak pernah di-cache.
  const payload = { data: rows === null ? [] : buildOriginPool(topology, rows) };
  const byUrl = indexOriginsByUrl(rows ?? []);
  if (rows !== null && !malformed) {
    c.executionCtx.waitUntil(
      c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 }).catch(() => {})
    );
  }

  // Quota tracking (approximation): tiap pengambilan daftar origin = 1 cycle
  // round-robin klien. Exact per-request count butuh telemetri per-browser
  // atau Durable Object — out of scope (lihat spec section 7). The D1 row's
  // literal origin_url is the lb_usage key, because that is the value the rest
  // of the LB tables are keyed by; only peers without a row use the topology URL.
  const today = new Date().toISOString().slice(0, 10);
  c.executionCtx.waitUntil(
    (async () => {
      const db = getDb(c);
      for (const o of payload.data) {
        const originUrl = byUrl.get(o.url)?.origin_url ?? o.url;
        await db.incrementLbUsage({ originUrl, dateKey: today }).catch(() => {});
      }
    })().catch(() => {})
  );

  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return json(c, payload);
});
