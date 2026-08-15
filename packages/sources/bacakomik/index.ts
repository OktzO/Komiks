/// <reference lib="dom" />
// BacaKomik.my adapter. WordPress + komikcast6 theme, server-rendered HTML.
// Cloudflare Bot Fight on pages — hybrid fetch (plain fetch + Puppeteer
// fallback via MY_BROWSER binding). See client.ts.
import type { Series, Chapter } from '@manga-platform/shared';
import { drainResponse, sanitizeCoverUrl } from '@manga-platform/shared/http';
import { BACA_BASE, fetchHtml, fetchRobots, isPathAllowed } from './client.js';
import type { BacaFetchEnv, RobotsResult } from './client.js';

const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'untitled';

const parseChapterNumber = (title: string): number => {
  const m = title.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
};

// Relative Indonesian date → approx unix ts. "1 hari yang lalu" → now - 86400s.
const parseRelativeDate = (raw: string): number | undefined => {
  const s = raw.toLowerCase();
  const m = s.match(/(\d+)\s*(detik|menit|jam|hari|minggu|bulan|tahun)/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const secs = unit === 'detik' ? n
    : unit === 'menit' ? n * 60
    : unit === 'jam' ? n * 3600
    : unit === 'hari' ? n * 86400
    : unit === 'minggu' ? n * 604800
    : unit === 'bulan' ? n * 2592000
    : n * 31536000;
  return Math.floor(Date.now() / 1000) - secs;
};

// Parse search/homepage cards: `.animepost` blocks (same markup both places,
// homepage uses data-lazy-src for covers).
const parseSearchHtml = (html: string): Series[] => {
  const blocks = html.split('<div class="animepost">').slice(1);
  const items: Series[] = [];
  for (const b of blocks) {
    const href = b.match(/href="([^"]*\/komik\/[^"]+)"/)?.[1] ?? '';
    const slug = href.split('/').filter(Boolean).pop() ?? '';
    const title = b.match(/<h4>([^<]+)<\/h4>/)?.[1]?.trim() ?? '';
    const lazyImg = b.match(/data-lazy-src="([^"]+)"/)?.[1];
    const plainImg = b.match(/<img[^>]*src="(https?:\/\/[^"]+)"/)?.[1];
    const img = lazyImg ?? plainImg ?? null;
    const typeRaw = b.match(/typeflag\s*([A-Za-z]+)/)?.[1]?.toLowerCase() ?? 'manga';
    const type = (['manga', 'manhwa', 'manhua'].includes(typeRaw) ? typeRaw : 'manga') as 'manga' | 'manhwa' | 'manhua';
    if (title) {
      items.push({
        slug: slug || slugify(title),
        title,
        source: 'bacakomik',
        source_url: href.startsWith('http') ? href : BACA_BASE + href,
        cover_image: sanitizeCoverUrl(img),
        type,
        status: 'ongoing',
      } as Series);
    }
  }
  return items;
};

// Parse detail page: `.spe` label/value pairs, `.genre-info`, synopsis, cover.
const parseDetailHtml = (html: string): {
  title: string; synopsis: string | null; cover_image: string | null;
  author: string | null; status: 'ongoing' | 'completed'; type: 'manga' | 'manhwa' | 'manhua';
  genres: string[];
} => {
  const titleRaw = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
  const title = titleRaw.replace(/<[^>]+>/g, '').replace(/^Komik\s+/i, '').trim();
  const synopsis = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]
    ?.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '').trim() ?? null;
  const cover = sanitizeCoverUrl(html.match(/property="og:image"[^>]*content="([^"]+)"/)?.[1] ?? null);
  const genreBlock = html.match(/<div class="genre-info[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  const genres = Array.from(genreBlock.matchAll(/<a[^>]*>([^<]+)<\/a>/g)).map((m) => m[1].trim()).filter(Boolean);

  // .spe label/value pairs: `<span><b>Label:</b> Value</span>`
  const speSpans = Array.from(html.matchAll(/<span><b>([^<]+):<\/b>([\s\S]*?)<\/span>/g))
    .map((m) => [m[1].trim().toLowerCase(), m[2].replace(/<[^>]+>/g, '').trim()] as const);
  const find = (label: string): string | null => speSpans.find(([l]) => l === label)?.[1] ?? null;

  const statusRaw = find('status')?.toLowerCase() ?? '';
  const status = (statusRaw.includes('selesai') || statusRaw.includes('completed') ? 'completed' : 'ongoing') as 'ongoing' | 'completed';
  const typeRaw = (find('jenis komik') ?? '').toLowerCase();
  const type = (['manga', 'manhwa', 'manhua'].includes(typeRaw) ? typeRaw : 'manga') as 'manga' | 'manhwa' | 'manhua';
  const author = find('author');
  return { title, synopsis, cover_image: cover, author, status, type, genres };
};

