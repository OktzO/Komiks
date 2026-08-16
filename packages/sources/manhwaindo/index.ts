/// <reference lib="dom" />
// ManhwaIndo.my adapter. WordPress + mangareader theme, server-rendered HTML.
// Cloudflare Bot Fight — hybrid fetch (plain + MY_BROWSER Puppeteer fallback).
import type { Series, Chapter } from '@manga-platform/shared';
import { drainResponse, sanitizeCoverUrl } from '@manga-platform/shared/http';
import { decodeHtmlEntities } from '@manga-platform/shared/entities';
import { MANHWA_BASE, fetchHtml, fetchRobots, isPathAllowed } from './client.js';
import type { ManhwaFetchEnv, RobotsResult } from './client.js';

const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'untitled';

const parseChapterNumber = (id: string): number => {
  const m = id.match(/(?:-chapter-|^)(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
};

// "6 Agustus 2026" → unix seconds. Indonesian month names.
const ID_MONTHS: Record<string, number> = {
  januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5,
  juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11,
};
const parseIdDate = (raw: string): number | undefined => {
  const m = raw.trim().match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i);
  if (!m) return undefined;
  const d = Number(m[1]);
  const month = ID_MONTHS[m[2].toLowerCase()];
  if (month === undefined || d < 1 || d > 31) return undefined;
  return Math.floor(new Date(Number(m[3]), month, d).getTime() / 1000);
};

// Parse search page cards: `.listupd .bs .bsx` blocks.
const parseSearchHtml = (html: string): Series[] => {
  const blocks = html.split('<div class="bsx">').slice(1);
  const items: Series[] = [];
  for (const b of blocks) {
    const href = b.match(/href="([^"]*\/series\/[^"]+)"/)?.[1] ?? '';
    const slug = href.split('/').filter(Boolean).pop() ?? '';
    const title = (decodeHtmlEntities(b.match(/<div class="tt">\s*([^<]+?)\s*<\/div>/)?.[1]?.trim()
      ?? b.match(/<div class="tt">([^<]+)<\/div>/)?.[1]?.trim() ?? '') ?? '');
    const img = b.match(/data-src="([^"]+)"/)?.[1] ?? b.match(/src="(http[^"]+)"/)?.[1] ?? null;
    const cover_image = sanitizeCoverUrl(img ? img.replace(/^http:\/\//i, 'https://') : null);
    const typeRaw = b.match(/typename\s*([A-Za-z]+)/)?.[1]?.toLowerCase() ?? 'manga';
    const type = (['manga', 'manhwa', 'manhua'].includes(typeRaw) ? typeRaw : 'manga') as 'manga' | 'manhwa' | 'manhua';
    if (title) {
      items.push({
        slug: slug || slugify(title),
        title,
        source: 'manhwaindo',
        source_url: href.startsWith('http') ? href : MANHWA_BASE + href,
        cover_image: cover_image,
        type,
        status: 'ongoing',
      } as Series);
    }
  }
  return items;
};

// Parse detail page: H1, alternative, genres, synopsis, imptdt label pairs.
const parseDetailHtml = (html: string): {
  title: string; alt_title: string | null; synopsis: string | null; cover_image: string | null;
  author: string | null; status: 'ongoing' | 'completed'; type: 'manga' | 'manhwa' | 'manhua';
  genres: string[];
} => {
  const title = (decodeHtmlEntities(html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([^<]+)<\/h1>/)?.[1]?.trim() ?? '') ?? '');
  const altTitle = (decodeHtmlEntities(html.match(/<span class="alternative">([^<]+)<\/span>/)?.[1]?.trim() ?? '') ?? null);
  const synopsis = (html.match(/class="entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]
    ?.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '').trim() ?? null);
  const synopsisDecoded = synopsis != null ? decodeHtmlEntities(synopsis) ?? null : null;
  const cover = sanitizeCoverUrl(html.match(/property="og:image"[^>]*content="([^"]+)"/)?.[1]?.replace(/^http:\/\//i, 'https://') ?? null);
  const genresBlocks = Array.from(html.matchAll(/<span class="mgen">([\s\S]*?)<\/span>/g));
  const genres = genresBlocks[0]?.[1]
    ? Array.from(genresBlocks[0][1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)).map((m) => decodeHtmlEntities(m[1].trim()) ?? '').filter(Boolean)
    : [];

  // `.imptdt` rows: `<div class="imptdt"> Status <i>Ongoing</i></div>`
  const imptdt = Array.from(html.matchAll(/<div class="imptdt">\s*([^<]+?)\s*(?:<a[^>]*>([^<]+)<\/a>|<i[^>]*>([^<]+)<\/i>)/g))
    .map((m) => [m[1].trim().toLowerCase(), (m[2] ?? m[3] ?? '').trim()] as const);
  const find = (label: string): string | null => imptdt.find(([l]) => l === label)?.[1] ?? null;

  const statusRaw = (find('status') ?? '').toLowerCase();
  const status = (statusRaw.includes('completed') || statusRaw.includes('selesai') ? 'completed' : 'ongoing') as 'ongoing' | 'completed';
  const typeRaw = (find('type') ?? '').toLowerCase();
  const type = (['manga', 'manhwa', 'manhua'].includes(typeRaw) ? typeRaw : 'manga') as 'manga' | 'manhwa' | 'manhua';
  const authorRaw = find('posted by');
  const author = authorRaw != null ? decodeHtmlEntities(authorRaw) ?? null : null;
  return { title, alt_title: altTitle, synopsis: synopsisDecoded, cover_image: cover, author, status, type, genres };
};

// Parse chapter list from `#chapterlist li[data-num]`.
const parseChapterList = (html: string, seriesSlug: string): Chapter[] => {
  const listBlock = html.match(/<div[^>]*class="[^"]*eplister[^"]*"[^>]*id="chapterlist"[\s\S]*?<\/ul>/)?.[0]
    ?? html.match(/id="chapterlist"[\s\S]*?<\/ul>/)?.[0] ?? '';
  if (!listBlock) return [];
  const items = Array.from(listBlock.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g));
  return items.map(([, attrs, li]) => {
    const href = li.match(/href="([^"]+)"[^>]*>/)?.[1] ?? '';
    const id = href.split('/').filter(Boolean).pop() ?? '';
    const title = li.match(/<span class="chapternum">([^<]+)<\/span>/)?.[1]?.replace(/^Chapter\s*/i, '').trim() ?? null;
    const dateRaw = li.match(/<span class="chapterdate">([^<]+)<\/span>/)?.[1]?.trim() ?? '';
    return {
      id,
      series_slug: seriesSlug,
      chapter_number: parseChapterNumber(id),
      title: title || `Chapter ${parseChapterNumber(id)}` || null,
      language: 'id',
      pages_count: 0,
      published_at: parseIdDate(dateRaw),
    } as Chapter;
  }).filter((c) => c.id);
};

