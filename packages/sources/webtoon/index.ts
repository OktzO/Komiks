// Webtoon (webtoons.com/id) adapter.
// Uses m.webtoons.com mobile API endpoints.
// Based on keiyoushi/extensions-source Webtoons.kt implementation.
import type { Series, Chapter } from '@manga-platform/shared';
import { sanitizeCoverUrl } from '@manga-platform/shared/http';
import { decodeHtmlEntities } from '@manga-platform/shared/entities';
import { mapStatusText } from '@manga-platform/shared/status';
import { WEBTOON_BASE, WEBTOON_API, fetchJson, fetchHtml, fetchRobots, isPathAllowed, extractTitleNo, buildSearchUrl, buildSeriesDetailUrl, buildEpisodeViewerUrl } from './client.js';
import type { WebtoonFetchEnv, RobotsResult } from './client.js';

interface WebtoonSeriesItem {
  titleNo: number;
  titleName: string;
  authorName: string;
  thumbnailUrl: string;
  genreName: string;
  serviceUrl: string;
  status?: string;
  dailyPassYn?: string;
  ageGrade?: string;
}

interface WebtoonSeriesDetail {
  titleNo: number;
  titleName: string;
  authorName: string;
  introduction: string;
  thumbnailUrl: string;
  genreName: string;
  serviceUrl: string;
  status: string;
  dailyPassYn: string;
  ageGrade: string;
  likeCount: number;
  viewCount: number;
  updateDay: string;
  completed: boolean;
  cartoonType: string;
  representTagList?: string[];
}

interface MobileSeriesItem {
  id: number;
  title: string;
  author: string;
  thumbnail: string;
  genre: string;
  link: string;
  status?: string;
}

interface MobileSeriesDetail {
  id: number;
  title: string;
  author: string;
  summary: string;
  thumbnail: string;
  genre: string;
  link: string;
  status: string;
  completed: boolean;
  updateDay: string;
}

interface EpisodeListResponse {
  result: {
    episodeList: MobileEpisode[];
  };
  episodes?: MobileEpisode[]; // fallback
}

interface MobileEpisode {
  episodeNo: number;
  episodeTitle: string;
  thumbnail: string;
  viewerLink: string;
  exposureDateMillis: number;
  displayUp: boolean;
  hasBgm: boolean;
  author?: string;
  status?: string;
  genre?: string;
}

interface EpisodeViewerResponse {
  id: number;
  title: string;
  images: string[];
  genre: string;
  slug: string;
  epSlug: string;
}

// Parse series detail HTML page
interface SeriesDetailHtml {
  title: string;
  author: string;
  artist: string;
  genre: string;
  description: string;
  thumbnail: string;
  status: string;
}