// Parse chapter list from detail page `#chapter_list li`.
const parseChapterList = (html: string, seriesSlug: string): Chapter[] => {
  const listBlock = html.match(/<div[^>]*id="chapter_list"[\s\S]*?<\/ul>/)?.[0] ?? '';
  if (!listBlock) return [];
  const items = Array.from(listBlock.matchAll(/<li>([\s\S]*?)<\/li>/g));
  return items.map(([, li]) => {
    const href = li.match(/href="([^"]+)"[^>]*>/)?.[1] ?? '';
    const id = href.split('/').filter(Boolean).pop() ?? '';
    const titleRaw = li.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
    const title = titleRaw.replace(/<[^>]+>/g, '').replace(/^Chapter\s*/i, '').trim();
    const dateRaw = li.match(/class="dt"[^>]*>([\s\S]*?)<\/span>/)?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
    return {
      id,
      series_slug: seriesSlug,
      chapter_number: parseChapterNumber(id),
      title: title || null,
      language: 'id',
      pages_count: 0,
      published_at: parseRelativeDate(dateRaw),
    } as Chapter;
  }).filter((c) => c.id);
};

// Parse chapter page images: `#anjay_ini_id_kh img[data-lazy-src]`.
const parseChapterImages = (html: string): string[] => {
  const block = html.match(/<div[^>]*id="anjay_ini_id_kh"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? html;
  return Array.from(block.matchAll(/<img[^>]*data-lazy-src="([^"]+)"/g))
    .map((m) => m[1]).filter(Boolean);
};

export const bacakomikAdapter = (env?: BacaFetchEnv) => {
  return {
    sourceKey: 'bacakomik' as const,

    async search({ q, limit = 20 }: { q: string; limit?: number; offset?: number }): Promise<Series[]> {
      // Empty query → homepage listing (latest updates). Non-empty → ?s= search.
      const url = q.trim()
        ? `${BACA_BASE}/?s=${encodeURIComponent(q.trim())}`
        : `${BACA_BASE}/`;
      const html = await fetchHtml(url, env);
      const items = parseSearchHtml(html);
      return items.slice(0, limit);
    },

    async getSeries(sourceId: string): Promise<Series> {
      const url = `${BACA_BASE}/komik/${sourceId}/`;
      const html = await fetchHtml(url, env);
      const data = parseDetailHtml(html);
      return {
        slug: sourceId,
        external_id: sourceId,
        source: 'bacakomik',
        source_url: url,
        title: data.title || sourceId,
        synopsis: data.synopsis,
        cover_image: data.cover_image,
        author: data.author,
        status: data.status,
        type: data.type,
        genres: data.genres.length > 0 ? data.genres : undefined,
        language: 'id',
      } as Series;
    },

    async listChapters(sourceId: string): Promise<Chapter[]> {
      const html = await fetchHtml(`${BACA_BASE}/komik/${sourceId}/`, env);
      return parseChapterList(html, sourceId);
    },

    async getChapter(chapterSourceId: string): Promise<Chapter> {
      const num = parseChapterNumber(chapterSourceId);
      return {
        id: chapterSourceId,
        series_slug: '',
        chapter_number: num,
        title: `Chapter ${num}`,
        language: 'id',
        pages_count: 0,
      };
    },

    async fetchPageUrls(chapterSourceId: string): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> {
      const html = await fetchHtml(`${BACA_BASE}/${chapterSourceId}/`, env);
      const urls = parseChapterImages(html);
      return urls.map((url) => ({ url, proxyHeaders: { Referer: BACA_BASE + '/' } }));
    },

    async scrapeUrl(url: string): Promise<{ series: Series; chapters: Chapter[]; coverImageUrl: string | null }> {
      const html = await fetchHtml(url, env);
      const data = parseDetailHtml(html);
      const slug = url.split('/').filter(Boolean).pop() ?? slugify(data.title);
      const series: Series = {
        slug,
        external_id: slug,
        source: 'bacakomik',
        title: data.title,
        synopsis: data.synopsis,
        cover_image: data.cover_image,
        author: data.author,
        status: data.status,
        type: data.type,
        genres: data.genres.length > 0 ? data.genres : undefined,
        source_url: url,
        language: 'id',
      } as Series;
      return { series, chapters: parseChapterList(html, slug), coverImageUrl: data.cover_image };
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
        const res = await fetch(BACA_BASE, {
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
    searchFromFixtureForTest(html: string): Series[] { return parseSearchHtml(html); },
    getSeriesFromFixtureForTest(html: string, slug: string): Series {
      const d = parseDetailHtml(html);
      return {
        slug,
        external_id: slug,
        source: 'bacakomik',
        source_url: `${BACA_BASE}/komik/${slug}/`,
        title: d.title || slug,
        synopsis: d.synopsis,
        cover_image: d.cover_image,
        author: d.author,
        status: d.status,
        type: d.type,
        genres: d.genres.length > 0 ? d.genres : undefined,
        language: 'id',
      } as Series;
    },
    listChaptersFromFixtureForTest(html: string, slug: string): Chapter[] { return parseChapterList(html, slug); },
    fetchPageUrlsFromFixtureForTest(html: string): { url: string; proxyHeaders?: Record<string, string> }[] {
      return parseChapterImages(html).map((url) => ({ url, proxyHeaders: { Referer: BACA_BASE + '/' } }));
    },
  };
};