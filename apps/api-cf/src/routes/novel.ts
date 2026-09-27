import { Hono } from 'hono';
import { novelDb } from '@manga-platform/db';
import { NOVEL_SOURCES, getNovelAdapter } from '@manga-platform/sources/novel';
import type { NovelSourceAdapter } from '@manga-platform/sources/novel';
import { Env, json } from '../lib/context';
import type { Context } from '../lib/context';
import { ownerFor } from '../lib/peers';
import { fillMetadataGaps, hasMetadataGap, refreshSeries } from '../lib/novelIngest';

export const router = new Hono<{ Bindings: Env }>();

const MAX_LIMIT = 50;
const STALE_SEC = 86400;
// ponytail: the detail payload embeds only the first page. Raise it, or drop the
// field and make the web client page /novel/series/:slug/chapters, once real
// series turn out to have chapter lists the reader must page through.
const DETAIL_CHAPTERS = 50;

const novelOf = (c: Context) => novelDb(c.env.DB);

const metadataAdapters = (): NovelSourceAdapter[] =>
  NOVEL_SOURCES
    .map((key) => getNovelAdapter(key))
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

router.get('/novel/catalog', async (c) => {
  const genre = c.req.query('genre') ?? undefined;
  const page = pageOf(c.req.query('page'), 1);
  const limit = limitOf(c.req.query('limit'));
  const payload = await readThrough(
    c,
    `novel:catalog:${genre ?? ''}:${page}:${limit}`,
    600,
    async () => {
      const novel = novelOf(c);
      const [data, total] = await Promise.all([
        novel.listSeries({ genre, limit, offset: (page - 1) * limit }),
        novel.countSeries(genre),
      ]);
      return { data, page, limit, total };
    }
  );
  c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
  return json(c, payload);
});

router.get('/novel/series/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isPlainSlug(slug)) return json(c, { error: 'Series not found' }, 404);

  const data = await readThrough(c, `novel:series:${slug}`, 600, async () => {
    const novel = novelOf(c);
    const series = await novel.getSeriesBySlug(slug);
    if (!series) return null;
    return { ...series, chapters: await novel.listChapters(slug, { limit: DETAIL_CHAPTERS, offset: 0 }) };
  });
  if (!data) return json(c, { error: 'Series not found' }, 404);

  if (hasMetadataGap(data)) {
    c.executionCtx.waitUntil(
      fillMetadataGaps(c.env, data, metadataAdapters())
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

  const payload = await readThrough(c, `novel:chapters:${slug}:${page}:${limit}`, 600, async () => {
    const novel = novelOf(c);
    const [data, total] = await Promise.all([
      novel.listChapters(slug, { limit, offset: (page - 1) * limit }),
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

  const novel = novelOf(c);
  const chapter = await novel.getChapter(slug, chapterId);
  if (!chapter) return json(c, { error: 'Chapter not found' }, 404);

  const data = {
    id: chapter.id,
    number: chapter.number,
    title: chapter.title,
    content: chapter.content,
    scraped_at: chapter.scraped_at,
  };
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(`novel:chapter:${slug}:${chapterId}`, JSON.stringify(data), { expirationTtl: 300 })
      .catch(() => {})
  );

  // Never scraped inline: a stale body is served now and refreshed after the
  // response, and only by the shard that owns the series.
  if (Math.floor(Date.now() / 1000) - chapter.scraped_at >= STALE_SEC && ownerFor(c.env, slug).self) {
    c.executionCtx.waitUntil(
      (async () => {
        const series = await novel.getSeriesBySlug(slug);
        if (!series) return;
        const adapter = getNovelAdapter(series.source);
        if (adapter) await refreshSeries(c.env, series, adapter);
      })().catch((e) => console.error(`[novel] refresh failed for ${slug}/${chapterId}: ${e}`))
    );
  }

  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
  return json(c, { data });
});
