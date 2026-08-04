import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { Env, json, parseAllowedOrigins } from './lib/context';
import { router as healthRouter } from './routes/health';
import { router as seriesRouter } from './routes/series';
import { router as searchRouter } from './routes/search';
import { router as lbAdminRouter } from './routes/admin/lb';

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
app.route('/api', healthRouter);
app.route('/api', seriesRouter);
app.route('/api', searchRouter);
app.route('/api/admin/lb', lbAdminRouter);

app.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

app.notFound((c) => json(c, { error: 'Not Found' }, 404));

export default app;
