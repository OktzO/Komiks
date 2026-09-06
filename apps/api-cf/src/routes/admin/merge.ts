import { Hono } from 'hono';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminKey, requireAdminSession } from '../../lib/auth';
import { rateLimitAdmin } from '../../lib/rateLimit';

export const router = new Hono<{ Bindings: Env }>();

// Merge mutations: require admin session role (OAuth). Step-up password removed.
router.use('*', requireAdminKey);
router.use('*', rateLimitAdmin);
router.use('*', requireAdminSession);
router.use('*', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});

// GET /api/admin/merge/queue?status=pending
router.get('/queue', async (c: Context) => {
  const status = c.req.query('status');
  const items = await getDb(c).listMergeQueue(status);
  // Resolve candidate ids to series rows (title/slug/source) for the UI.
  const ids = new Set<number>();
  for (const it of items) {
    try { for (const id of JSON.parse(it.candidate_ids) as number[]) ids.add(id); } catch {}
  }
  const series: Record<number, { id: number; slug: string; title: string; source: string } | null> = {};
  for (const id of ids) {
    const row = await getDb(c).getSeriesById(id);
    series[id] = row ? { id: id, slug: row.slug, title: row.title, source: row.source } : null;
  }
  return json(c, { data: items, candidates: series });
});

// POST /api/admin/merge/queue/:id  {action:'merge'|'reject', targetMangaId?}
router.post('/queue/:id', async (c: Context) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => null) as { action?: string; targetMangaId?: number } | null;
  if (!body || (body.action !== 'merge' && body.action !== 'reject')) {
    return json(c, { error: "action required: 'merge' or 'reject'" }, 400);
  }
  const res = await getDb(c).resolveMergeQueue(id, body.action, body.targetMangaId);
  if (!res.success) return json(c, { error: 'resolve failed — item not pending or target missing' }, 400);
  return json(c, { ok: true });
});

// POST /api/admin/merge/series  {targetSlug, sourceSlug}
router.post('/series', async (c: Context) => {
  const body = await c.req.json().catch(() => null) as { targetSlug?: string; sourceSlug?: string } | null;
  if (!body?.targetSlug || !body?.sourceSlug) {
    return json(c, { error: 'targetSlug and sourceSlug required' }, 400);
  }
  const res = await getDb(c).mergeSeries(body.targetSlug, body.sourceSlug);
  if (!res.success) return json(c, { error: 'merge failed — slugs invalid or identical' }, 400);
  return json(c, { ok: true });
});