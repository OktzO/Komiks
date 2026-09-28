import { novelDb } from '@manga-platform/db';
import type { NovelChapterRow, NovelSeriesRow } from '@manga-platform/db';
import { NOVEL_SOURCES, getNovelAdapter } from '@manga-platform/sources/novel';
import type { NovelAdapterEnv, NovelSeries, NovelSourceAdapter } from '@manga-platform/sources/novel';
import type { Env } from './context';
import { sha256Hex } from './context';
import { internalExecCounted, ownerFor } from './peers';
import { novelDbFor } from './novelShard';
import { enqueueOutbox } from './dbWrite';
import { CRON_STEP_BUDGETS } from './cronBudget';
import { uploadNovelCover } from './novelCover';
import { retryUpstream } from './retry';

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * What a novel adapter needs from the Worker: the KV namespace the adapter
 * caches robots.txt in. `getAdapter` bridges the same type pair for the manga
 * adapters (`CACHE_KV` is typed from @cloudflare/workers-types here, while
 * packages/sources reads the ambient KVNamespace), so the registry call does
 * the same in one place instead of at every call site.
 */
export const novelAdapterEnv = (env: Env): NovelAdapterEnv => ({
  KV: env.CACHE_KV as unknown as KVNamespace,
});

const isBlank = (value: string | null | undefined): boolean =>
  typeof value !== 'string' || value.trim().length === 0;

// Adapters already retry upstream twice on their own, so the outer wrapper only
// needs to ride out a single blip — three attempts would triple cron CPU for a
// source outage that is already failing loudly.
const upstream = <T>(fn: () => Promise<T>): Promise<T> => retryUpstream(fn, 2);

const normTitle = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The id a series is stored and routed under.
 *
 * Single-segment on purpose: the reader route is /novel/{seriesSlug}/{chapterRef},
 * so the id lands in one URL path segment, and the route 404s a slug that
 * decoded to a '/'. A hyphen keeps the source prefix without a separator that
 * breaks routing. A source id that itself contains a separator would produce an
 * unroutable id, so the caller must drop it.
 */
export const seriesIdFor = (source: string, sourceSeriesId: string): string =>
  `${source}-${sourceSeriesId}`;

/** What tier-2 is allowed to fill — the three columns spec §6.2 names. */
type GapColumn = 'cover_fallback' | 'synopsis' | 'author';
/** The tier-1 series page also carries `status`, which no search card and no
 *  tier-2 source has. Exported as data because routes/internal.ts derives the
 *  /db/exec allowlist for novel_series from every column list FILL_GAPS_SQL can
 *  be called with, and a hand-kept copy of the vocabulary there would rot into
 *  either rejecting the ingest's own writes or accepting more than they are. */
export const NOVEL_DETAIL_COLUMNS = ['cover_fallback', 'synopsis', 'author', 'status'] as const;
export type DetailColumn = (typeof NOVEL_DETAIL_COLUMNS)[number];

/** A blank tier-1 column is the only thing tier-2 is allowed to fill. The
 *  cover is a gap only when neither cover_ref nor cover_fallback is set —
 *  fillSeriesGaps cannot populate cover_ref, so a second write would be a no-op
 *  round trip. `status` is absent by design: tier-2 cannot supply it. */
const gapColumns = (series: NovelSeriesRow): GapColumn[] => {
  const cols: GapColumn[] = [];
  if (isBlank(series.cover_ref) && isBlank(series.cover_fallback)) cols.push('cover_fallback');
  if (isBlank(series.synopsis)) cols.push('synopsis');
  if (isBlank(series.author)) cols.push('author');
  return cols;
};

/** Whether the tier-1 series page still has something to say. A row that is
 *  already complete is never re-fetched, so the detail read is a one-off per
 *  series rather than a per-tick cost. */
const needsDetail = (series: NovelSeriesRow): boolean =>
  isBlank(series.author) || isBlank(series.synopsis) || isBlank(series.status)
  || (isBlank(series.cover_ref) && isBlank(series.cover_fallback));

