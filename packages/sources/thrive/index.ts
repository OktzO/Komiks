/// <reference lib="dom" />
// Thrive.moe adapter. Next.js SSG site — all data lives in `__NEXT_DATA__`.
// No API key, no bot challenge, server-rendered HTML (UA header suffices).
// Backs content from MangaDex UUIDs but we scrape Thrive's own HTML, never
// the MangaDex API.
import type { Series, Chapter } from '@manga-platform/shared';
import { drainResponse, sanitizeCoverUrl } from '@manga-platform/shared/http';
import { decodeHtmlEntities } from '@manga-platform/shared/entities';
import { mapStatusText } from '@manga-platform/shared/status';
import { THRIVE_BASE, fetchHtml, parseNextData, fetchRobots, isPathAllowed } from './client.js';
import type { RobotsResult } from './client.js';

export interface ThriveAdapterEnv {
  MY_BROWSER?: Fetcher;
}

interface ThriveDetail {
  id: string;
  title: string;
  alt_title?: string;
  desc_id?: string;
  desc_ID?: string;
  desc?: Record<string, string>;
  image?: string;
  status?: string;
  demographic?: string;
  language?: string;
  author?: string[];
  artist?: string[];
  tags?: string[];
  chapterlist?: ThriveChapter[];
}

interface ThriveChapter {
  chapter_id: string;
  chapter_number?: string;
  chapter_title?: string | null;
  created_at?: string;
  scanlator?: string | null;
}

interface ThriveChapterPage {
  manga_id?: string;
  title?: string;
  id: string;
  prefix?: string;
  image?: string[];
}

const toSeries = (d: ThriveDetail): Series => {
  const synopsis = decodeHtmlEntities((d.desc_ID || d.desc?.id || '').trim()) ?? null;
  // Type: no explicit manga/manhwa/manhua field. Best-effort from tags;
  // default 'manga'. Part 3 refines via D1 aggregation.
  const g = (d.tags || []).join(' ').toLowerCase();
  const type = (g.includes('manhua') ? 'manhua' : g.includes('manhwa') ? 'manhwa' : 'manga') as 'manga' | 'manhwa' | 'manhua';
  const status = mapStatusText(d.status);
  return {
    slug: d.id,
    external_id: d.id,
    source: 'thrive',
    source_url: `${THRIVE_BASE}/title/${d.id}/`,
    title: decodeHtmlEntities(d.title) ?? d.title,
    synopsis,
    cover_image: sanitizeCoverUrl(d.image ?? null),
    genres: (d.tags && d.tags.length > 0) ? d.tags : undefined,
    type,
    status,
    author: d.author?.[0] ?? null,
    language: d.language ?? 'ja',
  } as Series;
};

