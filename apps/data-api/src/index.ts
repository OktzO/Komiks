import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { Env, parseAllowedOrigins } from './lib/context';
import { rateLimitPublic } from './lib/rateLimit';
import { router as healthRouter } from './routes/health';
import { router as searchRouter } from './routes/search';
import { router as mangaRouter } from './routes/manga';
import { router as sourceStatusRouter } from './routes/sourceStatus';

const corsMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const allowed = parseAllowedOrigins(c.env);
  const origin = c.req.header('origin');
  if (origin && allowed.includes(origin)) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Vary', 'Origin');
  }
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-api-key');
  if (c.req.method === 'OPTIONS') {
    c.res.headers.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers: c.res.headers });
  }
  await next();
};

export const app = new Hono<{ Bindings: Env }>();

app.use('*', corsMw);
app.use('*', rateLimitPublic);
app.route('/api', healthRouter);
app.route('/api', searchRouter);
app.route('/api', mangaRouter);
app.route('/api', sourceStatusRouter);

app.onError((err, c) => {
  console.error('[data-api]', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not Found' }, 404));

export default {
  fetch: app.fetch,
};