// Parse chapter page images from `#readerarea`. Images are inside <noscript>
// with single-quoted src attributes (lazysizes pattern).
const parseChapterImages = (html: string): string[] => {
  const start = html.indexOf('id="readerarea"');
  const end = html.indexOf('id="readerarea-loading"');
  const block = start >= 0
    ? html.slice(start, end > start ? end : start + 400000)
    : html;
  const urls = new Set<string>();
  for (const m of block.matchAll(/<img[^>]*\ssrc=(["'])(https?:\/\/[^"']+)\1[^>]*>/g)) {
    const src = m[2];
    if (/\.(webp|jpe?g|png|gif)(\?|$)/i.test(src) && !/upload\.gmbr\.pro\/(ID|uploads)/.test(src)) {
      urls.add(src);
    }
  }
  return Array.from(urls);
};

export const manhwaindoAdapter = (env?: ManhwaFetchEnv) => {
  return {
    sourceKey: 'manhwaindo' as const,

    async search({ q, limit = 20 }: { q: string; limit?: number; offset?: number }): Promise<Series[]> {
      // Empty query → homepage listing (latest updates). Non-empty → ?s= search.
      const url = q.trim()
        ? `${MANHWA_BASE}/?s=${encodeURIComponent(q.trim())}`
        : `${MANHWA_BASE}/`;
      const html = await fetchHtml(url, env);
      const items = parseSearchHtml(html);
      return items.slice(0, limit);
    },

    async getSeries(sourceId: string): Promise<Series> {
      const url = `${MANHWA_BASE}/series/${sourceId}/`;
      const html = await fetchHtml(url, env);
      const d = parseDetailHtml(html);
      return {
        slug: sourceId,
        external_id: sourceId,
        source: 'manhwaindo',
        source_url: url,
        title: d.title || sourceId,
        synopsis: d.synopsis,
        cover_image: d.cover_image,
        author: d.author,
        status: d.status,
        type: d.type,
        genres: d.genres.length > 0 ? d.genres : undefined,
        language: 'id',
      } as Series;
    },

    async listChapters(sourceId: string): Promise<Chapter[]> {
      const html = await fetchHtml(`${MANHWA_BASE}/series/${sourceId}/`, env);
      return parseChapterList(html, sourceId);
    },

    async getSeriesDetail(sourceId: string, _opts?: { lang?: string }): Promise<{ series: Series; chapters: Chapter[] }> {
      // SINGLE fetch — parse both series + chapters from same HTML.
      const url = `${MANHWA_BASE}/series/${sourceId}/`;
      const html = await fetchHtml(url, env);
      const d = parseDetailHtml(html);
      const series: Series = {
        slug: sourceId,
        external_id: sourceId,
        source: 'manhwaindo',
        source_url: url,
        title: d.title || sourceId,
        synopsis: d.synopsis,
        cover_image: d.cover_image,
        author: d.author,
        status: d.status,
        type: d.type,
        genres: d.genres.length > 0 ? d.genres : undefined,
        language: 'id',
      } as Series;
      return { series, chapters: parseChapterList(html, sourceId) };
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
      const html = await fetchHtml(`${MANHWA_BASE}/${chapterSourceId}/`, env);
      const urls = parseChapterImages(html);
      return urls.map((url) => ({ url, proxyHeaders: { Referer: MANHWA_BASE + '/' } }));
    },

    async scrapeUrl(url: string): Promise<{ series: Series; chapters: Chapter[]; coverImageUrl: string | null }> {
      const html = await fetchHtml(url, env);
      const d = parseDetailHtml(html);
      const slug = url.split('/').filter(Boolean).pop() ?? slugify(d.title);
      const series: Series = {
        slug,
        external_id: slug,
        source: 'manhwaindo',
        title: d.title,
        synopsis: d.synopsis,
        cover_image: d.cover_image,
        author: d.author,
        status: d.status,
        type: d.type,
        genres: d.genres.length > 0 ? d.genres : undefined,
        source_url: url,
        language: 'id',
      } as Series;
      return { series, chapters: parseChapterList(html, slug), coverImageUrl: d.cover_image };
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
        const res = await fetch(MANHWA_BASE, {
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
        source: 'manhwaindo',
        source_url: `${MANHWA_BASE}/series/${slug}/`,
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
      return parseChapterImages(html).map((url) => ({ url, proxyHeaders: { Referer: MANHWA_BASE + '/' } }));
    },
  };
};