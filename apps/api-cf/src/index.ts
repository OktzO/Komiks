import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { Env, json, parseAllowedOrigins } from './lib/context';
import { rateLimit } from './lib/rateLimit';
import { router as healthRouter } from './routes/health';
import { router as seriesRouter } from './routes/series';
import { router as searchRouter } from './routes/search';
import { router as lbAdminRouter } from './routes/admin/lb';
import { router as readerRouter } from './routes/reader';
import { router as authRouter } from './routes/auth';
import { router as userRouter } from './routes/user';

const corsMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const allowed = parseAllowedOrigins(c.env);
  const origin = c.req.header('origin');
  if (origin && allowed.includes(origin)) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Vary', 'Origin');
  }
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-stepup');

  if (c.req.method === 'OPTIONS') {
    c.res.headers.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers: c.res.headers });
  }

  await next();
};

export const app = new Hono<{ Bindings: Env }>();

app.use('*', corsMw);
app.use('*', rateLimit);
app.route('/api', healthRouter);
app.route('/api', seriesRouter);
app.route('/api', searchRouter);
app.route('/api/admin/lb', lbAdminRouter);
app.route('/api/reader', readerRouter);
app.route('/api/auth', authRouter);
app.route('/api/user', userRouter);

app.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

app.notFound((c) => json(c, { error: 'Not Found' }, 404));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runHealthChecks(env));
  }
};

async function runHealthChecks(env: Env): Promise<void> {
  try {
    const { db } = await import('@manga-platform/db');
    const d = db(env.DB);
    const settings = await d.getLbSettings();
    if (!settings || settings.mode !== 'on') return;
    const origins = await d.listOrigins();
    const now = Math.floor(Date.now() / 1000);
    await Promise.all(origins.filter((o) => o.enabled === 1).map(async (o) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), settings.health_check_timeout_ms || 3000);
        const res = await fetch(o.origin_url + '/api/health', { signal: ctrl.signal });
        clearTimeout(t);
        const healthy = res.ok;
        await d.recordOriginHealth(o.id, healthy, now);
        await env.CACHE_KV.put(`lb:origin:${o.id}`, JSON.stringify({ healthy, last_checked_at: now, latency: Date.now() % 1000 }), { expirationTtl: 60 });
      } catch {
        await d.recordOriginHealth(o.id, false, now);
      }
    }));
  } catch (e) {
    console.error('[cron health]', e);
  }
}