/** Non-blank fields only, so `fillSeriesGaps`' COALESCE guard decides what lands. */
const patchFrom = (series: NovelSeries | null | undefined): Partial<Record<DetailColumn, string>> => {
  const patch: Partial<Record<DetailColumn, string>> = {};
  if (!series) return patch;
  if (series.coverUrl?.trim()) patch.cover_fallback = series.coverUrl;
  if (series.synopsis?.trim()) patch.synopsis = series.synopsis;
  if (series.author?.trim()) patch.author = series.author;
  if (series.status?.trim()) patch.status = series.status;
  return patch;
};

export const hasMetadataGap = (series: NovelSeriesRow): boolean => gapColumns(series).length > 0;

/**
 * The only place tier-2 is consulted. Builds a patch of the blank columns only,
 * then hands it to `fillSeriesGaps`, which itself refuses to overwrite a
 * populated column. A `capability: 'chapter'` adapter is not a metadata source
 * and is skipped without a call, so this can never widen into chapter work.
 */
export const fillMetadataGaps = async (
  env: Env,
  series: NovelSeriesRow,
  adapters: NovelSourceAdapter[]
): Promise<void> => {
  const wanted = gapColumns(series);
  if (wanted.length === 0) return;

  const patch: Partial<Record<GapColumn, string>> = {};
  const target = normTitle(series.title);
  for (const adapter of adapters) {
    if (adapter.capability !== 'metadata') continue;
    let match: NovelSeries | undefined;
    try {
      const found = await upstream(() => adapter.search({ q: series.title, limit: 5 }));
      // A metadata hit that is not the same novel is worse than a blank field.
      match = found?.find((c) => normTitle(c.title ?? '') === target);
    } catch (e) {
      console.error(`[novel] tier-2 search failed for ${series.id} on ${adapter.sourceKey}: ${e}`);
      continue;
    }
    if (!match) continue;
    for (const col of wanted) {
      if (patch[col] !== undefined) continue;
      const value = col === 'cover_fallback' ? match.coverUrl : match[col];
      if (!isBlank(value)) patch[col] = value as string;
    }
    if (wanted.every((col) => patch[col] !== undefined)) break;
  }

  await novelDb(env.DB).fillSeriesGaps(series.id, patch);
  // The series payload is KV-cached by the read route, so without this the fill
  // is invisible for the rest of the TTL and every request in between
  // re-detects the same gap and re-runs the tier-2 searches.
  if (Object.keys(patch).length > 0) {
    await env.CACHE_KV.delete(`novel:series:${series.id}`).catch(() => {});
  }
};

/**
 * Re-scrapes one series' chapter bodies. `source_chapter_id` is the upstream id
 * verbatim — novelid's is the composite "{slug}/{bab}" and its fetcher rejects
 * anything else, so it is never split or renumbered.
 *
 * Bounded to one window. A novelid light novel runs 200-800 episodes and every
 * chapter body costs a subrequest, so an uncapped walk exhausts the Worker
 * budget partway through, writes a silent prefix, and the next cron re-walks the
 * identical prefix.
 *
 * `source_chapter_id` aside, a chapter whose body comes back empty or missing is
 * dropped: an empty write would replace stored prose with nothing and the
 * `content_hash` guard would happily record the change.
 */

/** Subrequests this step of the cron may spend on chapter bodies.
 *
 *  One share of the invocation's 50, alongside the outbox flush, the catalogue
 *  crawl, the eviction sweep and the homepage feed — see cronBudget.ts. The
 *  previous 44 was "the cap minus the outbox", which left nothing for the steps
 *  scheduled after this one. A paid plan allows 1000 — raise
 *  NOVEL_REFRESH_BUDGET for it, not the window alone, because the window is
 *  clamped to what one visit can spend inside the budget.
 */
