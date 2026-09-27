import { novelDb } from '@manga-platform/db';
import type { NovelChapterRow, NovelSeriesRow } from '@manga-platform/db';
import { getNovelAdapter } from '@manga-platform/sources/novel';
import type { NovelSeries, NovelSourceAdapter } from '@manga-platform/sources/novel';
import type { Env } from './context';
import { sha256Hex } from './context';
import { retryUpstream } from './retry';

const nowSec = (): number => Math.floor(Date.now() / 1000);

const isBlank = (value: string | null | undefined): boolean =>
  typeof value !== 'string' || value.trim().length === 0;

// Adapters already retry upstream twice on their own, so the outer wrapper only
// needs to ride out a single blip — three attempts would triple cron CPU for a
// source outage that is already failing loudly.
const upstream = <T>(fn: () => Promise<T>): Promise<T> => retryUpstream(fn, 2);

const normTitle = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

type GapColumn = 'cover_fallback' | 'synopsis' | 'author';

/** A blank tier-1 column is the only thing tier-2 is allowed to fill. The
 *  cover is a gap only when neither cover_ref nor cover_fallback is set —
 *  fillSeriesGaps cannot populate cover_ref, so a second write would be a no-op
 *  round trip. */
const gapColumns = (series: NovelSeriesRow): GapColumn[] => {
  const cols: GapColumn[] = [];
  if (isBlank(series.cover_ref) && isBlank(series.cover_fallback)) cols.push('cover_fallback');
  if (isBlank(series.synopsis)) cols.push('synopsis');
  if (isBlank(series.author)) cols.push('author');
  return cols;
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
};

/**
 * Re-scrapes one series' chapter bodies. `source_chapter_id` is the upstream id
 * verbatim — novelid's is the composite "{slug}/{bab}" and its fetcher rejects
 * anything else, so it is never split or renumbered.
 *
 * A chapter whose body comes back empty or missing is dropped: an empty write
 * would replace stored prose with nothing and the `content_hash` guard would
 * happily record the change.
 */
export const refreshSeries = async (
  env: Env,
  series: NovelSeriesRow,
  adapter: NovelSourceAdapter
): Promise<void> => {
  const fetchContent = adapter.getChapterContent;
  if (typeof fetchContent !== 'function') return;

  const summaries = await upstream(() => adapter.listChapters(series.source_series_id));
  const rows: NovelChapterRow[] = [];
  for (const summary of summaries ?? []) {
    let fetched: { html: string } | undefined;
    try {
      fetched = await upstream(() => fetchContent.call(adapter, summary.sourceChapterId));
    } catch (e) {
      console.error(`[novel] chapter fetch failed for ${summary.sourceChapterId}: ${e}`);
      continue;
    }
    const content = fetched?.html;
    if (typeof content !== 'string' || isBlank(content)) {
      console.error(`[novel] no chapter body for ${summary.sourceChapterId} — skipped`);
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
  if (rows.length === 0) return;

  await novelDb(env.DB).upsertChapters(series.id, rows);
  // listStaleSeries orders by updated_at, so a refresh that never touches the
  // series row would hand back the same N rows every hour forever.
  await env.DB
    .prepare('UPDATE novel_series SET updated_at = ?1 WHERE id = ?2')
    .bind(nowSec(), series.id)
    .run();
};

/**
 * Cron entry point. `resolve` is the adapter lookup so a test can drive it
 * without a network; production leaves it as the real registry.
 */
export const refreshStaleSeries = async (
  env: Env,
  olderThanSec: number,
  limit: number,
  resolve: (key: string) => NovelSourceAdapter | null = getNovelAdapter
): Promise<number> => {
  const rows = await novelDb(env.DB).listStaleSeries(olderThanSec, limit);
  let refreshed = 0;
  for (const row of rows) {
    const adapter = resolve(row.source);
    if (!adapter) {
      console.error(`[novel] no adapter for source ${row.source} (${row.id}) — skipped`);
      continue;
    }
    try {
      await refreshSeries(env, row, adapter);
      refreshed++;
    } catch (e) {
      console.error(`[novel] refresh failed for ${row.id}: ${e}`);
    }
  }
  return refreshed;
};
