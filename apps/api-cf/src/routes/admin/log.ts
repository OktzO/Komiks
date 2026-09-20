import { Hono } from 'hono';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminSession } from '../../lib/auth';
import type { ScrapeJob } from '@manga-platform/shared/types';

export const router = new Hono<{ Bindings: Env }>();

router.use('*', requireAdminSession);
router.use('*', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});

type AuditLogRow = {
  id: number;
  account_id: string | null;
  origin_id: string | null;
  action: string;
  user_id: number | null;
  created_at: number;
};

type LogRow = {
  ts: number;
  type: 'admin' | 'scrape';
  actor: string | null;
  message: string;
  meta: Record<string, unknown>;
};

const normAudit = (r: AuditLogRow): LogRow => ({
  ts: r.created_at,
  type: 'admin',
  actor: r.user_id != null ? `user#${r.user_id}` : null,
  message: r.action,
  meta: { account_id: r.account_id, origin_id: r.origin_id },
});

const normScrape = (j: ScrapeJob): LogRow => ({
  ts: j.created_at ?? 0,
  type: 'scrape',
  actor: null,
  message: j.query ? `${j.source} · ${j.query}` : j.source,
  meta: { id: j.id, source: j.source, status: j.status, series_slug: j.series_slug ?? null, error: j.error ?? null },
});

// GET /api/admin/log?type=admin|scrape|all&page&limit — aktivitas admin + jobs scrape live.
router.get('/log', async (c: Context) => {
  const d = getDb(c);
  const typeRaw = c.req.query('type') || 'all';
  const type: 'admin' | 'scrape' | 'all' = typeRaw === 'admin' || typeRaw === 'scrape' ? typeRaw : 'all';
  const page = Math.min(Math.max(Number(c.req.query('page') ?? 1) || 1, 1), 1_000_000);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);

  if (type === 'admin') {
    const a = await d.listAuditLog({ page, limit });
    return json(c, {
      data: { type, rows: a.rows.map(normAudit), total: a.total, page, limit },
    });
  }
  if (type === 'scrape') {
    const jobs = (await d.listScrapeJobs(limit)) as ScrapeJob[];
    return json(c, {
      data: { type, rows: jobs.map(normScrape), total: jobs.length, page: 1, limit },
    });
  }
  const [a, jobs] = await Promise.all([
    d.listAuditLog({ page, limit }),
    d.listScrapeJobs(limit),
  ]);
  const rows = [...a.rows.map(normAudit), ...(jobs as ScrapeJob[]).map(normScrape)]
    .sort((x, y) => y.ts - x.ts)
    .slice(0, limit);
  return json(c, {
    data: { type, rows, total: a.total + (jobs as ScrapeJob[]).length, page, limit },
  });
});