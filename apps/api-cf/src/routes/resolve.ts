import { Hono } from 'hono';
import { getDb } from '../lib/context';
import type { Env, Context } from '../lib/context';
import { readThroughCache } from '../lib/readThroughCache';
import { peerKvGet } from '../lib/peers';
import { pickRecommendedSource, enrichChapterCounts, type SourceLinkRow } from './reader.ts';

export const VALID_TYPES = new Set(['manga', 'manhwa', 'manhua']);

export interface ResolveResult {
  slug: string;
  type: string;
  source: string;
  sourceSlug: string;
  recommendedSource: string | null;
  sources: Array<{ source: string; sourceSlug: string; hasChapterList: boolean; chapterCount: number }>;
}

export const buildResolveResponse = (
  seriesRow: { slug: string; type: string; source: string } | null | undefined,
  linkRows: Array<{ source: string; source_slug: string; has_chapter_list: number; chapter_count: number; last_scraped_at: number | null }>
): ResolveResult | null => {
  if (!seriesRow) return null;
  const links: SourceLinkRow[] = linkRows.map((l) => ({
    source: l.source,
    sourceSlug: l.source_slug,
    hasChapterList: l.has_chapter_list === 1,
    chapterCount: l.chapter_count,
    lastScrapedAt: l.last_scraped_at ?? null,
  }));
  // Self-link untuk seriesRow.source selalu ada tepat satu: pakai sourceSlug
  // dari D1 bila ada, else slug kanonik. Dedupe duplikat bila data kotor.
  const selfIdx = links.findIndex((l) => l.source === seriesRow.source);
  const sourceSlug = selfIdx >= 0 ? links[selfIdx].sourceSlug : seriesRow.slug;
  if (selfIdx === -1) {
    links.push({ source: seriesRow.source, sourceSlug, hasChapterList: true, chapterCount: 0, lastScrapedAt: null });
  } else {
    for (let i = links.length - 1; i > selfIdx; i--) {
      if (links[i].source === seriesRow.source) links.splice(i, 1);
    }
  }
  return {
    slug: seriesRow.slug,
    type: VALID_TYPES.has(seriesRow.type) ? seriesRow.type : 'manga',
    source: seriesRow.source,
    sourceSlug,
    recommendedSource: pickRecommendedSource(links),
    sources: links.map((l) => ({ source: l.source, sourceSlug: l.sourceSlug, hasChapterList: l.hasChapterList, chapterCount: l.chapterCount })),
  };
};

export const router = new Hono<{ Bindings: Env }>();

router.get('/resolve/:slug', async (c: Context) => {
  const { slug } = c.req.param();
  const cacheKey = `resolve:${slug}`;
  try {
    const result = await readThroughCache<{ data: ResolveResult }>(
      c,
      cacheKey,
      async () => {
        const row = await c.env.DB.prepare(
          'SELECT slug, type, source FROM series WHERE slug = ?1 LIMIT 1'
        ).bind(slug).first<{ slug: string; type: string; source: string }>();
        if (!row) throw new Error('not found');
        const mangaIdRow = await c.env.DB.prepare(
          'SELECT id FROM series WHERE slug = ?1 LIMIT 1'
        ).bind(slug).first<{ id: number }>();
        const linkRows = mangaIdRow
          ? await getDb(c).getSourceLinksByManga(mangaIdRow.id).catch(() => [])
          : [];
        const data = buildResolveResponse(row, linkRows);
        if (!data) throw new Error('not found');
        // Enrich jalan di background — tidak pernah block response (spec §3).
        c.executionCtx.waitUntil((async () => {
          try {
            if (mangaIdRow) await enrichChapterCounts(c, mangaIdRow.id, `sources:${data.source}:${data.sourceSlug}`);
          } catch { /* best-effort */ }
        })());
        return { data };
      },
      { circuitKey: 'reader:resolve', peerFallback: async () => {
        const v = await peerKvGet(c.env, cacheKey);
        return v as { data: ResolveResult } | null;
      } }
    );
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return c.json(result.data);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});
