// noveltoon.mobi novel adapter (capability: 'metadata').
//
// Same mangatoon template family as novelid, so the detail markup overlaps, but
// noveltoon SSRs no chapter list: chapters live behind /api (disallowed by
// robots.txt) and the mobile app. It is therefore a catalogue fallback with no
// `getChapterContent` and an always-empty `listChapters`.
//
// Search is also client-side only — /id/search SSRs "no result for 'x'" and
// fills via JS. `search` therefore walks the SSR genre listing and filters on
// title, which under-matches a real query but stays robots-clean.
import { decodeHtmlEntities } from '@manga-platform/shared/entities';
import { withNovelRetry } from '../novel.js';
import type { NovelChapterSummary, NovelSeries } from '../novel.js';
import {
  NOVELTOON_BASE,
  NOVELTOON_PATHS,
  NOVELTOON_REFERER,
  fetchHtmlWithUrl,
  fetchRobots,
  isPathAllowed,
} from './client.js';
import type { RobotsResult } from './client.js';

export interface NoveltoonEnv {
  KV?: KVNamespace;
}

const NOVELTOON_PATTERNS = {
  detailTitle: /<h1\b[^>]*\bclass\s*=\s*["'][^"']*\bdetail-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
  detailAuthor: /<p\b[^>]*\bclass\s*=\s*["'][^"']*\bweb-author\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  detailSynopsis: /<p\b[^>]*\bclass\s*=\s*["'][^"']*\bdetail-desc-info\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  detailCover: /style\s*=\s*["'][^"']*background-image\s*:\s*url\(([^)"']+)["']?[^>]*>/i,
  card: /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bgenre-item-box\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
  cardTitle: /genre-item-title[^>]*>\s*([^<]*)</i,
  cardLabel: /genre-item-label[^>]*>\s*([^<]*)</i,
  cardImage: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i,
  contentId: /content_id=(\d+)/i,
  slugInUrl: /\/id\/([^/?#]+)/,
} as const;

const stripNoise = (html: string): string =>
  html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

const text = (raw: string | undefined): string =>
  (decodeHtmlEntities(raw?.replace(/<[^>]+>/g, '') ?? '') ?? '').trim();

const cardText = (pattern: RegExp, card: string): string => text(pattern.exec(stripNoise(card))?.[1]);

const stripCoverQuery = (url: string | null | undefined): string | null => {
  if (!url) return null;
  const trimmed = url.trim();
  return trimmed ? trimmed.split('?')[0] || null : null;
};

const isAbsolute = (href: string): boolean => /^https?:\/\//i.test(href);

const absolute = (href: string): string =>
  isAbsolute(href) ? href : NOVELTOON_BASE + href.replace(/^\/*/, '/').replace(/\/{2,}/g, '/');

export interface ParsedNoveltoonSeries {
  title: string;
  author: string | null;
  synopsis: string | null;
  coverUrl: string | null;
}

export const parseNoveltoonSeriesHtml = (html: string, slug: string): ParsedNoveltoonSeries => {
  const authorRaw = text(NOVELTOON_PATTERNS.detailAuthor.exec(html)?.[1]);
  const synopsisRaw = text(NOVELTOON_PATTERNS.detailSynopsis.exec(html)?.[1]);
  const coverRaw = NOVELTOON_PATTERNS.detailCover.exec(html)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
  return {
    title: text(NOVELTOON_PATTERNS.detailTitle.exec(html)?.[1]),
    author: authorRaw ? authorRaw.replace(/^Nama\s+Author\s*[:：]?\s*/i, '') || null : null,
    synopsis: synopsisRaw ? synopsisRaw.split(/Karya ini diterbitkan atas izin/i)[0].trim() || null : null,
    coverUrl: coverRaw ? stripCoverQuery(absolute(coverRaw)) : null,
  };
};

export interface ParsedNoveltoonCard {
  contentId: string;
  slug: string;
  title: string;
  genres: string[];
  coverUrl: string | null;
}

export const parseNoveltoonListHtml = (html: string): ParsedNoveltoonCard[] => {
  const cards: ParsedNoveltoonCard[] = [];
  for (const m of html.matchAll(NOVELTOON_PATTERNS.card)) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1] ?? '';
    const contentId = NOVELTOON_PATTERNS.contentId.exec(href)?.[1] ?? '';
    const slug = NOVELTOON_PATTERNS.slugInUrl.exec(href)?.[1] ?? '';
    const title = cardText(NOVELTOON_PATTERNS.cardTitle, m[1]);
    if (!contentId || !title) continue;
    cards.push({
      contentId,
      slug,
      title,
      // The label cell packs several tags into one pipe-separated string.
      genres: cardText(NOVELTOON_PATTERNS.cardLabel, m[1])
        .split('|')
        .map((g) => g.trim())
        .filter(Boolean),
      coverUrl: stripCoverQuery(NOVELTOON_PATTERNS.cardImage.exec(m[1])?.[1]),
    });
  }
  return cards;
};

export const noveltoonAdapter = (env?: NoveltoonEnv) => {
  const get = (url: string, entityId: string, stage: string) =>
    withNovelRetry(
      async () => {
        const robots = await fetchRobots(env?.KV ?? null);
        if (!isPathAllowed(robots, new URL(url).pathname)) {
          throw new Error(`noveltoon robots.txt disallows ${new URL(url).pathname}`);
        }
        return fetchHtmlWithUrl(url);
      },
      { source: 'noveltoon', entityId, stage }
    );

  return {
    sourceKey: 'noveltoon' as const,
    capability: 'metadata' as const,

    async search({ q, limit = 20, offset = 0 }: { q: string; limit?: number; offset?: number }): Promise<NovelSeries[]> {
      const needle = q.trim().toLowerCase();
      if (!needle) return [];
      // 18 cards per SSR page; walk only as deep as the requested window needs.
      const perPage = 18;
      const pages = Math.min(Math.ceil((offset + limit) / perPage), 3);
      const cards: ParsedNoveltoonCard[] = [];
      for (let page = 0; page < pages; page++) {
        const { html } = await get(NOVELTOON_BASE + NOVELTOON_PATHS.listing(page), needle, 'search');
        const pageCards = parseNoveltoonListHtml(html);
        cards.push(...pageCards);
        if (pageCards.length < perPage) break;
      }
      return cards
        .filter((c) => c.title.toLowerCase().includes(needle))
        .slice(offset, offset + limit)
        .map((c) => ({
          sourceSeriesId: c.contentId,
          source: 'noveltoon' as const,
          title: c.title,
          slug: c.slug,
          genres: c.genres.length > 0 ? c.genres : undefined,
          status: null,
          coverUrl: c.coverUrl,
        }));
    },

    async getSeries(sourceId: string): Promise<NovelSeries> {
      const id = sourceId.trim();
      const { html, finalUrl } = await get(NOVELTOON_BASE + NOVELTOON_PATHS.detail(id), id, 'getSeries');
      const slug = NOVELTOON_PATTERNS.slugInUrl.exec(finalUrl)?.[1] ?? id;
      const parsed = parseNoveltoonSeriesHtml(html, slug);
      if (!parsed.title) throw new Error(`noveltoon getSeries: no title for ${id}`);
      return {
        sourceSeriesId: id,
        source: 'noveltoon',
        title: parsed.title,
        slug,
        author: parsed.author,
        status: null,
        coverUrl: parsed.coverUrl,
        synopsis: parsed.synopsis,
        chapterCount: null,
      };
    },

    async listChapters(): Promise<NovelChapterSummary[]> {
      return [];
    },

    async checkRobots(url: string): Promise<RobotsResult> {
      const robots = await fetchRobots(env?.KV ?? null);
      return isPathAllowed(robots, new URL(url).pathname) ? robots : { ...robots, allowed: false };
    },
  };
};

export { NOVELTOON_REFERER };