const parseSeriesDetailHtml = (html: string): SeriesDetailHtml => {
  // Title: h1.subj or h3.subj
  const titleMatch = html.match(/<h1[^>]*class="[^"]*subj[^"]*"[^>]*>([\s\S]*?)<\/h1>|<h3[^>]*class="[^"]*subj[^"]*"[^>]*>([\s\S]*?)<\/h3>/);
  const title = decodeHtmlEntities((titleMatch?.[1] ?? titleMatch?.[2] ?? '').replace(/<[^>]+>/g, '').trim()) ?? '';
  
  // Author/Artist from .detail_header .info .author
  const authorMatch = html.match(/<span[^>]*class="[^"]*author[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  const author = authorMatch ? decodeHtmlEntities(authorMatch[1].replace(/<[^>]+>/g, '').trim()) ?? '' : '';
  
  // Artist (2nd author)
  const artistMatch = html.match(/<span[^>]*class="[^"]*author[^"]*"[^>]*>[\s\S]*?<\/span>[\s\S]*?<span[^>]*class="[^"]*author[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  const artist = artistMatch ? decodeHtmlEntities(artistMatch[1].replace(/<[^>]+>/g, '').trim()) ?? '' : '';
  
  // Genre from .genre links
  const genreMatches = [...html.matchAll(/<a[^>]*class="[^"]*genre[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
  const genres = genreMatches.map(m => decodeHtmlEntities(m[1].trim()) ?? '').filter(Boolean);
  
  // Description from #_asideDetail p.summary
  const descMatch = html.match(/<p[^>]*class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const description = descMatch ? decodeHtmlEntities(descMatch[1].replace(/<[^>]+>/g, '').trim()) ?? '' : '';
  
  // Thumbnail from og:image or .detail_header .thmb img
  const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
  const thumbMatch = html.match(/<div[^>]*class="[^"]*thmb[^"]*"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/);
  const thumbnail = ogImageMatch?.[1] ?? thumbMatch?.[1] ?? '';
  
  // Status from p.day_info
  const statusMatch = html.match(/<p[^>]*class="[^"]*day_info[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const statusText = statusMatch ? statusMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  const status = statusText.toLowerCase().includes('up') || statusText.toLowerCase().includes('ongoing') || statusText.toLowerCase().includes('연재')
    ? 'ongoing'
    : statusText.toLowerCase().includes('end') || statusText.toLowerCase().includes('completed') || statusText.toLowerCase().includes('완결')
      ? 'completed'
      : statusText.toLowerCase().includes('hiatus') || statusText.toLowerCase().includes('휴재')
        ? 'hiatus'
        : 'ongoing';

  return { title, author, artist, genre: genres.join(', '), description, thumbnail, status };
};

const parseChapterNumber = (title: string): number => {
  const m = title.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
};

const mapWebtoonStatus = (status: string, completed: boolean): Series['status'] => {
  if (completed) return 'completed';
  const s = status?.toLowerCase() ?? '';
  if (s.includes('ongoing') || s.includes('연재') || s.includes('update') || s.includes('up')) return 'ongoing';
  if (s.includes('completed') || s.includes('완결') || s.includes('finish') || s.includes('end')) return 'completed';
  if (s.includes('hiatus') || s.includes('휴재') || s.includes('pause')) return 'hiatus';
  return 'ongoing';
};

const mapWebtoonType = (genre: string): Series['type'] => {
  const g = genre.toLowerCase();
  if (g.includes('manhwa') || g.includes('korea') || g.includes('korean')) return 'manhwa';
  if (g.includes('manhua') || g.includes('china') || g.includes('chinese')) return 'manhua';
  return 'manga';
};

const toSeries = (d: MobileSeriesItem | MobileSeriesDetail): Series => {
  const id = String(d.id);
  const title = decodeHtmlEntities(d.title) ?? d.title;
  const synopsis = 'summary' in d ? (decodeHtmlEntities(d.summary) ?? null) : null;
  const genres = d.genre ? d.genre.split(',').map(g => g.trim()).filter(Boolean) : [];
  const status = 'completed' in d ? mapWebtoonStatus(d.status, d.completed) : mapWebtoonStatus(d.status ?? '', false);
  const type = mapWebtoonType(d.genre);
  return {
    slug: id,
    external_id: id,
    source: 'webtoon',
    source_url: d.link,
    title,
    synopsis,
    cover_image: sanitizeCoverUrl(d.thumbnail),
    genres: genres.length > 0 ? genres : undefined,
    type,
    status: status as Series['status'],
    author: d.author || null,
    language: 'id',
  } as Series;
};

const toEpisode = (ep: MobileEpisode, sourceId: string): Chapter => {
  // id komposit "titleNo:episodeNo" — format yang wajib dipenuhi fetchPageUrls.
  const id = `${sourceId}:${ep.episodeNo}`;
  const title = ep.episodeTitle ? decodeHtmlEntities(ep.episodeTitle) : null;
  return {
    id,
    series_slug: sourceId,
    chapter_number: ep.episodeNo,
    title: title ?? `Episode ${ep.episodeNo}`,
    language: 'id',
    pages_count: 0,
    published_at: ep.exposureDateMillis ? ep.exposureDateMillis : undefined,
  } as Chapter;
};

export const webtoonAdapter = (env?: WebtoonFetchEnv) => {
  return {
    sourceKey: 'webtoon' as const,

    // Search series by keyword
    async search({ q, limit = 20 }: { q: string; limit?: number; offset?: number }): Promise<Series[]> {
      if (!q.trim()) {
        // Empty query -> trending series (webtoons homepage)
        const url = `${WEBTOON_API}/webtoon/trending?page=1&pageSize=${limit}`;
        const data = await fetchJson<{ result: { episodeList: MobileSeriesItem[] } }>(url);
        return (data?.result?.episodeList || []).slice(0, limit).map(toSeries);
      }
      const url = buildSearchUrl(q.trim(), 1);
      const html = await fetchHtml(url, env);
      // Parse HTML search results (desktop site)
      const items: Series[] = [];
      // Pattern: <a href=".../list?title_no=123" class="link _card_item">...<img src="..."><strong class="title">Title</strong>...
      // More flexible regex to handle whitespace variations
      const regex = /href="([^"]*title_no=(\d+))"[^>]*class="link _card_item"[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?<strong class="title">([^<]+)<\/strong>/gi;
      for (const m of html.matchAll(regex)) {
        const fullUrl = m[1];
        const titleNo = m[2];
        const thumbnail = m[3];
        const title = decodeHtmlEntities(m[4].trim());
        items.push({
          slug: titleNo,
          external_id: titleNo,
          source: 'webtoon',
          source_url: fullUrl,
          title,
          cover_image: sanitizeCoverUrl(thumbnail),
          type: 'manhwa',
          status: 'unknown',
        } as Series);
        if (items.length >= limit) break;
      }
      return items;
    },

    // Get series detail by title_no
    async getSeries(sourceId: string): Promise<Series> {
      // Try webtoon type first, then canvas
      for (const type of ['webtoon', 'canvas'] as const) {
        try {
          // Fetch and parse HTML series detail page
          const detailUrl = `${WEBTOON_BASE}/id/${type === 'webtoon' ? 'webtoon' : 'canvas'}/${sourceId}/list?title_no=${sourceId}`;
          const html = await fetchHtml(detailUrl, env);
          const detail = parseSeriesDetailHtml(html);
          
          // Get episodes for link and genre info
          const episodeUrl = buildSeriesDetailUrl('webtoon', sourceId);
          const episodeData = await fetchJson<{ result: { episodeList: MobileEpisode[] } }>(`${WEBTOON_API}/webtoon/${sourceId}/episodes?pageSize=1`);
          const firstEp = episodeData?.result?.episodeList?.[0];
          
          if (!firstEp) throw new Error(`no episodes for ${sourceId}`);
          
          return {
            slug: sourceId,
            external_id: sourceId,
            source: 'webtoon',
            source_url: `${WEBTOON_BASE}/id/${type}/${sourceId}/list?title_no=${sourceId}`,
            title: detail.title,
            synopsis: detail.description || null,
            cover_image: sanitizeCoverUrl(detail.thumbnail),
            genres: detail.genre ? detail.genre.split(',').map(g => g.trim()).filter(Boolean) : undefined,
            type: mapWebtoonType(detail.genre),
            status: detail.status as Series['status'],
            author: detail.author || detail.artist || null,
            language: 'id',
          } as Series;
        } catch {
          continue;
        }
      }
      throw new Error(`webtoon getSeries: no series for ${sourceId}`);
    },

    // Get chapter list for a series
    async listChapters(sourceId: string): Promise<Chapter[]> {
      // Try webtoon type first, then canvas
      for (const type of ['webtoon', 'canvas'] as const) {
        try {
          const url = buildSeriesDetailUrl(type, sourceId);
          const data = await fetchJson<EpisodeListResponse>(url);
          const episodes = data?.result?.episodeList || data?.episodes || [];
          if (episodes.length) {
            return episodes.map(ep => toEpisode(ep, sourceId));
          }
        } catch {
          continue;
        }
      }
      return [];
    },

    // Reuse getSeries + listChapters — metadata real, bukan fabricate dari episode pertama
    // (sebelumnya: slug=episodeNo, title="Prologue", source_url=viewer URL → data salah masuk D1).
    async getSeriesDetail(sourceId: string, _opts?: { lang?: string }): Promise<{ series: Series; chapters: Chapter[] }> {
      const series = await this.getSeries(sourceId);
      const chapters = await this.listChapters(sourceId);
      return { series, chapters };
    },

    async getChapter(chapterSourceId: string): Promise<Chapter> {
      // chapterSourceId format "titleNo:episodeNo" (lihat toEpisode).
      const [titleNo, epNoStr] = chapterSourceId.includes(':')
        ? chapterSourceId.split(':')
        : [null, chapterSourceId];
      const epNo = parseInt(epNoStr, 10) || 0;
      return {
        id: chapterSourceId,
        series_slug: titleNo || '',
        chapter_number: epNo,
        title: `Episode ${epNo}`,
        language: 'id',
        pages_count: 0,
      };
    },

    async fetchPageUrls(chapterSourceId: string): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> {
      // chapterSourceId format: "titleNo:episodeNo"
      const [titleNo, episodeNo] = chapterSourceId.includes(':')
        ? chapterSourceId.split(':')
        : ['', chapterSourceId];
      if (!titleNo) throw new Error(`webtoon fetchPageUrls: need titleNo in chapterSourceId`);

      // Try webtoon type first, then canvas
      for (const type of ['webtoon', 'canvas'] as const) {
        try {
          const url = buildEpisodeViewerUrl(type, titleNo, episodeNo);
          const data = await fetchJson<EpisodeViewerResponse>(url);
          if (data?.images?.length) {
            return data.images.map(imgUrl => ({
              url: imgUrl,
              proxyHeaders: { Referer: `${WEBTOON_BASE}/` },
            }));
          }
        } catch {
          continue;
        }
      }
      throw new Error(`webtoon fetchPageUrls: no images for ${chapterSourceId}`);
    },

    async scrapeUrl(url: string): Promise<{ series: Series; chapters: Chapter[]; coverImageUrl: string | null }> {
      const titleNo = extractTitleNo(url);
      if (!titleNo) throw new Error(`webtoon scrapeUrl: cannot parse title_no from ${url}`);
      const { series, chapters } = await this.getSeriesDetail(titleNo);
      return { series, chapters, coverImageUrl: series.cover_image ?? null };
    },

    async checkRobots(url: string): Promise<RobotsResult> {
      const robots = await fetchRobots();
      const urlPath = new URL(url).pathname;
      if (!isPathAllowed(robots, urlPath)) return { ...robots, allowed: false };
      return robots;
    },

    async healthCheck(): Promise<{ healthy: boolean; latency_ms: number; error?: string }> {
      const start = Date.now();
      try {
        const res = await fetchJson<{ result: { episodeList: MobileSeriesItem[] } }>(`${WEBTOON_API}/webtoon/trending?page=1&pageSize=1`, 5000);
        return { healthy: res != null, latency_ms: Date.now() - start };
      } catch (e) {
        return { healthy: false, latency_ms: Date.now() - start, error: String(e) };
      }
    },

    // Fixture helpers for unit tests
    getSeriesFromFixtureForTest(d: MobileSeriesDetail): Series { return toSeries(d); },
    listChaptersFromFixtureForTest(d: MobileEpisode[], sourceId: string): Chapter[] { return d.map(ep => toEpisode(ep, sourceId)); },
    fetchPageUrlsFromFixtureForTest(d: EpisodeViewerResponse): { url: string; proxyHeaders?: Record<string, string> }[] {
      return d.images.map(imgUrl => ({ url: imgUrl, proxyHeaders: { Referer: WEBTOON_BASE + '/' } }));
    },
  };
};