export const REFRESH_SUBREQUEST_BUDGET = CRON_STEP_BUDGETS.refresh;

/** Subrequests the catalogue crawl may spend, from the same plan. The crawl and
 *  the refresh run in one invocation on the elected crawler, so the crawl cannot
 *  borrow the refresh's share. */
export const CATALOG_SUBREQUEST_BUDGET = CRON_STEP_BUDGETS.catalog;

/** What a visit costs outside the window: the cursor get and put, the chapter
 *  list, the chapter upsert (a select plus a write) and the updated_at touch. */
export const REFRESH_VISIT_COST = 6;

const positiveInt = (raw: unknown, fallback: number, max: number): number => {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

const budgetFor = (env: Env): number =>
  positiveInt(env.NOVEL_REFRESH_BUDGET, REFRESH_SUBREQUEST_BUDGET, 1000);

/** Chapters one visit may fetch. Derived from the budget rather than
 *  hardcoded, so no value of NOVEL_REFRESH_WINDOW can put the cron over the
 *  plan's limit: 50 chapters plus the visit overhead is 56, over the free
 *  plan's 50, which is exactly the bug this replaces. */
export const refreshWindowFor = (env: Env): number => {
  const ceiling = Math.max(1, budgetFor(env) - REFRESH_VISIT_COST);
  return positiveInt(env.NOVEL_REFRESH_WINDOW, ceiling, ceiling);
};

/** Series visits one tick may make at this window. The window alone does not
 *  bound the invocation: the cron walks every stale row inside one, so 20 rows
 *  at the full window is the whole share times twenty. Rows past this count are
 *  not even read — listStaleSeries returns the oldest first and a visited row
 *  has its updated_at bumped, so they come back next tick instead of being
 *  dropped. */
export const refreshVisitsFor = (env: Env): number =>
  Math.max(1, Math.floor(budgetFor(env) / (REFRESH_VISIT_COST + refreshWindowFor(env))));

// Long enough that a series which is not being read still advances across a few
// daily crons, short enough that a cursor left by a deleted series ages out.
const CURSOR_TTL_SEC = 30 * 86400;

const cursorKey = (seriesId: string): string => `novel:refresh:${seriesId}`;

export interface RefreshOutcome {
  /** Chapter bodies written this visit. */
  fetched: number;
  /** Upstream answered, but with nothing usable. */
  missing: number;
  /** The Worker ran out of subrequests or CPU: the window stopped early and the
   *  next visit must resume. Never conflated with `missing` — a budget stop
   *  means "not reached", not "not there". */
  budget: number;
  /** The chapter list ended inside the window, so this visit saw the whole series. */
  exhausted: boolean;
  /** Where the next visit resumes, or null when there is nothing left. */
  nextOffset: number | null;
}

const NO_WORK: RefreshOutcome = { fetched: 0, missing: 0, budget: 0, exhausted: true, nextOffset: null };

// Worker budget exhaustion and aborted fetches both surface as a throw, and
// neither means the chapter is missing.
const isBudgetAbort = (e: unknown): boolean => {
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = String((e as { message?: string } | null)?.message ?? e).toLowerCase();
  return name === 'AbortError' || name === 'TimeoutError'
    || msg.includes('too many subrequests')
    || msg.includes('subrequest limit')
    || msg.includes('cpu time')
    || msg.includes('duration limit');
};

const readCursor = async (env: Env, seriesId: string): Promise<number> => {
  const raw = await env.CACHE_KV.get(cursorKey(seriesId), { type: 'json' }).catch(() => null) as { offset?: unknown } | null;
  const n = Number(raw?.offset);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

const writeCursor = async (env: Env, seriesId: string, offset: number | null): Promise<void> => {
  const key = cursorKey(seriesId);
  const done = offset === null
    ? env.CACHE_KV.delete(key)
    : env.CACHE_KV.put(key, JSON.stringify({ offset }), { expirationTtl: CURSOR_TTL_SEC });
  await done.catch(() => {});
};

export const refreshSeries = async (
  env: Env,
  series: NovelSeriesRow,
  adapter: NovelSourceAdapter,
  opts: { offset?: number; window?: number } = {}
): Promise<RefreshOutcome> => {
  const fetchContent = adapter.getChapterContent;
  if (typeof fetchContent !== 'function') return { ...NO_WORK };

  const limit = Math.max(1, Math.floor(opts.window ?? refreshWindowFor(env)));
  const offset = opts.offset === undefined
    ? await readCursor(env, series.id)
    : Math.max(0, Math.floor(opts.offset));

  const summaries = await upstream(
    () => adapter.listChapters(series.source_series_id, { limit, offset })
  );
  const window = summaries ?? [];

  const rows: NovelChapterRow[] = [];
  let missing = 0;
  let budget = 0;
  let index = 0;
  for (; index < window.length; index++) {
    const summary = window[index];
    let fetched: { html: string } | undefined;
    try {
      fetched = await upstream(() => fetchContent.call(adapter, summary.sourceChapterId));
    } catch (e) {
      if (isBudgetAbort(e)) {
        budget++;
        break;
      }
      console.error(`[novel] chapter fetch failed for ${summary.sourceChapterId}: ${e}`);
      missing++;
      continue;
    }
    const content = fetched?.html;
    if (typeof content !== 'string' || isBlank(content)) {
      console.error(`[novel] no chapter body for ${summary.sourceChapterId} — skipped`);
      missing++;
      continue;
    }
    rows.push({
      id: `${series.id}:${summary.sourceChapterId}`,
      series_id: series.id,
      source_chapter_id: summary.sourceChapterId,
      number: summary.number,
      title: summary.title ?? null,
      content,
      content_hash: await sha256Hex(content),
      source_url: summary.sourceUrl ?? null,
      scraped_at: nowSec(),
    });
  }

  // A short window means upstream's list ended inside it. A budget stop leaves
  // the window unfinished, so the cursor points at the chapter that was never
  // fetched and that chapter is retried, not skipped past.
  const exhausted = budget === 0 && window.length < limit;
  const nextOffset = exhausted ? null : offset + index;
  await writeCursor(env, series.id, nextOffset);

  console.log(
    `[novel] ${series.id}: ${rows.length} chapters written, ${missing} missing, ${budget} budget-stopped`
    + (nextOffset === null ? ' (series complete)' : ` (truncated, resume at ${nextOffset})`)
  );

  // The touch runs even when the window yielded nothing, and that is the whole
  // fix. listStaleSeries exempts a chapterless row from the age test only while
  // updated_at still equals created_at, so a visit that advanced nothing would
  // leave the row looking never-visited: still exempt, still returned, a full
  // refresh budget per hour against a series whose chapters cannot be fetched at
  // all, for as long as the row lives. One visit is all the exemption is for.
  //
  // Order matters. The touch follows the write, so a failed upsert propagates
  // and the row keeps its exemption — it stays "never visited" and is retried on
  // the next tick rather than being marked visited with nothing stored.
  if (rows.length > 0) await novelDb(env.DB).upsertChapters(series.id, rows);
  await env.DB
    .prepare('UPDATE novel_series SET updated_at = ?1 WHERE id = ?2')
    .bind(nowSec(), series.id)
    .run();
  return { fetched: rows.length, missing, budget, exhausted, nextOffset };
};

export interface RefreshPassResult {
  /** Rows visited, whether or not the visit completed. */
  refreshed: number;
  /** Visits that saw the whole chapter list. */
  complete: number;
  /** Visits that stopped at the window and left a cursor. */
  truncated: number;
  missing: number;
  budget: number;
}

/**
 * Cron entry point. `resolve` is the adapter lookup so a test can drive it
 * without a network; production leaves it as the real registry.
 */
export const refreshStaleSeries = async (
  env: Env,
  olderThanSec: number,
  limit: number,
  resolve: (key: string) => NovelSourceAdapter | null = (key) => getNovelAdapter(key, novelAdapterEnv(env))
): Promise<RefreshPassResult> => {
  const visits = Math.max(1, Math.min(limit, refreshVisitsFor(env)));
  const rows = await novelDb(env.DB).listStaleSeries(olderThanSec, visits);
  const pass: RefreshPassResult = { refreshed: 0, complete: 0, truncated: 0, missing: 0, budget: 0 };
  for (const row of rows) {
    const adapter = resolve(row.source);
    if (!adapter) {
      console.error(`[novel] no adapter for source ${row.source} (${row.id}) — skipped`);
      continue;
    }
    try {
      const outcome = await refreshSeries(env, row, adapter);
      pass.refreshed++;
      pass.complete += outcome.exhausted ? 1 : 0;
      pass.truncated += outcome.exhausted ? 0 : 1;
      pass.missing += outcome.missing;
      pass.budget += outcome.budget;
    } catch (e) {
      console.error(`[novel] refresh failed for ${row.id}: ${e}`);
    }
  }
  return pass;
};

// The catalogue walk. One upstream listing page is 18 cards, and that is the
// step size, so an offset and a page number are the same walk in two units.
const CATALOG_PAGE = 18;
// A stop for a listing that never ends, not a target: novelid's walk closed at
// 11 pages / 181 series when this was measured (2026-09-27).
const CATALOG_MAX_PAGES = 40;

/** Where the walk resumes between passes. Long-lived because a pass is bounded
 *  by the subrequest budget, not by the end of the listing. */
const CATALOG_CURSOR_KEY = 'novel:catalog:cursor';
const CATALOG_CURSOR_TTL_SEC = 30 * 86400;

/**
 * Upstream requests one new series costs, counted the way REFRESH_VISIT_COST
 * counts a visit: the owner read (a read-forward to the shard that holds the
 * row), the series page, the cover GET, the B2 PUT, and the write-forward. Three
 * was the first guess and it was 40% low, which let a pass run past the plan's
 * limit and get killed part-way — the exact silent-prefix failure the chapter
 * refresh window exists to prevent.
 */
const CATALOG_NEW_SERIES_COST = 5;

/** An existing row costs the owner read and nothing else unless it is still
 *  missing metadata, in which case the series page is fetched to fill it. */
const CATALOG_OWNER_READ_COST = 1;
const CATALOG_DETAIL_COST = 1;

export interface SyncCatalogResult {
  inserted: number;
  filled: number;
  skipped: number;
  /** Listing pages this pass fetched. */
  pages: number;
  /** Where the next pass resumes; 0 means the listing was walked to its end and
   *  the cursor was rewound, so the following pass starts over and picks up
   *  anything published since. */
  cursor: number;
  /** True when this pass reached the end of the listing. */
  complete: boolean;
}

const readCatalogCursor = async (env: Env): Promise<number> => {
  const raw = await env.CACHE_KV.get(CATALOG_CURSOR_KEY).catch(() => null);
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const writeCatalogCursor = async (env: Env, offset: number): Promise<void> => {
  const put = offset > 0
    ? env.CACHE_KV.put(CATALOG_CURSOR_KEY, String(offset), { expirationTtl: CATALOG_CURSOR_TTL_SEC })
    : env.CACHE_KV.delete(CATALOG_CURSOR_KEY);
  await put.catch(() => {});
};

/**
 * Whether the walk still has listing pages to reach. A missing cursor means the
 * walk either finished and rewound, or never started — the caller cannot tell
 * those apart from the key alone, and does not need to: both want a pass.
 */
export const isCatalogWalkComplete = async (env: Env): Promise<boolean> =>
  (await readCatalogCursor(env)) === 0;

/**
 * Where the discovery crawl runs. One worker, chosen by the same ring every
 * other shard decision uses, so exactly one of the four pays the upstream
 * requests the catalogue costs. The writes are fanned out by series owner
 * (see `writeOwned`), so the other three D1s still get their quarter.
 */
export const CATALOG_CRAWL_KEY = 'novel:catalog:crawl';

export const isCatalogCrawler = (env: Env): boolean => ownerFor(env, CATALOG_CRAWL_KEY).self;

/**
 * A novel_series write into the D1 that owns the row.
 *
 * `ownerKey` is the series id and is passed explicitly. The two statements bind
 * it at different positions — the upsert leads with it, the gap fill trails it
 * behind the patch values — so inferring it from `params[0]` routes a fill to
 * whichever shard owns hash(patchValue), the UPDATE matches no row there, and
 * the caller still counts the write.
 *
 * A local owner writes directly; a peer's owner is reached over
 * /api/_internal/db/exec, with the outbox as the retry path — the same
 * sharded-write shape reader.ts uses for chapter page LRU touches. `changes` is
 * the owner's own row count, so a caller that needs the write to have actually
 * matched a row can tell.
 */
const writeOwned = async (
  env: Env,
  ownerKey: string,
  sql: string,
  params: unknown[]
): Promise<{ ok: boolean; changes: number }> => {
  const owner = ownerFor(env, ownerKey);
  if (owner.self) {
    const stmt = env.DB.prepare(sql);
    const res = await (params.length > 0 ? stmt.bind(...params) : stmt).run().catch(() => null);
    if (res === null) return { ok: false, changes: 0 };
    return { ok: res.success, changes: res.meta?.changes ?? 0 };
  }
  const forwarded = await internalExecCounted(env, owner.url, { sql, params, table: 'novel_series' }).catch(() => null);
  if (forwarded?.ok) return forwarded;
  // A failed forward is not a failed write: the outbox is the retry path, so the
  // row is expected to land even though no owner has confirmed a row count.
  return enqueueOutbox(env, owner.url, 'novel_series', sql, params).then((ok) => ({ ok, changes: ok ? 1 : 0 }));
};

export const UPSERT_SERIES_SQL =
  'INSERT INTO novel_series (id, source_series_id, source, title, author, genre, status, cover_ref, cover_fallback, synopsis, created_at, updated_at)'
  + ' VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)'
  + ' ON CONFLICT(source, source_series_id) DO UPDATE SET'
  + ' title = excluded.title,'
  // Same discipline as fillSeriesGaps: the search card carries no synopsis and a
  // failed getSeries carries no author or status, so an unguarded upsert writes
  // those nulls over whatever tier-2 filled. The pre-INSERT owner read is the
  // first line of defence; this is the one that holds when that read fails.
  + ' author = COALESCE(NULLIF(excluded.author, \'\'), novel_series.author),'
  + ' genre = COALESCE(NULLIF(excluded.genre, \'\'), novel_series.genre),'
  + ' status = COALESCE(NULLIF(excluded.status, \'\'), novel_series.status),'
  + ' cover_ref = COALESCE(NULLIF(excluded.cover_ref, \'\'), novel_series.cover_ref),'
  + ' cover_fallback = COALESCE(NULLIF(excluded.cover_fallback, \'\'), novel_series.cover_fallback),'
  + ' synopsis = COALESCE(NULLIF(excluded.synopsis, \'\'), novel_series.synopsis),'
  + ' updated_at = excluded.updated_at';

export const FILL_GAPS_SQL = (cols: DetailColumn[]): string =>
  `UPDATE novel_series SET ${cols.map((c, i) => `${c} = COALESCE(NULLIF(${c}, ''), ?${i + 1})`).join(', ')}`
  + ` WHERE id = ?${cols.length + 1}`;

/** The tier-1 series page. Best-effort: a series whose detail page is down is
 *  still worth storing from the search card it was discovered on. */
const fetchDetail = async (
  adapter: NovelSourceAdapter,
  sourceSeriesId: string
): Promise<NovelSeries | undefined> => {
  try {
    return await upstream(() => adapter.getSeries(sourceSeriesId));
  } catch (e) {
    console.error(`[novel] getSeries failed for ${sourceSeriesId}: ${e}`);
    return undefined;
  }
};
/**
 * Discovers series and writes them, so the catalog is not born empty.
 *
 * Discovery only: `browse`, `getSeries` and `upsertSeries`, never
 * `getChapterContent` — a catalogue crawl that also fetched bodies would pull
 * thousands of chapter requests per run. The crawl is owner-gated (see
 * `isCatalogCrawler`) so one worker pays the upstream requests, and every row is
 * written into the D1 that owns it (see `writeOwned`), so the four D1s still
 * partition the catalogue instead of one holding all of it.
 *
 * Discovery walks the source's own listing rather than searching it. novelid's
 * `?s=` substring-matches *titles*, so the six genre words this used to seed
 * from returned 5 hits and 3 unique series out of a possible 216 requests: a
 * keyword search cannot find a novel no reader could already name. A chapter
 * source with no `browse` is logged and skipped, not silently under-discovered.
 *
 * One pass is bounded by the invocation's subrequest budget, not by the end of
 * the listing, so the walk carries a KV cursor between passes. The cursor is
 * rewound when the listing ends, which is what makes a full catalogue a
 * repeating property instead of a one-off.
 *
 * `getSeries` is what makes the rows worth rendering. A novelid listing card
 * carries only title and one genre, and no tier-2 source carries the same
 * novels, so without the series page every synced row kept a null author, a null
 * status and no synopsis for good. It is called once per row that is still
 * missing them, never on a row that is already complete.
 *
 * An existing row is only ever gap-filled, never re-upserted. A listing payload
 * carries no synopsis and a failed `getSeries` carries no author or status, so
 * re-syncing from one would wipe what tier-2 filled in. Two things hold that
 * line, and neither is trusted alone: the pre-INSERT read asks the owner, so a
 * row this shard does not own is still recognised as existing; and the upsert's
 * own conflict clause cannot write a null over a populated column, so the line
 * survives a read that failed.
 */
export const syncCatalog = async (
  env: Env,
  opts: {
    /** Upstream requests this pass may spend. Defaults to the crawl's own share
     *  of the invocation's plan — the chapter refresh runs in the same callback
     *  on the elected crawler and draws from the same 50. */
    budget?: number;
    resolve?: (key: string) => NovelSourceAdapter | null;
  } = {}
): Promise<SyncCatalogResult> => {
  // The registry takes (key, env?); resolving it bare meant env was undefined
  // and the adapter's robots.txt KV cache never engaged on this path.
  const resolve = opts.resolve ?? ((k: string) => getNovelAdapter(k, novelAdapterEnv(env)));
  const out: SyncCatalogResult = { inserted: 0, filled: 0, skipped: 0, pages: 0, cursor: 0, complete: false };
  const budget = Math.max(1, opts.budget ?? CATALOG_SUBREQUEST_BUDGET);
  let spent = 0;

  let offset = await readCatalogCursor(env);
  for (const key of NOVEL_SOURCES) {
    const adapter = resolve(key);
    // Only the chapter source can back a series we could ever read chapters for.
    if (!adapter || adapter.capability !== 'chapter') continue;
    if (typeof adapter.browse !== 'function') {
      console.error(`[novel] ${key} has no catalogue listing — skipped`);
      continue;
    }
    for (let page = 0; page < CATALOG_MAX_PAGES && spent < budget; page++) {
      let hits: NovelSeries[] = [];
      try {
        const browse = adapter.browse.bind(adapter);
        hits = await upstream(() => browse({ limit: CATALOG_PAGE, offset })) ?? [];
      } catch (e) {
        console.error(`[novel] catalog browse failed at offset ${offset} on ${key}: ${e}`);
        break;
      }
      spent++;
      out.pages++;
      // A short page is the end of the listing. A budget stop mid-page is not,
      // so the cursor stays on this page and the next pass re-walks it — the
      // rows it already wrote are recognised as existing and cost nothing.
      let pageDone = hits.length < CATALOG_PAGE;
      for (const hit of hits) {
        if (spent >= budget) {
          pageDone = false;
          break;
        }
        const id = seriesIdFor(key, hit.sourceSeriesId);
        if (isBlank(hit.title) || id.includes('/')) {
          console.error(`[novel] unusable catalog hit for ${id} — skipped`);
          out.skipped++;
          continue;
        }
        // Whether the row already exists is the owner's business, not this
        // shard's, so the read goes through novelDbFor — the local D1 when
        // this shard owns the row, the owner's read-forward when it does not.
        // Reading locally only made a peer-owned row look absent on every
        // tick, which sent the same series down the INSERT path forever: the
        // B2 cover was re-uploaded every 12 hours, and a failed getSeries
        // re-upserted the listing card's nulls over tier-2's fills.
        const existing = await novelDbFor(env, id).getSeriesBySlug(id);
        spent += CATALOG_OWNER_READ_COST;
        if (existing) {
          // The listing card is the weaker source, so it only fills what the
          // series page did not supply — and only the columns the owner still
          // has blank, so a complete row costs no write at all.
          const detail = needsDetail(existing) ? await fetchDetail(adapter, existing.source_series_id) : null;
          spent += CATALOG_DETAIL_COST;
          const patch: Partial<Record<DetailColumn, string>> = {
            ...patchFrom(hit),
            ...patchFrom(detail),
          };
          const cols = (Object.keys(patch) as DetailColumn[]).filter((c) => patch[c] !== undefined && isBlank(existing[c]));
          if (
            cols.length > 0
            && (await writeOwned(env, id, FILL_GAPS_SQL(cols), [...cols.map((c) => patch[c] as string), id])).changes > 0
          ) {
            out.filled++;
          }
          continue;
        }
        const detail = await fetchDetail(adapter, hit.sourceSeriesId);
        // Same step as the detail fetch: the cover lives in B2 from here on, so
        // the reader never asks the source and availability stops depending on
        // novelid being up. cover_fallback stays as the pre-upload URL.
        const coverRef = await uploadNovelCover(env, id, detail?.coverUrl ?? hit.coverUrl);
        const now = nowSec();
        const written = await writeOwned(env, id, UPSERT_SERIES_SQL, [
          id,
          hit.sourceSeriesId,
          key,
          hit.title,
          detail?.author ?? hit.author ?? null,
          detail?.genres?.length ? JSON.stringify(detail.genres) : (hit.genres && hit.genres.length > 0 ? JSON.stringify(hit.genres) : null),
          detail?.status ?? hit.status ?? null,
          coverRef,
          // cover_fallback is the upstream URL the reader falls back to when
          // there is no stored object (no B2 account, or the upload failed).
          detail?.coverUrl ?? hit.coverUrl ?? null,
          detail?.synopsis ?? hit.synopsis ?? null,
          now,
          now,
        ]);
        spent += CATALOG_NEW_SERIES_COST;
        if (written.ok) out.inserted++;
        else out.skipped++;
      }
      offset += CATALOG_PAGE;
      if (pageDone) {
        out.complete = true;
        break;
      }
    }
    if (out.complete) break;
  }

  // Reaching the end rewinds rather than parks: a re-walk of a full catalogue
  // costs one subrequest per listing page and no detail fetch, because every row
  // is already complete, which is how a newly published novel is noticed.
  out.cursor = out.complete ? 0 : offset;
  await writeCatalogCursor(env, out.cursor);
  console.log(
    `[novel] catalog pass: ${out.pages} listing pages, ${out.inserted} new, ${out.filled} gap-filled,`
    + ` ${out.skipped} skipped, ${spent}/${budget} subrequests${out.complete ? ', listing complete' : ''}`
  );
  return out;
};
