import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { db } from '@manga-platform/db';
import { getSessionUser } from '../lib/auth';

export const router = new Hono<{ Bindings: Env }>();

router.use('*', async (c, next) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  (c as unknown as { set: (k: string, v: unknown) => void }).set('user', user);
  await next();
});

router.post('/bookmark', async (c: Context) => {
  const user = (c as unknown as { get: (k: string) => { id: number } }).get('user');
  const { seriesSlug } = await c.req.json() as { seriesSlug?: string };
  if (!seriesSlug) return c.json({ error: 'seriesSlug required' }, 400);
  await db(c.env.DB).addBookmark({ userId: user.id, seriesSlug });
  return c.json({ ok: true });
});

router.delete('/bookmark/:slug', async (c: Context) => {
  const user = (c as unknown as { get: (k: string) => { id: number } }).get('user');
  await db(c.env.DB).removeBookmark({ userId: user.id, seriesSlug: c.req.param('slug') });
  return c.json({ ok: true });
});

router.get('/bookmarks', async (c: Context) => {
  const user = (c as unknown as { get: (k: string) => { id: number } }).get('user');
  const results = await db(c.env.DB).listBookmarks(user.id);
  return c.json({ data: results });
});

router.post('/history', async (c: Context) => {
  const user = (c as unknown as { get: (k: string) => { id: number } }).get('user');
  const { chapterId, lastPage } = await c.req.json() as { chapterId?: string; lastPage?: number };
  if (!chapterId) return c.json({ error: 'chapterId required' }, 400);
  await db(c.env.DB).upsertHistory({ userId: user.id, chapterId, lastPage: lastPage ?? 0 });
  return c.json({ ok: true });
});

router.get('/history', async (c: Context) => {
  const user = (c as unknown as { get: (k: string) => { id: number } }).get('user');
  const results = await db(c.env.DB).listHistory(user.id);
  return c.json({ data: results });
});
