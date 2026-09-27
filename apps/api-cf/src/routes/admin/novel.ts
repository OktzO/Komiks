// Operator trigger for the novel catalogue crawl.
//
// The crawl is otherwise reachable only from the hourly cron behind a 12h KV
// guard, so an operator who deploys a parser fix — or whose sync half-failed —
// waits out the TTL with a stale catalogue and no way to ask why. This is that
// way to ask.
import { Hono } from 'hono';
import type { Context, Env } from '../../lib/context';
import { json } from '../../lib/context';
import { requireAdminSession } from '../../lib/auth';
import { CATALOG_CRAWL_KEY, isCatalogCrawler, syncCatalog } from '../../lib/novelIngest';
import { ownerFor } from '../../lib/peers';

export const router = new Hono<{ Bindings: Env }>();

// Same gate as every other read/admin surface under routes/admin/: a live
// session whose user row is still active and still role=admin.
router.use('*', requireAdminSession);
router.use('*', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});

const LAST_SYNC_KEY = 'novel:catalog:last_sync';
/** Matches the TTL the cron writes it with. */
const LAST_SYNC_TTL_SEC = 43200;

// POST /api/admin/novel/catalog/sync?force=1 — run one crawl pass now.
//
// `force` decides the 12h guard, and the choice is deliberate rather than
// implicit. The guard's original job was to stop four workers paying the same
// crawl; `isCatalogCrawler` now elects one, so all the guard does is delay a
// manual trigger, and delaying a manual trigger is the exact failure this
// endpoint exists to remove. With force=1 the guard is cleared first, so the
// pass cannot collide with a cron that is already inside its window, and
// re-stamped afterwards so the cron does not immediately re-crawl. Default
// (no force) leaves the guard alone and just runs a pass, which is the
// harmless-but-slow option an operator wants when auditing.
//
// A pass is bounded by the subrequest budget, not by the end of the listing, so
// one call is not one full catalogue. `cursor` in the reply is where the next
// pass resumes, and it is safe to call repeatedly: rows that already exist are
// recognised and cost a single listing page, never a detail refetch.
export const runCatalogSync = async (c: Context) => {
  const owner = ownerFor(c.env, CATALOG_CRAWL_KEY);
  // Owner-gated exactly as the cron is: four concurrent crawls would pay four
  // times the upstream cost for the same rows. The reply names the crawler so an
  // operator who hit the wrong worker is told where to go.
  if (!isCatalogCrawler(c.env)) {
    return json(c, { ran: false, reason: 'not-catalog-crawler', crawler: owner.url }, 409);
  }

  const force = c.req.query('force') === '1';
  if (force) await c.env.CACHE_KV.delete(LAST_SYNC_KEY).catch(() => {});

  const res = await syncCatalog(c.env);

  if (force) {
    await c.env.CACHE_KV.put(LAST_SYNC_KEY, String(Date.now()), { expirationTtl: LAST_SYNC_TTL_SEC }).catch(() => {});
  }
  console.log(
    `[admin] novel catalog sync (force=${force}): ${res.inserted} new, ${res.filled} gap-filled,`
    + ` ${res.skipped} skipped, cursor ${res.cursor}`
  );
  return json(c, { ran: true, forced: force, ...res });
};

router.post('/novel/catalog/sync', runCatalogSync);
