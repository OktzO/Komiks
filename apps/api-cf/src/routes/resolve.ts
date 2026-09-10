import { Hono } from 'hono';
import { getAdapter, type AdapterEnv } from '@manga-platform/sources';
import { getDb } from '../lib/context';
import type { Env, Context } from '../lib/context';
import { readThroughCache } from '../lib/readThroughCache';
import { peerKvGet } from '../lib/peers';
import { pickRecommendedSource, enrichChapterCounts, withBudget, SOURCE_WEIGHT, type SourceLinkRow } from './reader.ts';

// Urutan coba live-fallback: source berbobot tinggi dulu (slug human-readable
// di komiku/bacakomik/manhwaindo; thrive/shinigami slug = id internal sehingga
// lookup by slug sering gagal — tetap dicoba, tapi di belakang).
export const FALLBACK_SOURCE_ORDER = Object.entries(SOURCE_WEIGHT)
  .sort((a, b) => b[1] - a[1])
  .map(([s]) => s);

export const NEG_TTL = 300;

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

// Live-fallback saat slug belum ter-index di D1 (mis. judul baru dari homepage
// feed yang belum pernah dikunjungi): coba adapter per source by slug, lalu
// persist ke D1 di background supaya hit berikutnya = DB hit. Response tetap
// dibangun dari data live (type/slug valid), bukan menunggu write.
export const resolveLiveFallback = async (
  c: Context,
  slug: string,
): Promise<{ data: ResolveResult } | null> => {
  const attempts = FALLBACK_SOURCE_ORDER.map(async (source) => {
    const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
    if (!adapter) return null;
    try {
      const series = await adapter.getSeries(slug);
      return series ? { source, series } : null;
    } catch {
      return null;
    }
  });
  const hit = await withBudget(Promise.all(attempts).then((rs) => rs.find(Boolean) ?? null), 6000, null);
  if (!hit) return null;
  const { source, series } = hit;
  c.executionCtx.waitUntil((async () => {
    try {
      const db = getDb(c);
      await db.upsertSeries({
        slug,
        title: series.title,
        external_id: series.external_id ?? slug,
        source,
        synopsis: series.synopsis ?? null,
        type: series.type,
        status: series.status ?? 'ongoing',
        author: series.author ?? null,
        artist: series.artist ?? null,
        cover_image: series.cover_image ?? null,
        genres: series.genres,
        alt_titles: null,
        source_url: null,
        language: null,
      });
      const row = await c.env.DB.prepare('SELECT id FROM series WHERE slug = ?1 LIMIT 1').bind(slug).first<{ id: number }>();
      if (row) {
        await db.upsertSourceLink({
          mangaId: row.id,
          source,
          sourceSlug: slug,
          hasChapterList: 1,
          chapterCount: 0,
          lastScrapedAt: Math.floor(Date.now() / 1000),
        });
        c.executionCtx.waitUntil(
          withBudget(enrichChapterCounts(c, row.id, `sources:${source}:${slug}`), 4000, undefined).catch(() => {}),
        );
      }
    } catch { /* best-effort */ }
  })());
  return {
    data: buildResolveResponse(
      { slug, type: series.type, source },
      [{ source, source_slug: slug, has_chapter_list: 1, chapter_count: 0, last_scraped_at: null }],
    )!,
  };
};

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
        if (row) {
          const mangaIdRow = await c.env.DB.prepare(
            'SELECT id FROM series WHERE slug = ?1 LIMIT 1'
          ).bind(slug).first<{ id: number }>();
          const linkRows = mangaIdRow
            ? await getDb(c).getSourceLinksByManga(mangaIdRow.id).catch(() => [])
            : [];
          const data = buildResolveResponse(row, linkRows);
          if (data) {
            // Enrich jalan di background — tidak pernah block response (spec §3).
            c.executionCtx.waitUntil((async () => {
              try {
                if (mangaIdRow) await enrichChapterCounts(c, mangaIdRow.id, `sources:${data.source}:${data.sourceSlug}`);
              } catch { /* best-effort */ }
            })());
            return { data };
          }
        }
        // DB miss → live fallback (judul baru belum ter-index). Negative-cache
        // dulu supaya bot 404 massal tidak nge-hammer source upstream.
        const neg = await c.env.CACHE_KV.get(`resolve404:${slug}`).catch(() => null);
        if (neg) throw new Error('not found');
        const live = await resolveLiveFallback(c, slug);
        if (!live) {
          await c.env.CACHE_KV.put(`resolve404:${slug}`, '1', { expirationTtl: NEG_TTL }).catch(() => {});
          throw new Error('not found');
        }
        return live;
      },
      { circuitKey: 'reader:resolve', peerFallback: async () => {
        const v = await peerKvGet(c.env, `f:${cacheKey}`);
        return v as { data: ResolveResult } | null;
      } }
    );
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return c.json(result.data);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});
