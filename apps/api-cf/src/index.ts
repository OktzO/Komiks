import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { Env, json, allowedOriginFor } from './lib/context';
import { rateLimit, rateLimitIdentify, rateLimitAdmin } from './lib/rateLimit';
import { router as healthRouter } from './routes/health';
import { router as seriesRouter } from './routes/series';
import { router as searchRouter } from './routes/search';
import { router as mangaRouter } from './routes/manga';
import { router as sourceStatusRouter } from './routes/sourceStatus';
import { router as originsRouter } from './routes/origins';
import { router as identifyRouter } from './routes/identify';
import { router as lbAdminRouter } from './routes/admin/lb';
import { router as monitoringAdminRouter } from './routes/admin/monitoring';
import { router as scrapeRouter } from './routes/admin/scrape';
import { router as mergeAdminRouter } from './routes/admin/merge';
import { router as readerRouter } from './routes/reader';
import { router as authRouter } from './routes/auth';
import { router as userRouter } from './routes/user';
import { router as internalRouter } from './routes/internal';
import { evictStaleStorage } from './lib/storageEviction';
import { syncB2UsageFromBuckets } from './lib/b2Usage';

// CORS: allow credentials only when origin matches the allowlist.
// Fail-closed: if ALLOWED_ORIGINS is unset, no origin is echoed and no
// credentials header is emitted.
//
// CSRF guard: for state-changing methods, a cross-origin request whose Origin
// fails the allowlist is REJECTED (403), not merely left without CORS headers.
// SameSite=None cookie is sent on cross-site form POSTs, so the request would
// otherwise execute server-side even though the browser can't read the reply.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const corsMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const origin = c.req.header('origin');

  if (origin && !SAFE_METHODS.has(c.req.method) && !allowedOriginFor(c.env, origin)) {
    return c.json({ error: 'forbidden origin' }, 403);
  }

  if (origin && allowedOriginFor(c.env, origin)) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
    c.res.headers.set('Vary', 'Origin');
  }
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-api-key');

  if (c.req.method === 'OPTIONS') {
    c.res.headers.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers: c.res.headers });
  }

  await next();
};

// Security headers applied to every response. CSP is intentionally permissive
// for an API (no inline assets served here); images are proxied through /api/reader.
const securityHeadersMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
};

export const app = new Hono<{ Bindings: Env }>();

app.use('*', securityHeadersMw);
app.use('*', corsMw);
// Internal router mounts BEFORE the global rate limit — cross-account peer
// calls (akun-1→2→3) share Worker egress IPs and must not be throttled.
app.route('/api/_internal', internalRouter);
app.use('*', rateLimit);
app.route('/api', healthRouter);
app.route('/api', seriesRouter);
app.route('/api', searchRouter);
app.route('/api', mangaRouter);
app.route('/api', sourceStatusRouter);
app.route('/api', originsRouter);
app.route('/api/admin/lb', lbAdminRouter);
app.route('/api/admin/merge', mergeAdminRouter);
// Admin monitoring: read-only endpoints (overview, providers, scrape-jobs, db-usage, users).
// requireAdminSession (session.role===admin) enforced inside router. rateLimitAdmin applies to all /api/admin/*.
app.use('/api/admin', rateLimitAdmin);
app.route('/api/admin', monitoringAdminRouter);
app.route('/api/reader', readerRouter);
app.route('/api/auth', authRouter);
app.route('/api/user', userRouter);

// Identify route has its own rate limit (10/min) — register before the route
// but after the global limiter so the stricter limit takes effect.
app.use('/api/identify', rateLimitIdentify);
app.route('/api', identifyRouter);

// Scrape routes: admin key auth is enforced inside the router (requireAdminKey).
// The admin rate limit (600/min) is registered here; note the global 60/min
// limiter above still applies first, so effectively scrape is capped at 60/min
// unless the global limiter is restructured. This is intentional for now —
// scrape is an admin-only, low-frequency operation.
app.use('/api/scrape', rateLimitAdmin);
app.route('/api', scrapeRouter);

app.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

app.notFound((c) => json(c, { error: 'Not Found' }, 404));

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: unknown,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ): Promise<void> {
    if (env.EVICTION_OWNER !== '1') return; // hanya akun-1 yang punya cron
    const run = async () => {
      const kv = env.CACHE_KV;
      const lock = await kv.get('eviction:lock').catch(() => null);
      if (lock) return;
      await kv.put('eviction:lock', '1', { expirationTtl: 600 }).catch(() => {});
      try {
        await syncB2UsageFromBuckets(env as Env);
        const res = await evictStaleStorage(env as Env);
        console.log(`[cron] eviction done: ${res.evicted} objects`);
      } finally {
        await kv.delete('eviction:lock').catch(() => {});
      }
    };
    ctx.waitUntil(run());
  },
};
