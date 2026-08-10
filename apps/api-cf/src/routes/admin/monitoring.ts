// QA checklist (spec Section 6):
// 1. Login Google non-oktzoffc@gmail.com → GET /api/admin/overview → 403 (not redirect, data not visible)
// 2. Login oktzoffc@gmail.com → GET /api/admin/overview → 200 + numbers
// 3. Delete session cookie → GET /api/admin/overview → 403
// 4. Admin session + wrong x-admin-stepup → GET /api/admin/overview → 200 (read doesn't need step-up)
// 5. Admin session, no x-admin-stepup → PUT /api/admin/lb/settings → 401 (write still needs step-up)
import { Hono } from 'hono';
import type { Context, Env } from '../../lib/context';
import { json, getDb } from '../../lib/context';
import { requireAdminSession } from '../../lib/auth';

export const router = new Hono<{ Bindings: Env }>();

router.use('*', requireAdminSession);

// GET /api/admin/overview — aggregate counts for /admin dashboard.
router.get('/overview', async (c: Context) => {
  const d = getDb(c);
  const data = await d.getAdminOverview();
  return json(c, { data });
});

// GET /api/admin/providers — list all provider_accounts (metrics only, no secrets).
router.get('/providers', async (c: Context) => {
  const d = getDb(c);
  const data = await d.listProviderAccounts();
  // Sanitize: truncate last_error to 200 chars to prevent credential leak via error messages.
  const sanitized = data.map((p) => ({ ...p, last_error: p.last_error ? p.last_error.slice(0, 200) : null }));
  return json(c, { data: sanitized });
});

// GET /api/admin/providers/:id/health — hourly buckets from scrape_jobs_log for charting.
router.get('/providers/:id/health', async (c: Context) => {
  const d = getDb(c);
  const id = c.req.param('id');
  const hours = Math.min(Number(c.req.query('hours') ?? 24), 168); // cap 7d
  const rows = await d.getProviderHealthBuckets(id, hours);
  // Bucket by hour.
  const buckets = new Map<number, { requests: number; failures: number }>();
  for (const r of rows) {
    const bucket = Math.floor(r.started_at / 3600) * 3600;
    const b = buckets.get(bucket) ?? { requests: 0, failures: 0 };
    b.requests += 1;
    if (r.status === 'failed' || r.status === 'partial') b.failures += 1;
    buckets.set(bucket, b);
  }
  const labels: number[] = [];
  const requests: number[] = [];
  const failures: number[] = [];
  for (const [ts, b] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    labels.push(ts);
    requests.push(b.requests);
    failures.push(b.failures);
  }
  return json(c, { data: { labels, requests, failures, total: rows.length } });
});

// GET /api/admin/scrape-jobs — paginated list with filters.
router.get('/scrape-jobs', async (c: Context) => {
  const d = getDb(c);
  const data = await d.listScrapeJobsLog({
    source: c.req.query('source') || undefined,
    status: c.req.query('status') || undefined,
    from: c.req.query('from') ? Number(c.req.query('from')) : undefined,
    to: c.req.query('to') ? Number(c.req.query('to')) : undefined,
    page: c.req.query('page') ? Number(c.req.query('page')) : 1,
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : 20,
  });
  return json(c, data);
});

// GET /api/admin/db-usage — current snapshot + 7d trend.
router.get('/db-usage', async (c: Context) => {
  const d = getDb(c);
  const days = c.req.query('days') ? Number(c.req.query('days')) : 7;
  const trend = await d.getDbUsageTrend(days);
  // Current = last point per db.
  const current = trend.map((t) => {
    const last = t.points[t.points.length - 1] ?? null;
    return {
      db_name: t.db_name,
      rows_or_objects: last?.rows_or_objects ?? null,
      size_bytes: last?.size_bytes ?? null,
    };
  });
  return json(c, { data: { current, trend } });
});

// GET /api/admin/users — paginated user list with search.
router.get('/users', async (c: Context) => {
  const d = getDb(c);
  const data = await d.listUsersAdmin({
    q: c.req.query('q') || undefined,
    page: c.req.query('page') ? Number(c.req.query('page')) : 1,
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : 20,
  });
  return json(c, data);
});

// GET /api/admin/users/:id — single user detail.
router.get('/users/:id', async (c: Context) => {
  const d = getDb(c);
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return json(c, { error: 'invalid id' }, 400);
  const data = await d.getUserDetail(id);
  if (!data) return json(c, { error: 'user not found' }, 404);
  return json(c, { data });
});

// GET /api/admin/users/:id/bookmarks — paginated bookmarks for a user.
router.get('/users/:id/bookmarks', async (c: Context) => {
  const d = getDb(c);
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return json(c, { error: 'invalid id' }, 400);
  const data = await d.listUserBookmarksAdmin(id, {
    page: c.req.query('page') ? Number(c.req.query('page')) : 1,
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : 20,
  });
  return json(c, data);
});
