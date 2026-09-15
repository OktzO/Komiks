// Shinigami adapter (11.shinigami.asia via api.shngm.io).
// JSON API — no HTML scraping, no bot challenge. Endpoints:
//   GET /v1/manga/list?page=&page_size=&sort=latest|popularity&q=
//   GET /v1/manga/detail/{manga_id}
//   GET /v1/chapter/{manga_id}/list?page_size=3000
//   GET /v1/chapter/detail/{chapter_id}
// Caching strategy identical to other sources: reader routes wrap every call
// in readThroughCache (fresh 10min / stale 24h) + KV page-URL cache (10min) +
// B2 cache-aside for images. Nothing extra needed here.
import type { Series, Chapter } from '@manga-platform/shared';
import { sanitizeCoverUrl } from '@manga-platform/shared/http';
import { decodeHtmlEntities } from '@manga-platform/shared/entities';
import { SHINIGAMI_BASE, SHINIGAMI_API, fetchJson, fetchRobots, isPathAllowed } from './client.js';
import type { RobotsResult } from './client.js';

// ---- API DTOs ---------------------------------------------------------------

interface TaxItem { name: string; slug?: string }
interface ListItem {
  manga_id: string;
  title: string;
  alternative_title?: string | null;
  description?: string | null;
  cover_image_url?: string | null;
  cover_portrait_url?: string | null;
  status?: number;
  country_id?: string | null;
  release_year?: string | null;
  taxonomy?: Record<string, TaxItem[]>;
}

interface DetailData extends ListItem {
  id?: number;
}

interface ChapterItem {
  chapter_id: string;
  manga_id: string;
  chapter_title?: string | null;
  chapter_number: number;
  release_date?: string | null;
}

interface ChapterDetailData {
  chapter_id: string;
  manga_id: string;
  chapter_number: number;
  chapter_title?: string | null;
  base_url: string;
  chapter: { path: string; data: string[] };
}

// ---- helpers ----------------------------------------------------------------

const statusMap = (n?: number): Series['status'] => {
  if (n === 1) return 'ongoing';
  if (n === 2) return 'completed';
  if (n === 3) return 'hiatus';
  return 'unknown';
};

const typeFrom = (d: ListItem): Series['type'] => {
  const fmt = (d.taxonomy?.['Format']?.[0]?.name ?? '').toLowerCase();
  if (fmt.includes('manhwa') || d.country_id === 'KR') return 'manhwa';
  if (fmt.includes('manhua') || d.country_id === 'CN') return 'manhua';
  return 'manga';
};

const taxNames = (d: ListItem, key: string): string[] =>
  (d.taxonomy?.[key] ?? []).map((t) => decodeHtmlEntities(t.name) ?? '').filter(Boolean);

const toSeries = (d: ListItem): Series => {
  const title = decodeHtmlEntities(d.title) ?? d.title;
  const alt = d.alternative_title ? decodeHtmlEntities(d.alternative_title) ?? null : null;
  const synopsis = d.description ? decodeHtmlEntities(d.description) ?? null : null;
  const genres = taxNames(d, 'Genre');
  return {
    slug: d.manga_id,
    external_id: d.manga_id,
    source: 'shinigami',
    source_url: `${SHINIGAMI_BASE}/series/${d.manga_id}`,
    title,
    synopsis,
    cover_image: sanitizeCoverUrl(d.cover_image_url ?? d.cover_portrait_url ?? null),
    genres: genres.length > 0 ? genres : undefined,
    alt_titles: alt ? [alt] : undefined,
    type: typeFrom(d),
    status: statusMap(d.status),
    author: taxNames(d, 'Author').join(', ') || null,
    artist: taxNames(d, 'Artist').join(', ') || null,
    language: 'id',
  } as Series;
};

const toChapter = (c: ChapterItem, sourceId: string): Chapter => ({
  id: c.chapter_id,
  series_slug: sourceId,
  chapter_number: c.chapter_number ?? 0,
  title: c.chapter_title ? decodeHtmlEntities(c.chapter_title) ?? null : null,
  language: 'id',
  pages_count: 0,
  published_at: c.release_date ? new Date(c.release_date).getTime() : undefined,
});

