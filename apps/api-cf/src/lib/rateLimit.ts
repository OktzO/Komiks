import type { MiddlewareHandler } from 'hono';
import type { Env, Context } from './context';
import { recordSecurityEvent } from './securityEvents';

// ─── In-memory rate limiter (no KV) ─────────────────────────────────────────
//
// PROBLEM: The previous KV-based limiter did 1 KV GET + 1 KV PUT per request.
// At ~100 req/min that's 200 KV ops/min → KV reads/writes quota exhausted in
// hours. KV is not designed for high-frequency counters.
//
// SOLUTION: Use a Cloudflare Worker isolates in-memory Map. Each Worker
// isolate keeps a local counter per (ip, window). This is eventually-
// consistent across isolates (a single isolate may not see traffic from
// another), but for rate limiting this is acceptable — the goal is to
// prevent abuse, not to be perfectly accurate.
//
// The Map entries auto-expire after the window so memory doesn't grow
// unboundedly.

type RateBucket = { count: number; expires: number };

// Module-level Map survives across requests within the same isolate.
// Each Worker isolate has its own copy — this is fine for rate limiting.
const rateBuckets = new Map<string, RateBucket>();

// GC: periodically clean expired entries to prevent memory growth.
// Runs at most once per 10 seconds.
let lastGc = 0;
const gcInterval = 10_000;
function maybeGc(now: number): void {
  if (now - lastGc < gcInterval) return;
  lastGc = now;
  for (const [k, v] of rateBuckets) {
    if (v.expires <= now) rateBuckets.delete(k);
  }
}

const makeLimiter = (limit: number, window: number): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const now = Date.now();
    const windowStart = Math.floor(now / 1000 / window) * window * 1000;
    const key = `${ip}:${windowStart}`;

    maybeGc(now);

    const bucket = rateBuckets.get(key);
    if (bucket && bucket.expires > now) {
      if (bucket.count >= limit) {
        const retryAfter = Math.ceil((bucket.expires - now) / 1000);
        c.header('Retry-After', String(retryAfter));
        recordSecurityEvent(c, {
          type: 'rate_limit',
          severity: 'medium',
          message: `rate limit exceeded (${limit}/${window}s) on ${c.req.path}`,
        });
        return c.json({ error: 'rate limit exceeded', retry_after: retryAfter }, 429);
      }
      bucket.count++;
    } else {
      rateBuckets.set(key, { count: 1, expires: windowStart + window * 1000 });
    }

    await next();
  };
};

export const rateLimit: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.path.startsWith('/api/_internal')) return next();
  return makeLimiter(60, 60)(c, next);
};
export const rateLimitIdentify: MiddlewareHandler<{ Bindings: Env }> = makeLimiter(10, 60);
export const rateLimitAdmin: MiddlewareHandler<{ Bindings: Env }> = makeLimiter(600, 60);
export const rateLimitMutate: MiddlewareHandler<{ Bindings: Env }> = makeLimiter(60, 3600);
export const rateLimitImg: MiddlewareHandler<{ Bindings: Env }> = makeLimiter(300, 60);
export const rateLimitInternal: MiddlewareHandler<{ Bindings: Env }> = makeLimiter(300, 60);
