import { Hono } from 'hono';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminSession, requireAuth, revokeAllSessionsForUser } from '../../lib/auth';
import { resolveB2Accounts } from '../../lib/b2Config';
import { getB2Usage, getB2UsageGlobal, quotaBytes } from '../../lib/b2Usage';

export const router = new Hono<{ Bindings: Env }>();

router.use('*', requireAdminSession);
router.use('*', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});

// GET /api/admin/dashboard/storage — current B2 usage per account (KV) +
// D1 estimate (KV) + historical trend (db_usage_snapshot, 30d).
router.get('/dashboard/storage', async (c: Context) => {
  const d = getDb(c);
  const accounts = resolveB2Accounts(c.env.B2_CONFIG, c.env.B2_ACCOUNTS);
  const quota = quotaBytes(c.env);
  const current: Array<{ idx: number; name: string; bucket: string; bytes: number; quota: number }> = [];
  let totalBytes = 0;
  for (let i = 0; i < accounts.length; i++) {
    const global = await getB2UsageGlobal(c, accounts[i].name).catch(() => null);
    const bytes = global ?? (await getB2Usage(c.env.CACHE_KV, i).catch(() => 0));
    totalBytes += bytes;
    current.push({ idx: i, name: accounts[i].name, bucket: accounts[i].bucket, bytes, quota });
  }
  const d1 = await c.env.CACHE_KV.get('d1:usage', { type: 'json' }).catch(() => null) as { bytes?: number } | null;
  const trend = await d.getDbUsageTrend(30);
  return json(c, {
    data: {
      accounts: current,
      total_bytes: totalBytes,
      d1_bytes: d1?.bytes ?? null,
      quota,
      trend,
    },
  });
});

// GET /api/admin/dashboard/source-health — per-source success rate (source_health)
// + chapters scraped last 7d (manga_source_link).
router.get('/dashboard/source-health', async (c: Context) => {
  const d = getDb(c);
  const summary = await d.getSourceHealthSummary();
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const scraped = await d.countScrapedChaptersBySource(since);
  const bySource = new Map(scraped.map((s) => [s.source, s]));
  const data = summary.map((s) => ({
    ...s,
    chapters_7d: bySource.get(s.source)?.chapters ?? 0,
    last_scrape_7d: bySource.get(s.source)?.last_scraped_at ?? null,
  }));
  return json(c, { data });
});

// GET /api/admin/dashboard/requests?days=7 — per-origin request counts per day
// (lb_usage, real request counts — not bandwidth bytes).
router.get('/dashboard/requests', async (c: Context) => {
  const d = getDb(c);
  const days = Math.min(Number(c.req.query('days') ?? 7) || 7, 30);
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = await d.listLbUsageRange(from, to);
  const origins = [...new Set(rows.map((r) => r.origin_url))];
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(new Date(today.getTime() - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
  }
  const series = origins.map((o) => ({
    origin: o,
    points: dates.map((dt) => rows.find((r) => r.origin_url === o && r.date_key === dt)?.req_count ?? 0),
  }));
  return json(c, { data: { dates, series } });
});

// ---- security events feed ----------------------------------------------------
router.get('/security-events', async (c: Context) => {
  const d = getDb(c);
  const resolved = c.req.query('resolved');
  const data = await d.listSecurityEvents({
    resolved: resolved === undefined ? undefined : resolved === '1' || resolved === 'true',
    page: c.req.query('page') ? Number(c.req.query('page')) : 1,
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : 20,
  });
  return json(c, data);
});

router.patch('/security-events/:id', async (c: Context) => {
  const d = getDb(c);
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return json(c, { error: 'invalid id' }, 400);
  await d.resolveSecurityEvent(id);
  return json(c, { ok: true });
});

// ---- user moderation (status/role) -------------------------------------------
router.patch('/users/:id', async (c: Context) => {
  const d = getDb(c);
  const admin = requireAuth(c);
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return json(c, { error: 'invalid id' }, 400);
  const body = await c.req.json().catch(() => null) as { status?: string; role?: string } | null;
  if (!body) return json(c, { error: 'invalid body' }, 400);
  if (body.status && !['active', 'suspended', 'banned'].includes(body.status)) {
    return json(c, { error: 'invalid status' }, 400);
  }
  if (body.role && !['user', 'admin'].includes(body.role)) {
    return json(c, { error: 'invalid role' }, 400);
  }
  if (body.role === 'user' && admin?.id === id) {
    return json(c, { error: 'cannot demote self' }, 400);
  }
  const target = await d.getUserStatusAdmin(id);
  if (!target) return json(c, { error: 'user not found' }, 404);
  await d.updateUserAdmin(id, { status: body.status, role: body.role });
  if (body.status === 'banned' || body.status === 'suspended') {
    await revokeAllSessionsForUser(c.env, id);
  }
  await d.addAuditLog({
    action: `user.update${body.status ? '.' + body.status : ''}${body.role ? '.role:' + body.role : ''}`,
    userId: id,
  });
  return json(c, { ok: true });
});
