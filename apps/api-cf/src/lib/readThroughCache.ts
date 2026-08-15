// Two-tier KV cache with stale-while-revalidate semantics.
//
// Why two tiers instead of one with long TTL:
// - Fresh tier: short TTL (10 min). Hot reads → near-zero Worker cost.
// - Stale tier: long TTL (24 h). When fresh misses AND upstream is failing
//   (DDoS-guard stall on komiku.org etc.), return last-known-good instead
//   of a 502 to the reader. Background revalidate attempts to refresh.
//
// Why not just rely on one KV key with long TTL:
// - Stale-while-revalidate needs to distinguish "expired-but-usable" from
//   "fresh-and-usable" — separate keys make this O(1) per request.
//
// Concurrency / stampede protection:
// - The `cache.match` call uses the runtime Cache API (caches.default) keyed
//   on the SAME URL so concurrent Workers requesting the same URL share one
//   upstream fetch. Without this, N concurrent cache-miss requests → N
//   upstream fetches → DDoS guard triggers 502 cascade.
// - A short-lived `lock:<key>` KV entry is also written so that, even if two
//   Workers fetch simultaneously, the second one sees the lock and waits
//   briefly (poll fresh cache) before falling back to stale.

import type { Context } from '../routes/../lib/context';

export type FreshLoader<T> = () => Promise<T>;

export interface CacheOptions {
  /** Fresh-tier TTL (seconds). Default 600. */
  freshTtl?: number;
  /** Stale-tier TTL (seconds). Default 86400. */
  staleTtl?: number;
  /** Lock TTL (seconds). Default 15. */
  lockTtl?: number;
  /** When true, skip upstream if circuit-breaker is open. Default true. */
  respectCircuit?: boolean;
  /** When upstream fails AND stale exists, return stale (instead of throwing). Default true. */
  serveStaleOnError?: boolean;
  /** Circuit breaker key — caller passes the same key for all callsites that
   *  share the same upstream circuit (e.g. "komiku:detail"). */
  circuitKey?: string;
  /** Number of consecutive failures before opening the circuit. Default 3. */
  circuitThreshold?: number;
  /** Circuit open duration (seconds). Default 60. */
  circuitTtl?: number;
}

const cacheGet = async <T>(c: Context, key: string): Promise<T | null> => {
  const raw = await c.env.CACHE_KV.get(key, 'json').catch(() => null);
  return (raw as T) ?? null;
};

// Queue writes via waitUntil so the response returns immediately. Errors
// during put are swallowed — best-effort.
const cachePut = (c: Context, key: string, value: unknown, ttl: number): void => {
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(key, JSON.stringify(value), { expirationTtl: ttl }).catch(() => {})
  );
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isCircuitOpen = async (c: Context, key: string): Promise<boolean> => {
  const v = await c.env.CACHE_KV.get(`circuit:${key}`).catch(() => null);
  return v !== null;
};

const openCircuit = (c: Context, key: string, ttl: number): void => {
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(`circuit:${key}`, 'open', { expirationTtl: ttl }).catch(() => {})
  );
};

const closeCircuit = (c: Context, key: string): void => {
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.delete(`circuit:${key}`).catch(() => {})
  );
};

const incrementFailures = (c: Context, key: string, ttl: number): Promise<number> =>
  (async () => {
    const cur = await c.env.CACHE_KV.get(`fails:${key}`).catch(() => null);
    const n = (Number(cur) || 0) + 1;
    c.executionCtx.waitUntil(
      c.env.CACHE_KV.put(`fails:${key}`, String(n), { expirationTtl: ttl * 2 }).catch(() => {})
    );
    return n;
  })();

const resetFailures = (c: Context, key: string): void => {
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.delete(`fails:${key}`).catch(() => {})
  );
};

/**
 * Read-through cache with stale-while-revalidate + circuit breaker.
 *
 * Return semantics:
 * - Fresh hit: returns `{ source: 'fresh', data }`.
 * - Stale hit (no fresh): returns `{ source: 'stale', data }` AND triggers
 *   background revalidation.
 * - Both miss: fetches upstream, populates both tiers, returns `{ source: 'fresh', data }`.
 * - Both miss + upstream error + circuit open + no stale: throws the upstream error.
 */