export const thriveAdapter = (env?: ThriveAdapterEnv) => {
  // Local function (NOT a `this._fetchDetail` method): survives detached
  // invocation (`const d = adapter.getSeriesDetail; d()`), which would
  // otherwise drop `this` → TypeError → recorded as healthCheck failure.
  const fetchDetail = async (sourceId: string): Promise<ThriveDetail | null> => {
    const html = await fetchHtml(`${THRIVE_BASE}/title/${sourceId}/`);
    return parseNextData<ThriveDetail>(html);
  };

  return {
    sourceKey: 'thrive' as const,

    // Thrive has no server-side search (`?route=` is client-only SSG-ignored).
    // Empty query → homepage listing (Update Terbaru cards). Non-empty →
    // build an index from genre pages, then match titles locally.
    async search({ q, limit = 20 }: { q: string; limit?: number; offset?: number }): Promise<Series[]> {
      const query = q.trim().toLowerCase();
      if (!query) {
        const html = await fetchHtml(`${THRIVE_BASE}/`, 10000);
        const items: Series[] = [];
        const seen = new Set<string>();
        // Homepage carousel cards: <a href="/title/<uuid>">...<img src="cdn...">...
        // <div class="line-clamp-2 ...">Title</div>. Match img + title in one pass.
        for (const m of html.matchAll(/href="\/title\/([0-9a-f-]{36})"[^>]*>[\s\S]*?<img[^>]*src="(https:\/\/cdn\.thrive\.moe\/covers\/[^"]+)"[\s\S]*?<div[^>]*class="[^"]*line-clamp-2[^"]*"[^>]*>([^<]+)<\/div>/g)) {
          const id = m[1];
          if (seen.has(id)) continue;
          seen.add(id);
          const title = m[3].trim();
          items.push({
            slug: id,
            external_id: id,
            source: 'thrive',
            source_url: `${THRIVE_BASE}/title/${id}/`,
            title,
            cover_image: m[2],
            type: 'manga',
            status: 'unknown',
          } as Series);
        }
        return items.slice(0, limit);
      }
      const genreSlugs = [
        'action', 'adventure', 'comedy', 'drama', 'fantasy', 'romance',
        'sci-fi', 'slice-of-life', 'shounen', 'shoujo', 'mystery', 'seinen',
      ];
      const seen = new Map<string, Series>();
      // Paralel (dulu sekuensial 12 fetch × 10s timeout = 12-120s → hang /api/search).
      const pages = await Promise.allSettled(genreSlugs.map((g) => fetchHtml(`${THRIVE_BASE}/genre/${g}`, 10000)));
      for (const page of pages) {
        if (page.status !== 'fulfilled') continue; /* skip failed genre page */
        const links = Array.from(page.value.matchAll(/href="\/title\/([0-9a-f-]{36})"[^>]*>[\s\S]*?<div[^>]*>([^<]{2,120})<\/div>/g));
        for (const m of links) {
          const id = m[1];
          const title = m[2].trim();
          if (!title.toLowerCase().includes(query)) continue;
          seen.set(id, {
            slug: id,
            external_id: id,
            source: 'thrive',
            source_url: `${THRIVE_BASE}/title/${id}/`,
            title,
            cover_image: null,
            type: 'manga',
            status: 'unknown',
          } as Series);
        }
      }
      return Array.from(seen.values()).slice(0, limit);
    },

    async getSeries(sourceId: string): Promise<Series> {
      const html = await fetchHtml(`${THRIVE_BASE}/title/${sourceId}/`);
      const data = parseNextData<ThriveDetail>(html);
      if (!data || !data.id) throw new Error(`thrive getSeries: no pageProps for ${sourceId}`);
      return toSeries(data);
    },

    async listChapters(sourceId: string): Promise<Chapter[]> {
      const data = await fetchDetail(sourceId);
      if (!data?.chapterlist) return [];
      return data.chapterlist.map((c) => ({
        id: c.chapter_id,
        series_slug: sourceId,
        chapter_number: c.chapter_number ? parseFloat(c.chapter_number) || 0 : 0,
        title: c.chapter_title ?? null,
        language: 'id',
        pages_count: 0,
        published_at: c.created_at ? new Date(c.created_at).getTime() : undefined,
      }));
    },

    async getSeriesDetail(sourceId: string, _opts?: { lang?: string }): Promise<{ series: Series; chapters: Chapter[] }> {
      // SINGLE fetch + SINGLE parseNextData — vs. getSeries + listChapters both
      // fetching /title/<id>/ separately.
      const data = await fetchDetail(sourceId);
      if (!data || !data.id) throw new Error(`thrive getSeriesDetail: no pageProps for ${sourceId}`);
      const series = toSeries(data);
      const chapters = (data.chapterlist || []).map((c) => ({
        id: c.chapter_id,
        series_slug: sourceId,
        chapter_number: c.chapter_number ? parseFloat(c.chapter_number) || 0 : 0,
        title: c.chapter_title ?? null,
        language: 'id',
        pages_count: 0,
        published_at: c.created_at ? new Date(c.created_at).getTime() : undefined,
      }));
      return { series, chapters };
    },

    async getChapter(chapterSourceId: string): Promise<Chapter> {
      return { id: chapterSourceId, series_slug: '', chapter_number: 0, title: null, language: 'id', pages_count: 0 };
    },

    async fetchPageUrls(chapterSourceId: string): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> {
      const html = await fetchHtml(`${THRIVE_BASE}/read/${chapterSourceId}/`);
      const data = parseNextData<ThriveChapterPage>(html);
      if (!data?.prefix || !data?.image) throw new Error(`thrive fetchPageUrls: no image data for ${chapterSourceId}`);
      return data.image.map((f) => ({
        url: `https://cdn.thrive.moe/data/${data.prefix}/${f}`,
        proxyHeaders: { Referer: THRIVE_BASE + '/' },
      }));
    },

    async scrapeUrl(url: string): Promise<{ series: Series; chapters: Chapter[]; coverImageUrl: string | null }> {
      const html = await fetchHtml(url);
      const data = parseNextData<ThriveDetail>(html);
      if (!data || !data.id) throw new Error('thrive scrapeUrl: no pageProps');
      const series = toSeries(data);
      return {
        series,
        chapters: (data.chapterlist || []).map((c) => ({
          id: c.chapter_id,
          series_slug: data.id,
          chapter_number: c.chapter_number ? parseFloat(c.chapter_number) || 0 : 0,
          title: c.chapter_title ?? null,
          language: 'id',
          pages_count: 0,
          published_at: c.created_at ? new Date(c.created_at).getTime() : undefined,
        })),
        coverImageUrl: series.cover_image ?? null,
      };
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
        const res = await fetch(THRIVE_BASE, {
          headers: { 'User-Agent': 'mozilla' },
          signal: AbortSignal.timeout(5000),
        });
        await drainResponse(res);
        return { healthy: res.ok, latency_ms: Date.now() - start };
      } catch (e) {
        return { healthy: false, latency_ms: Date.now() - start, error: String(e) };
      }
    },

    // Fixture helpers — used by unit tests only (no network).
    getSeriesFromFixtureForTest(d: ThriveDetail): Series { return toSeries(d); },
    searchHomepageFromFixtureForTest(html: string): Series[] {
      const items: Series[] = [];
      const seen = new Set<string>();
      for (const m of html.matchAll(/href="\/title\/([0-9a-f-]{36})"[^>]*>[\s\S]*?<img[^>]*src="(https:\/\/cdn\.thrive\.moe\/covers\/[^"]+)"[\s\S]*?<div[^>]*class="[^"]*line-clamp-2[^"]*"[^>]*>([^<]+)<\/div>/g)) {
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        const title = m[3].trim();
        items.push({
          slug: id,
          external_id: id,
          source: 'thrive',
          source_url: `${THRIVE_BASE}/title/${id}/`,
          title,
          cover_image: m[2],
          type: 'manga',
          status: 'unknown',
        } as Series);
      }
      return items;
    },
    listChaptersFromFixtureForTest(d: ThriveDetail): Chapter[] {
      return (d.chapterlist || []).map((c) => ({
        id: c.chapter_id,
        series_slug: d.id,
        chapter_number: c.chapter_number ? parseFloat(c.chapter_number) || 0 : 0,
        title: c.chapter_title ?? null,
        language: 'id',
        pages_count: 0,
        published_at: c.created_at ? new Date(c.created_at).getTime() : undefined,
      }));
    },
    fetchPageUrlsFromFixtureForTest(d: ThriveChapterPage): { url: string; proxyHeaders?: Record<string, string> }[] {
      return (d.image || []).map((f) => ({
        url: `https://cdn.thrive.moe/data/${d.prefix}/${f}`,
        proxyHeaders: { Referer: THRIVE_BASE + '/' },
      }));
    },
  };
};