import { novelDb } from '@manga-platform/db';
import type { NovelChapterRow, NovelSeriesRow } from '@manga-platform/db';
import { NOVEL_SOURCES, getNovelAdapter } from '@manga-platform/sources/novel';
import type { NovelAdapterEnv, NovelSeries, NovelSourceAdapter } from '@manga-platform/sources/novel';
import type { Env } from './context';
import { sha256Hex } from './context';
import { internalExec, ownerFor } from './peers';
import { enqueueOutbox } from './dbWrite';
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
 *  tier-2 source has. */
type DetailColumn = GapColumn | 'status';

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
 * identical prefix. 50 is the cap the plan's Review Focus #5 set.
 *
 * `source_chapter_id` aside, a chapter whose body comes back empty or missing is
 * dropped: an empty write would replace stored prose with nothing and the
 * `content_hash` guard would happily record the change.
 */
export const REFRESH_WINDOW = 50;
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

  const limit = Math.max(1, Math.floor(opts.window ?? REFRESH_WINDOW));
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

  if (rows.length === 0) return { fetched: 0, missing, budget, exhausted, nextOffset };

  await novelDb(env.DB).upsertChapters(series.id, rows);
  // listStaleSeries orders by updated_at, so a refresh that never touches the
  // series row would hand back the same N rows every hour forever.
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
  const rows = await novelDb(env.DB).listStaleSeries(olderThanSec, limit);
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

// Search terms the catalog is seeded from. The novel adapter contract has no
// "list everything" call, and novelid's search is a keyword endpoint that
// returns nothing for an empty query, so a catalogue has to be harvested through
// queries. These are genre words, which is also what the catalog's genre filter
// offers, so a synced series is reachable from the browse UI.
// ponytail: six hardcoded terms is a floor, not a strategy — the listing is one
// page per term and the source's own ranking decides what surfaces. Replace with
// a KV-held term list once the admin UI needs to steer discovery.
const CATALOG_SEEDS = ['romance', 'fantasy', 'isekai', 'slice of life', 'misteri', 'fantasi'];
// novelid serves fixed 18-card search pages, so stepping by 18 is what advances
// the upstream page.
const SEARCH_PAGE = 18;
const SEARCH_PAGES_PER_SEED = 2;

export interface SyncCatalogResult {
  inserted: number;
  filled: number;
  skipped: number;
}

/**
 * Where the discovery crawl runs. One worker, chosen by the same ring every
 * other shard decision uses, so exactly one of the four pays the upstream
 * requests the catalogue costs. The writes are fanned out by series owner
 * (see `writeOwned`), so the other three D1s still get their quarter.
 */
export const CATALOG_CRAWL_KEY = 'novel:catalog:crawl';

export const isCatalogCrawler = (env: Env): boolean => ownerFor(env, CATALOG_CRAWL_KEY).self;

/** A novel_series write into the D1 that owns the row. A local owner writes
 *  directly; a peer's owner is reached over /api/_internal/db/exec, with the
 *  outbox as the retry path — the same sharded-write shape reader.ts uses for
 *  chapter page LRU touches. */
const writeOwned = async (env: Env, sql: string, params: unknown[]): Promise<boolean> => {
  const owner = ownerFor(env, String(params[0]));
  if (owner.self) {
    const stmt = env.DB.prepare(sql);
    const res = await (params.length > 0 ? stmt.bind(...params) : stmt).run().catch(() => null);
    return res === null ? false : res.success;
  }
  if (await internalExec(env, owner.url, { sql, params, table: 'novel_series' }).catch(() => false)) return true;
  // A failed forward is not a failed write: the outbox is the retry path.
  return enqueueOutbox(env, owner.url, 'novel_series', sql, params);
};

