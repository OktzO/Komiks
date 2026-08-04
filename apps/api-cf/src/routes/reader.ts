import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import type { Env, Context } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

router.get('/:source/:chapterId/:pageNo', async (c: Context) => {
  const { source, chapterId, pageNo } = c.req.param();
  const n = Number(pageNo);
  if (!Number.isInteger(n) || n < 1) return c.json({ error: 'bad page number' }, 400);

  const adapter = getAdapter(source, c.env);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);

  let pages: { url: string; proxyHeaders?: Record<string, string> }[];
  try {
    pages = await adapter.fetchPageUrls(chapterId);
  } catch (e) {
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }

  const page = pages[n - 1];
  if (!page) return c.json({ error: 'page not found' }, 404);

  const upstream = await fetch(page.url, {
    headers: { 'User-Agent': 'manga-platform/1.0', ...(page.proxyHeaders || {}) }
  });

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=300');
  const origin = (c.env.ALLOWED_ORIGINS || '*').split(',')[0].trim();
  headers.set('Access-Control-Allow-Origin', origin);

  return new Response(upstream.body, { status: upstream.status, headers });
});
