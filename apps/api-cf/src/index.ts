import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { Env, json, allowedOriginFor, Context } from './lib/context';
import { rateLimit, rateLimitIdentify, rateLimitAdmin, rateLimitImg, rateLimitInternal } from './lib/rateLimit';
import { router as healthRouter } from './routes/health';
import { router as seriesRouter } from './routes/series';
import { router as searchRouter } from './routes/search';
import { router as homepageRouter } from './routes/homepage';
import { router as mangaRouter } from './routes/manga';
import { router as sourceStatusRouter } from './routes/sourceStatus';
import { router as originsRouter } from './routes/origins';
import { router as identifyRouter } from './routes/identify';
import { router as lbAdminRouter } from './routes/admin/lb';
import { router as monitoringAdminRouter } from './routes/admin/monitoring';
import { router as dashboardAdminRouter } from './routes/admin/dashboard';
import { router as scrapeRouter } from './routes/admin/scrape';
import { router as mergeAdminRouter } from './routes/admin/merge';
import { router as readerRouter, imgRouter } from './routes/reader';
import { router as resolveRouter } from './routes/resolve';
import { router as authRouter } from './routes/auth';
import { router as userRouter } from './routes/user';
import { router as internalRouter } from './routes/internal';
import { evictStaleStorage, cleanupTempObjects } from './lib/storageEviction';
import { getB2Usage } from './lib/b2Usage';
import { writeWithFallback, flushOutbox } from './lib/dbWrite';
import { recordSecurityEvent } from './lib/securityEvents';
import { fetchHomepageFromSources } from './routes/homepage';
import { peerKvSet } from './lib/peers';
import { resolveB2Accounts } from './lib/b2Config';
import { client as dbClient } from '@manga-platform/db';

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
    recordSecurityEvent(c, {
      type: 'blocked_origin',
      severity: 'high',
      message: `forbidden origin on ${c.req.method} ${c.req.path}`,
    });
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

// Per-user / sensitive routes: Wajib no-store. Workers Cache aktif di worker ini
// (cache.enabled), dan tanpa header ini response per-user (GET /me, bookmark,
// history, admin, internal) ke-cache heuristic 2 jam → data bocor antar user.
const noStoreMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
};

export const app = new Hono<{ Bindings: Env }>();

app.use('*', securityHeadersMw);
app.use('*', corsMw);
app.use('/api/_internal/*', noStoreMw);
app.use('/api/auth/*', noStoreMw);
app.use('/api/user/*', noStoreMw);
app.use('/api/admin/*', noStoreMw);
app.use('/api/scrape/*', noStoreMw);
app.use('/api/admin', rateLimitAdmin);
app.use('/api/_internal/*', rateLimitInternal);
app.route('/api/_internal', internalRouter);
app.use('/img/*', rateLimitImg);
app.route('/img', imgRouter);
app.use('*', rateLimit);
app.route('/api', healthRouter);
app.route('/api', seriesRouter);
app.route('/api', searchRouter);
app.route('/api', homepageRouter);
app.route('/api', mangaRouter);
app.route('/api', sourceStatusRouter);
app.route('/api', originsRouter);
app.route('/api/admin/lb', lbAdminRouter);
app.route('/api/admin/merge', mergeAdminRouter);
// Admin monitoring: read-only endpoints (overview, providers, scrape-jobs, db-usage, users).
// requireAdminSession (session.role===admin) enforced inside router. rateLimitAdmin applies to all /api/admin/*.
app.route('/api/admin', monitoringAdminRouter);
app.route('/api/admin', dashboardAdminRouter);
app.route('/api/reader', readerRouter);
app.route('/api', resolveRouter);
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
    const run = async () => {
      const outbox = await flushOutbox(env as Env).catch(() => ({ flushed: 0, pending: -1 }));
      console.log(`[cron] outbox flushed: ${outbox.flushed} (pending ${outbox.pending})`);
      if (env.EVICTION_OWNER !== '1') return;
      const kv = env.CACHE_KV;
      const lock = await kv.get('eviction:lock').catch(() => null);
      if (lock) return;
      await kv.put('eviction:lock', '1', { expirationTtl: 600 }).catch(() => {});
      try {
        const tmp = await cleanupTempObjects(env as Env).catch(() => ({ cleaned: 0 }));
        console.log(`[cron] temp objects cleaned: ${tmp.cleaned}`);
        const res = await evictStaleStorage(env as Env);
        console.log(`[cron] eviction done: ${res.evicted} objects`);
        await snapshotUsage(env as Env);
      } finally {
        await kv.delete('eviction:lock').catch(() => {});
      }
      // 12h homepage feed refresh: scrape once → local KV → push all peers.
      const lastStr = await kv.get('homepage:feed:last_updated').catch(() => null);
      const lastMs = lastStr ? parseInt(lastStr, 10) : 0;
      if (Date.now() - lastMs > 12 * 60 * 60 * 1000) {
        try {
          const feed = await fetchHomepageFromSources(env as Env);
          const body = JSON.stringify({ ...feed, updated_at: Date.now() });
          await kv.put('homepage:feed', body, { expirationTtl: 43200 });
          await kv.put('homepage:feed:last_updated', String(Date.now()), { expirationTtl: 43200 });
          const pushed = await peerKvSet(env as Env, 'homepage:feed', body, 43200);
          console.log(`[cron] homepage feed refreshed (${feed.sources_queried.length} sources), pushed=${pushed}`);
        } catch (e) {
          console.error('[cron] homepage refresh failed:', e);
        }
      }
    };
    ctx.waitUntil(run());
  },
};

// Hourly usage snapshot → db_usage_snapshot (admin dashboard trend charts).
// B2: one row per account (bytes from KV counter, reconciled by cron above).
// D1: real row count across main tables. Written via writeWithFallback so rows
// land on the primary DB (akun-2) where the admin dashboard reads them.
const snapshotUsage = async (env: Env): Promise<void> => {
  try {
    const fakeCtx = { env, executionCtx: { waitUntil: (p: Promise<unknown>) => void p } } as unknown as Context;
    const now = Math.floor(Date.now() / 1000);
    const dbLocal = dbClient(env.DB);
    const tables = ['series', 'chapters', 'chapter_pages', 'users', 'bookmarks', 'reading_history', 'sessions', 'source_health', 'manga_source_link', 'scrape_jobs', 'lb_usage'];
    let rows = 0;
    for (const t of tables) {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${t}`).first<{ c: number }>().catch(() => null);
      rows += r?.c ?? 0;
    }
    await writeWithFallback(fakeCtx, 'db_usage_snapshot',
      'INSERT INTO db_usage_snapshot (id, db_name, rows_or_objects, size_bytes, captured_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      [`d1:${now}`, 'd1', rows, null, now]);

    const accounts = resolveB2Accounts(env.B2_CONFIG, env.B2_ACCOUNTS);
    for (let i = 0; i < accounts.length; i++) {
      const bytes = await getB2Usage(env.CACHE_KV, i).catch(() => 0);
      await writeWithFallback(fakeCtx, 'db_usage_snapshot',
        'INSERT INTO db_usage_snapshot (id, db_name, rows_or_objects, size_bytes, captured_at) VALUES (?1, ?2, ?3, ?4, ?5)',
        [`b2:${accounts[i].name}:${now}`, `b2:${accounts[i].name}`, null, bytes, now]);
    }
  } catch (e) {
    console.error('[cron] snapshot usage failed:', e);
  }
};