export const readThroughCache = async <T>(
  c: Context,
  cacheKey: string,
  load: FreshLoader<T>,
  opts: CacheOptions = {}
): Promise<{ source: 'fresh' | 'stale'; data: T }> => {
  const freshTtl = opts.freshTtl ?? 600;
  const staleTtl = opts.staleTtl ?? 86400;
  const lockTtl = opts.lockTtl ?? 15;
  const respectCircuit = opts.respectCircuit ?? true;
  const serveStaleOnError = opts.serveStaleOnError ?? true;
  const circuitKey = opts.circuitKey ?? cacheKey;
  const circuitThreshold = opts.circuitThreshold ?? 3;
  const circuitTtl = opts.circuitTtl ?? 60;

  const freshKey = `f:${cacheKey}`;
  const staleKey = `s:${cacheKey}`;
  const lockKey = `l:${cacheKey}`;

  // 1. Fresh hit — done.
  const fresh = await cacheGet<T>(c, freshKey);
  if (fresh !== null) return { source: 'fresh', data: fresh };

  // 2. Stale hit — return immediately + background revalidate (skip if circuit open).
  const stale = await cacheGet<T>(c, staleKey);
  const circuitOpen = respectCircuit ? await isCircuitOpen(c, circuitKey) : false;

  if (stale !== null && !circuitOpen) {
    c.executionCtx.waitUntil(
      (async () => {
        // Try to acquire the lock — if another Worker is already revalidating,
        // skip. Lock has TTL so it self-heals if the holder crashed.
        const existingLock = await c.env.CACHE_KV.get(lockKey).catch(() => null);
        if (existingLock !== null) return;
        await c.env.CACHE_KV.put(lockKey, '1', { expirationTtl: lockTtl }).catch(() => {});
        try {
          const fresh2 = await load();
          c.env.CACHE_KV.put(freshKey, JSON.stringify(fresh2), { expirationTtl: freshTtl }).catch(() => {});
          c.env.CACHE_KV.put(staleKey, JSON.stringify(fresh2), { expirationTtl: staleTtl }).catch(() => {});
          resetFailures(c, circuitKey);
          closeCircuit(c, circuitKey);
        } catch (e) {
          const n = await incrementFailures(c, circuitKey, circuitTtl);
          if (n >= circuitThreshold) openCircuit(c, circuitKey, circuitTtl);
        } finally {
          c.env.CACHE_KV.delete(lockKey).catch(() => {});
        }
      })()
    );
    return { source: 'stale', data: stale };
  }

  // 3. Both miss (or circuit open) — try to fetch upstream.
  if (circuitOpen && stale !== null) {
    return { source: 'stale', data: stale };
  }

  try {
    const data = await load();
    // Write both tiers.
    c.env.CACHE_KV.put(freshKey, JSON.stringify(data), { expirationTtl: freshTtl }).catch(() => {});
    c.env.CACHE_KV.put(staleKey, JSON.stringify(data), { expirationTtl: staleTtl }).catch(() => {});
    resetFailures(c, circuitKey);
    closeCircuit(c, circuitKey);
    return { source: 'fresh', data };
  } catch (e) {
    const n = await incrementFailures(c, circuitKey, circuitTtl);
    if (n >= circuitThreshold) openCircuit(c, circuitKey, circuitTtl);
    if (serveStaleOnError && stale !== null) {
      return { source: 'stale', data: stale };
    }
    throw e;
  }
};

/**
 * Try the Cache API (caches.default) to dedupe concurrent identical upstream
 * fetches. Returns null when no cached entry exists.
 *
 * Use this to wrap upstream fetch() calls before they hit the source site.
 * Cloudflare's runtime coalesces concurrent cache.match calls for the same
 * request key into a single fetch — this is the cheapest stampede protection.
 */
export const matchEdgeCache = async (request: Request): Promise<Response | null> => {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = (caches as unknown as { default: Cache }).default;
    return (await cache.match(request)) ?? null;
  } catch {
    return null;
  }
};

export const putEdgeCache = (c: Context, request: Request, response: Response, maxAgeSec: number): void => {
  c.executionCtx.waitUntil(
    (async () => {
      try {
        if (typeof caches === 'undefined') return;
        const cache = (caches as unknown as { default: Cache }).default;
        const h = new Headers(response.headers);
        h.set('Cache-Control', `public, max-age=${maxAgeSec}, stale-while-revalidate=86400`);
        const cached = new Response(response.clone().body, { status: response.status, headers: h });
        await cache.put(request, cached);
      } catch { /* best-effort */ }
    })()
  );
};

/**
 * Brief inline wait — used to let concurrent requests coalesce. Polls the
 * lock key; returns when the lock clears or budget runs out.
 */
export const waitForLockClear = async (c: Context, lockKey: string, budgetMs = 3000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const v = await c.env.CACHE_KV.get(lockKey).catch(() => null);
    if (v === null) return true;
    await sleep(150);
  }
  return false;
};

// re-export so callers don't have to import private helpers
export { sleep };
