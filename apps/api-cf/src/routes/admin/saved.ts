import { Hono } from 'hono';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminSession } from '../../lib/auth';

export const router = new Hono<{ Bindings: Env }>();

router.use('*', requireAdminSession);
router.use('*', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});

// GET /api/admin/saved — konten tersimpan: judul/chapter/panel + storage (KV).
router.get('/saved', async (c: Context) => {
  const d = getDb(c);
  const page = Math.min(Math.max(Number(c.req.query('page') ?? 1) || 1, 1), 1_000_000);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);
  const [summary, series, chapters] = await Promise.all([
    d.getSavedContentSummary(),
    d.listSavedSeries({ page, limit }),
    d.listSavedChapters({ page, limit }),
  ]);
  return json(c, {
    data: {
      summary,
      series: series.rows,
      chapters: chapters.rows,
      total: chapters.total,
      page,
      limit,
    },
  });
});