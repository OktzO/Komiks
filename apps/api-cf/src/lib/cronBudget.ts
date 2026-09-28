/** Subrequests one cron invocation may spend, and how it is split.
 *
 *  The Workers free plan allows 50 per invocation — not per step. The cron runs
 *  the outbox flush, the catalogue crawl, the chapter refresh, the eviction
 *  sweep and the homepage feed inside one `scheduled()` callback, so their
 *  allowances are shares of the same 50 and have to be planned together. Budget
 *  the novel work against the plan's cap and the eviction sweep and the feed
 *  that follow it have nothing left: "Too many subrequests" is not catchable, the
 *  runtime drops the invocation, so the steps after the overspend never run at
 *  all. The crash moves rather than disappears.
 *
 *  The headroom is deliberate slack, not a rounding error. Every step also pays
 *  for bookkeeping the allowance does not model — the eviction lock, the feed
 *  timestamps, the flush's own pending count — and those are real subrequests
 *  billed to the same 50.
 *
 *  A paid plan allows 1000. Raise `CRON_SUBREQUEST_CAP` and the steps with it;
 *  the defaults below are sized for the free plan and a step that needs more
 *  takes its share from here rather than declaring its own number.
 */
export const CRON_SUBREQUEST_CAP = 50;

export const CRON_SUBREQUEST_HEADROOM = 6;

export const CRON_STEP_BUDGETS = {
  /** A retry row is one forward plus one D1 write, on top of the pass's own
   *  SELECT and pending count. Two rows is what that buys. */
  outbox: 6,
  /** One listing page plus the series it introduces; the cursor carries the
   *  rest of the listing to the next tick. */
  catalog: 8,
  /** Cursor, chapter list, window of chapter bodies, the upserts and the
   *  updated_at touch. */
  refresh: 16,
  /** Temp-object sweep, usage-based eviction and the usage snapshot.
   *
   *  A reservation, not a bound: `snapshotUsage` alone counts eleven tables, and
   *  `cleanupTempObjects` deletes one object per stale row with no cap of its
   *  own. The number here is what the plan sets aside so those steps are not
   *  left with nothing, and the headroom below is what absorbs the excess on a
   *  tick where they overrun. Bounding the sweep itself is a separate change —
   *  the cron is not where it belongs. */
  eviction: 6,
  /** Five source scrapes, two KV writes and the peer push. */
  homepage: 8,
} as const;

export const CRON_STEPS_TOTAL: number =
  Object.values(CRON_STEP_BUDGETS).reduce((sum, n) => sum + n, 0);
