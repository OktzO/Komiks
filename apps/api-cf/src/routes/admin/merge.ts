import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminKey, constantTimeEqualStr } from '../../lib/auth';
import { rateLimitAdmin } from '../../lib/rateLimit';

export const router = new Hono<{ Bindings: Env }>();

// Step-up re-auth: every merge mutation requires the admin password hash
// echoed back via x-admin-stepup (constant-time compare, mirrors lb.ts).
const requireAdminStepUp: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const supplied = c.req.header('x-admin-stepup');
  const expected = c.env.ADMIN_PASSWORD_HASH || c.env.ADMIN_PASSWORD;
  if (!expected || !supplied || !constantTimeEqualStr(supplied, expected)) {
    return json(c, { error: 'step-up auth required' }, 401);
  }
  await next();
};

router.use('*', requireAdminKey);
router.use('*', rateLimitAdmin);
router.use('*', requireAdminStepUp);

// GET /api/admin/merge/queue?status=pending
router.get('/queue', async (c: Context) => {
  const status = c.req.query('status');
  const items = await getDb(c).listMergeQueue(status);
  return json(c, { data: items });
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