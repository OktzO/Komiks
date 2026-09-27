import { Hono } from 'hono';
import type { NovelSeriesRow } from '@manga-platform/db';
import { NOVEL_SOURCES, getNovelAdapter } from '@manga-platform/sources/novel';
import type { NovelSourceAdapter } from '@manga-platform/sources/novel';
import { Env, json } from '../lib/context';
import type { Context } from '../lib/context';
import { ownerFor } from '../lib/peers';
import { fillMetadataGaps, hasMetadataGap, novelAdapterEnv, refreshSeries } from '../lib/novelIngest';
import { novelDbFor, novelDbOn, peerUrls } from '../lib/novelShard';

export const router = new Hono<{ Bindings: Env }>();

const MAX_LIMIT = 50;
// ponytail: a shard list is read per page and the db layer clamps any window to
// 100, so the merged catalogue is only complete to ~4x100 rows. Raise the window
// (with a keyset cursor instead of OFFSET) when the library outgrows that.
const MERGE_WINDOW = 100;
const STALE_SEC = 86400;
// ponytail: the detail payload embeds only the first page of summaries. Raise
// DETAIL_CHAPTERS, or drop the field and make the web client page
// /novel/series/:slug/chapters, once real series turn out to have chapter lists
// the reader must page through.
const DETAIL_CHAPTERS = 50;

const metadataAdapters = (env: Env): NovelSourceAdapter[] =>
  NOVEL_SOURCES
    .map((key) => getNovelAdapter(key, novelAdapterEnv(env)))
    .filter((a): a is NovelSourceAdapter => a !== null && a.capability === 'metadata');

/**
 * A slug that decoded to a path separator names a different series than the one
 * the shard was hashed from, so the lookup would quietly miss — 404 instead.
 * The composite `source_chapter_id` does contain a slash and is bound whole, so
 * only the series slug is checked.
 */
const isPlainSlug = (slug: string | undefined): slug is string =>
  typeof slug === 'string' && slug.length > 0 && !slug.includes('/');

const pageOf = (raw: string | undefined, fallback: number): number =>
  Math.max(1, Math.floor(Number(raw) || fallback));

const limitOf = (raw: string | undefined): number =>
  Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(raw) || MAX_LIMIT)));

const readThrough = async <T>(
  c: Context,
  cacheKey: string,
  ttl: number,
  read: () => Promise<T>
): Promise<T> => {
  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' }).catch(() => null);
  if (cached != null) return cached as T;
  const fresh = await read();
  // A miss is not cached: it is usually a series that has not been ingested yet.
  if (fresh !== null) {
    c.executionCtx.waitUntil(
      c.env.CACHE_KV.put(cacheKey, JSON.stringify(fresh), { expirationTtl: ttl }).catch(() => {})
    );
  }
  return fresh;
};

// listSeries already orders by updated_at DESC, id DESC; the merge has to restore
// that order because the shards answer independently.
const byNewest = (a: NovelSeriesRow, b: NovelSeriesRow): number =>
  b.updated_at - a.updated_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

router.get('/novel/catalog', async (c) => {
  const genre = c.req.query('genre') ?? undefined;
  const page = pageOf(c.req.query('page'), 1);
  const limit = limitOf(c.req.query('limit'));
  const offset = (page - 1) * limit;

  const payload = await readThrough(c, `novel:catalog:${genre ?? ''}:${page}:${limit}`, 600, async () => {
    // The catalogue shards by series, so it has no single owner: every shard's
    // window is merged here, otherwise a worker would list only its own quarter.
    const shards = ['', ...peerUrls(c.env)].map((url) => novelDbOn(c.env, url));
    const window = Math.min(MERGE_WINDOW, offset + limit);
    const [rows, counts] = await Promise.all([
      Promise.all(shards.map((db) => db.listSeries({ genre, limit: window, offset: 0 }))),
      Promise.all(shards.map((db) => db.countSeries(genre))),
    ]);
    const seen = new Set<string>();
    const merged = rows.flat().filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
    merged.sort(byNewest);
    return {
      data: merged.slice(offset, offset + limit),
      page,
      limit,
      total: counts.reduce((sum, n) => sum + n, 0),
    };
  });
  c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
  return json(c, payload);
});

router.get('/novel/series/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isPlainSlug(slug)) return json(c, { error: 'Series not found' }, 404);

  const data = await readThrough(c, `novel:series:${slug}`, 600, async () => {
    const novel = novelDbFor(c.env, slug);
    const series = await novel.getSeriesBySlug(slug);
    if (!series) return null;
    // Summaries, not rows: the embedded page is a navigation list, and shipping
    // 50 chapter bodies with it would be ~1MB nobody reads.
    return { ...series, chapters: await novel.listChapterSummaries(slug, { limit: DETAIL_CHAPTERS, offset: 0 }) };
  });
  if (!data) return json(c, { error: 'Series not found' }, 404);

  // Gap fill writes to the local D1, so only the owning shard may run it.
  if (ownerFor(c.env, slug).self && hasMetadataGap(data)) {
    c.executionCtx.waitUntil(
      fillMetadataGaps(c.env, data, metadataAdapters(c.env))
        .catch((e) => console.error(`[novel] metadata gap fill failed for ${slug}: ${e}`))
    );
  }
  c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
  return json(c, { data });
});

router.get('/novel/series/:slug/chapters', async (c) => {
  const slug = c.req.param('slug');
  if (!isPlainSlug(slug)) return json(c, { error: 'Series not found' }, 404);
  const page = pageOf(c.req.query('page'), 1);
  const limit = limitOf(c.req.query('limit'));
  const offset = (page - 1) * limit;

  const payload = await readThrough(c, `novel:chapters:${slug}:${page}:${limit}`, 600, async () => {
    const novel = novelDbFor(c.env, slug);
    const [data, total] = await Promise.all([
      novel.listChapterSummaries(slug, { limit, offset }),
      novel.countChapters(slug),
    ]);
    return { data, total };
  });
  c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
  return json(c, payload);
});

router.get('/novel/series/:slug/chapter/:chapterId', async (c) => {
  const slug = c.req.param('slug');
  if (!isPlainSlug(slug)) return json(c, { error: 'Series not found' }, 404);
  const chapterId = c.req.param('chapterId');

  const novel = novelDbFor(c.env, slug);
  const chapter = await novel.getChapter(slug, chapterId);
  if (!chapter) return json(c, { error: 'Chapter not found' }, 404);

  const data = {
    id: chapter.id,
    number: chapter.number,
    title: chapter.title,
    content: chapter.content,
    scraped_at: chapter.scraped_at,
  };

  // Never scraped inline: a stale body is served now and refreshed after the
  // response. Only the owning shard refreshes, and only into its own D1.
  if (Math.floor(Date.now() / 1000) - chapter.scraped_at >= STALE_SEC && ownerFor(c.env, slug).self) {
    c.executionCtx.waitUntil(
      (async () => {
        const series = await novel.getSeriesBySlug(slug);
        if (!series) return;
        const adapter = getNovelAdapter(series.source, novelAdapterEnv(c.env));
        if (adapter) await refreshSeries(c.env, series, adapter);
      })().catch((e) => console.error(`[novel] refresh failed for ${slug}/${chapterId}: ${e}`))
    );
  }

  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
  return json(c, { data });
});