export const shinigamiAdapter = () => {
  const listUrl = (params: Record<string, string>): string => {
    const qs = new URLSearchParams({ page: '1', page_size: '30', ...params });
    return `${SHINIGAMI_API}/v1/manga/list?${qs.toString()}`;
  };

  return {
    sourceKey: 'shinigami' as const,

    // Empty query → homepage listing (sort=latest). Non-empty → API search.
    async search({ q, limit = 20 }: { q: string; limit?: number; offset?: number }): Promise<Series[]> {
      const params: Record<string, string> = {};
      if (q.trim()) params.q = q.trim();
      else params.sort = 'latest';
      const data = await fetchJson<ListItem[]>(listUrl(params));
      return (data || []).slice(0, limit).map(toSeries);
    },

    async getSeries(sourceId: string): Promise<Series> {
      const data = await fetchJson<DetailData>(`${SHINIGAMI_API}/v1/manga/detail/${sourceId}`);
      if (!data?.manga_id) throw new Error(`shinigami getSeries: no manga for ${sourceId}`);
      return toSeries(data);
    },

    async listChapters(sourceId: string): Promise<Chapter[]> {
      const data = await fetchJson<ChapterItem[]>(`${SHINIGAMI_API}/v1/chapter/${sourceId}/list?page_size=3000`);
      return (data || []).map((c) => toChapter(c, sourceId));
    },

    async getSeriesDetail(sourceId: string, _opts?: { lang?: string }): Promise<{ series: Series; chapters: Chapter[] }> {
      const [detail, chapters] = await Promise.all([
        fetchJson<DetailData>(`${SHINIGAMI_API}/v1/manga/detail/${sourceId}`),
        fetchJson<ChapterItem[]>(`${SHINIGAMI_API}/v1/chapter/${sourceId}/list?page_size=3000`),
      ]);
      if (!detail?.manga_id) throw new Error(`shinigami getSeriesDetail: no manga for ${sourceId}`);
      return { series: toSeries(detail), chapters: (chapters || []).map((c) => toChapter(c, sourceId)) };
    },

    // Chapter detail endpoint carries chapter_number + title + pages in one
    // response. Reuse it here (route-level cache absorbs the double call).
    async getChapter(chapterSourceId: string): Promise<Chapter> {
      const d = await fetchJson<ChapterDetailData>(`${SHINIGAMI_API}/v1/chapter/detail/${chapterSourceId}`);
      return {
        id: chapterSourceId,
        series_slug: d?.manga_id ?? '',
        chapter_number: d?.chapter_number ?? 0,
        title: d?.chapter_title ? decodeHtmlEntities(d.chapter_title) ?? null : null,
        language: 'id',
        pages_count: d?.chapter?.data?.length ?? 0,
      };
    },

    async fetchPageUrls(chapterSourceId: string): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> {
      const d = await fetchJson<ChapterDetailData>(`${SHINIGAMI_API}/v1/chapter/detail/${chapterSourceId}`);
      if (!d?.chapter?.data?.length) throw new Error(`shinigami fetchPageUrls: no pages for ${chapterSourceId}`);
      const base = `${d.base_url}${d.chapter.path}`;
      return d.chapter.data.map((name) => ({
        url: `${base}${name}`,
        proxyHeaders: { Referer: SHINIGAMI_BASE + '/' },
      }));
    },

    async scrapeUrl(url: string): Promise<{ series: Series; chapters: Chapter[]; coverImageUrl: string | null }> {
      const match = url.match(/\/series\/([0-9a-f-]+)/i);
      if (!match) throw new Error(`shinigami scrapeUrl: cannot parse manga id from ${url}`);
      const sourceId = match[1];
      const { series, chapters } = await this.getSeriesDetail(sourceId);
      return { series, chapters, coverImageUrl: series.cover_image ?? null };
    },

    async checkRobots(url: string): Promise<RobotsResult> {
      const robots = await fetchRobots(null);
      const urlPath = new URL(url).pathname;
      if (!isPathAllowed(robots, urlPath)) return { ...robots, allowed: false };
      return robots;
    },

    async healthCheck(): Promise<{ healthy: boolean; latency_ms: number; error?: string }> {
      const start = Date.now();
      try {
        const data = await fetchJson<unknown>(`${SHINIGAMI_API}/v1/manga/list?page=1&page_size=1`, 5000);
        return { healthy: data != null, latency_ms: Date.now() - start };
      } catch (e) {
        return { healthy: false, latency_ms: Date.now() - start, error: String(e) };
      }
    },

    // Fixture helpers — used by unit tests only (no network).
    getSeriesFromFixtureForTest(d: ListItem): Series { return toSeries(d); },
    listChaptersFromFixtureForTest(d: ChapterItem[], sourceId: string): Chapter[] { return d.map((c) => toChapter(c, sourceId)); },
    fetchPageUrlsFromFixtureForTest(d: ChapterDetailData): { url: string; proxyHeaders?: Record<string, string> }[] {
      const base = `${d.base_url}${d.chapter.path}`;
      return d.chapter.data.map((name) => ({
        url: `${base}${name}`,
        proxyHeaders: { Referer: SHINIGAMI_BASE + '/' },
      }));
    },
  };
};
