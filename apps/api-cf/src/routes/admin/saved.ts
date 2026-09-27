import { Hono } from 'hono';
import type { Env, Context } from '../../lib/context';
import { json } from '../../lib/context';
import { requireAdminSession } from '../../lib/auth';
import { getPeers, internalQuery } from '../../lib/peers';

export const router = new Hono<{ Bindings: Env }>();

router.use('*', requireAdminSession);
router.use('*', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});

// D1 tiap shard = slice parsial (chapter_pages owner-sharded; series/
// manga_source_link/chapters tersebar per worker). Agregasi global = fetch
// raw rows dari self + semua peer, merge in-memory. Admin + low-traffic.

type CellBase = Record<string, unknown>;

const SELF_SQL = {
  pagesTotal: 'SELECT COUNT(*) AS c FROM chapter_pages',
  pagesByChapter: 'SELECT chapter_id, COUNT(*) AS c FROM chapter_pages GROUP BY chapter_id',
  chapters: 'SELECT id, series_slug, chapter_number, pages_count, created_at FROM chapters',
  series: 'SELECT id, slug, title, source FROM series',
  links: 'SELECT source, source_slug, chapter_count, last_scraped_at, manga_id FROM manga_source_link',
};

// GET /api/admin/saved — konten tersimpan lintas shard: judul/chapter/panel +
// storage. Response shape dipertahankan dari AdminSaved.tsx.
router.get('/saved', async (c: Context) => {
  const page = Math.min(Math.max(Number(c.req.query('page') ?? 1) || 1, 1), 1_000_000);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);

  const runSelf = async (sql: string): Promise<CellBase[]> => {
    const { results } = await c.env.DB.prepare(sql).all<CellBase>();
    return results ?? [];
  };
  const peers = getPeers(c.env).filter((p) => !p.self);
  const runPeer = async (sql: string, table: string): Promise<CellBase[]> => {
    const out: CellBase[] = [];
    for (const peer of peers) {
      const rows = await internalQuery<CellBase>(c.env, peer.url, sql, [], table).catch(() => null);
      if (rows) out.push(...rows);
    }
    return out;
  };

  const [selfRows, peerRows] = await Promise.all([
    Promise.all([runSelf(SELF_SQL.pagesTotal), runSelf(SELF_SQL.pagesByChapter), runSelf(SELF_SQL.chapters), runSelf(SELF_SQL.series), runSelf(SELF_SQL.links)]),
    Promise.all([
      runPeer(SELF_SQL.pagesTotal, 'chapter_pages'),
      runPeer(SELF_SQL.pagesByChapter, 'chapter_pages'),
      runPeer(SELF_SQL.chapters, 'chapters'),
      runPeer(SELF_SQL.series, 'series'),
      runPeer(SELF_SQL.links, 'manga_source_link'),
    ]),
  ]);
  const [pagesTotalS, pagesByChapterS, chaptersS, seriesS, linksS] = selfRows;
  const [pagesTotalP, pagesByChapterP, chaptersP, seriesP, linksP] = peerRows;

  // chapter_pages owner-sharded → tiap row unik di satu shard → SUM akurat.
  let pages_stored = 0;
  for (const r of [...pagesTotalS, ...pagesTotalP]) pages_stored += Number(r.c ?? 0);
  const pagesByChapter = new Map<string, number>();
  for (const r of [...pagesByChapterS, ...pagesByChapterP]) {
    const k = r.chapter_id as string;
    if (k) pagesByChapter.set(k, (pagesByChapter.get(k) ?? 0) + Number(r.c ?? 0));
  }

  // chapter id unik per source → id sama di shard beda = duplikat, dedupe by id.
  const chapters = new Map<string, { series_slug: string; chapter_number: number; pages_count: number; created_at: number }>();
  const seriesMap = new Map<string, { id: number; title: string; source: string }>();
  const links: CellBase[] = [...linksS, ...linksP];

  for (const r of [...chaptersS, ...chaptersP]) {
    const id = r.id as string;
    if (!id) continue;
    if (!chapters.has(id)) {
      chapters.set(id, {
        series_slug: (r.series_slug as string) ?? '',
        chapter_number: Number(r.chapter_number ?? 0),
        pages_count: Number(r.pages_count ?? 0),
        created_at: Number(r.created_at ?? 0),
      });
    }
  }
  for (const r of [...seriesS, ...seriesP]) {
    const slug = r.slug as string;
    if (!slug) continue;
    const prev = seriesMap.get(slug);
    if (!prev) seriesMap.set(slug, { id: Number(r.id ?? 0), title: (r.title as string) ?? '', source: (r.source as string) ?? '' });
  }
  const slugById = new Map<number, string>();
  for (const [slug, s] of seriesMap) if (s.id) slugById.set(s.id, slug);

  const linkBest = new Map<string, { source: string; chapter_count: number; last_scraped_at: number | null; mangaId: number }>();
  for (const r of links) {
    const source = r.source as string;
    const sourceSlug = r.source_slug as string;
    if (!source || !sourceSlug) continue;
    const key = `${source}:${sourceSlug}`;
    const cc = Number(r.chapter_count ?? 0);
    const last = r.last_scraped_at == null ? null : Number(r.last_scraped_at);
    const prev = linkBest.get(key);
    if (!prev || cc > prev.chapter_count) {
      linkBest.set(key, { source, chapter_count: cc, last_scraped_at: last, mangaId: Number(r.manga_id ?? 0) });
    }
  }

  const perSourceMap = new Map<string, { series: Set<string>; chapters: number; last_scraped_at: number }>();
  const mangaMax = new Map<number, { slug: string | null; chapter_count: number; last_scraped_at: number | null }>();
  for (const l of linkBest.values()) {
    const slug = slugById.get(l.mangaId) ?? null;
    const agg = perSourceMap.get(l.source) ?? { series: new Set<string>(), chapters: 0, last_scraped_at: 0 };
    if (slug) agg.series.add(slug);
    agg.chapters += l.chapter_count;
    if (l.last_scraped_at && l.last_scraped_at > agg.last_scraped_at) agg.last_scraped_at = l.last_scraped_at;
    perSourceMap.set(l.source, agg);
    const prev = mangaMax.get(l.mangaId);
    if (!prev || l.chapter_count > prev.chapter_count) {
      const old = prev?.last_scraped_at ?? 0;
      mangaMax.set(l.mangaId, { slug, chapter_count: l.chapter_count, last_scraped_at: Math.max(old, l.last_scraped_at ?? 0) || null });
    }
  }
  const per_source = [...perSourceMap.entries()]
    .map(([source, a]) => ({
      source,
      series: a.series.size,
      chapters: a.chapters,
      last_scraped_at: a.last_scraped_at > 0 ? a.last_scraped_at : null,
    }))
    .sort((a, b) => b.chapters - a.chapters);

  // Jumlah chapter hanya dari manga_source_link (pipeline chapters table masih
  // bertahap). chapter_count = max antar link → judul yang di-scrape dari 2
  // source (komiku+bacakomik) tidak double-count.
  const verses = [...mangaMax.values()].filter((m) => m.chapter_count > 0 && m.slug);
  const chapters_total = verses.reduce((a, m) => a + m.chapter_count, 0);
  const series_total = verses.length;

  const seriesRows = verses
    .map((m) => {
      const meta = m.slug ? seriesMap.get(m.slug) : null;
      return {
        slug: m.slug as string,
        title: meta?.title ?? (m.slug as string),
        source: meta?.source ?? '',
        chapter_count: m.chapter_count,
        last_scraped_at: m.last_scraped_at,
      };
    })
    .sort((a, b) => b.chapter_count - a.chapter_count || a.title.localeCompare(b.title));

  const chapterRows = [...chapters.entries()]
    .map(([id, ch]) => {
      const meta = seriesMap.get(ch.series_slug);
      return {
        chapter_id: id,
        series_slug: ch.series_slug,
        series_title: meta?.title ?? ch.series_slug,
        chapter_number: ch.chapter_number,
        pages_count: pagesByChapter.get(id) ?? ch.pages_count,
        created_at: ch.created_at,
      };
    })
    .sort((a, b) => b.created_at - a.created_at || (a.chapter_id < b.chapter_id ? -1 : 1))
    .slice((page - 1) * limit, page * limit);

  return json(c, {
    data: {
      summary: {
        series_total,
        chapters_total,
        pages_stored,
        per_source,
      },
      series: seriesRows,
      chapters: chapterRows,
      total: chapters.size,
      page,
      limit,
    },
  });
});