const UPSERT_SERIES_SQL =
  'INSERT INTO novel_series (id, source_series_id, source, title, author, genre, status, cover_ref, cover_fallback, synopsis, created_at, updated_at)'
  + ' VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)'
  + ' ON CONFLICT(source, source_series_id) DO UPDATE SET'
  + ' title = excluded.title, author = excluded.author, genre = excluded.genre, status = excluded.status,'
  + ' cover_ref = excluded.cover_ref, cover_fallback = excluded.cover_fallback, synopsis = excluded.synopsis,'
  + ' updated_at = excluded.updated_at';

const FILL_GAPS_SQL = (cols: DetailColumn[]): string =>
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
 * Discovery only: `search`, `getSeries` and `upsertSeries`, never
 * `getChapterContent` — a catalogue crawl that also fetched bodies would pull
 * thousands of chapter requests per run. The crawl is owner-gated (see
 * `isCatalogCrawler`) so one worker pays the upstream requests, and every row is
 * written into the D1 that owns it (see `writeOwned`), so the four D1s still
 * partition the catalogue instead of one holding all of it.
 *
 * `getSeries` is what makes the rows worth rendering. A novelid search card
 * carries only title, one genre and a 120x160 thumbnail, and no tier-2 source
 * carries the same novels, so without the series page every synced row kept a
 * null author, a null status and no synopsis for good. It is called once per row
 * that is still missing them, never on a row that is already complete.
 *
 * An existing row is only ever gap-filled, never re-upserted: `upsertSeries`
 * overwrites author/synopsis/cover_fallback on conflict, so re-syncing from a
 * search payload (which carries no synopsis) would wipe what tier-2 filled in.
 */
export const syncCatalog = async (
  env: Env,
  opts: {
    seeds?: string[];
    pagesPerSeed?: number;
    resolve?: (key: string) => NovelSourceAdapter | null;
  } = {}
): Promise<SyncCatalogResult> => {
  const seeds = opts.seeds ?? CATALOG_SEEDS;
  const pages = Math.max(1, opts.pagesPerSeed ?? SEARCH_PAGES_PER_SEED);
  const resolve = opts.resolve ?? getNovelAdapter;
  const out: SyncCatalogResult = { inserted: 0, filled: 0, skipped: 0 };

  for (const key of NOVEL_SOURCES) {
    const adapter = resolve(key);
    // Only the chapter source can back a series we could ever read chapters for.
    if (!adapter || adapter.capability !== 'chapter') continue;
    for (const seed of seeds) {
      for (let page = 0; page < pages; page++) {
        let hits: NovelSeries[] = [];
        try {
          hits = await upstream(() => adapter.search({ q: seed, limit: SEARCH_PAGE, offset: page * SEARCH_PAGE })) ?? [];
        } catch (e) {
          console.error(`[novel] catalog search failed for "${seed}" on ${key}: ${e}`);
          break;
        }
        for (const hit of hits) {
          const id = seriesIdFor(key, hit.sourceSeriesId);
          if (isBlank(hit.title) || id.includes('/')) {
            console.error(`[novel] unusable catalog hit for "${seed}" (id ${id}) — skipped`);
            out.skipped++;
            continue;
          }
          const owner = ownerFor(env, id);
          // Whether the row already exists is the owner's business, not this
          // shard's: only the owner D1 can answer, so a forwarded write asks it.
          const existing = owner.self ? await novelDb(env.DB).getSeriesBySlug(id) : null;
          if (existing) {
            // The search card is the weaker source, so it only fills what the
            // series page did not supply.
            const patch: Partial<Record<DetailColumn, string>> = {
              ...patchFrom(hit),
              ...patchFrom(needsDetail(existing) ? await fetchDetail(adapter, existing.source_series_id) : null),
            };
            const cols = (Object.keys(patch) as DetailColumn[]).filter((c) => patch[c] !== undefined);
            if (cols.length > 0 && await writeOwned(env, FILL_GAPS_SQL(cols), [...cols.map((c) => patch[c] as string), id])) {
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
          const written = await writeOwned(env, UPSERT_SERIES_SQL, [
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
          if (written) out.inserted++;
          else out.skipped++;
        }
        if (hits.length < SEARCH_PAGE) break;
      }
    }
  }
  return out;
};
