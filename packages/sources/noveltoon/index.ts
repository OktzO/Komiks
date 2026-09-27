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
import { novelFailure, withNovelRetry } from '../novel.js';
import type { NovelChapterSummary, NovelSeries } from '../novel.js';
import {
  NOVELTOON_BASE,
  NOVELTOON_PATHS,
  fetchHtmlWithUrl,
  fetchRobots,
  isPathAllowed,
} from './client.js';
import type { RobotsResult } from './client.js';
import { NOVELTOON_PATTERNS, parseNoveltoonListHtml, parseNoveltoonSeriesHtml } from './rules.js';
import type { ParsedNoveltoonCard } from './rules.js';

export interface NoveltoonEnv {
  KV?: KVNamespace;
}

// 18 cards per SSR listing page, verified against /id/genre/2/0/{page}.
const LISTING_PAGE_SIZE = 18;
// Listing is a popularity rank, not an index: paging past the head returns
// unrelated titles, so a deep offset would return confidently wrong results.
const MAX_LISTING_PAGES = 3;

export { parseNoveltoonSeriesHtml, parseNoveltoonListHtml };
export type { ParsedNoveltoonSeries, ParsedNoveltoonCard } from './rules.js';

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
      const lastPage = Math.ceil((offset + limit) / LISTING_PAGE_SIZE);
      if (lastPage > MAX_LISTING_PAGES) return [];
      const cards: ParsedNoveltoonCard[] = [];
      for (let page = 0; page < lastPage; page++) {
        const { html } = await get(NOVELTOON_BASE + NOVELTOON_PATHS.listing(page), needle, 'search');
        const pageCards = parseNoveltoonListHtml(html);
        cards.push(...pageCards);
        if (pageCards.length < LISTING_PAGE_SIZE) break;
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
          // Not published on the page; a metadata source must not invent one.
          status: null,
          coverUrl: c.coverUrl,
        }));
    },

    async getSeries(sourceId: string): Promise<NovelSeries> {
      const id = sourceId.trim();
      const { html, finalUrl } = await get(NOVELTOON_BASE + NOVELTOON_PATHS.detail(id), id, 'getSeries');
      const slug = NOVELTOON_PATTERNS.slugInUrl.exec(finalUrl)?.[1] ?? id;
      const parsed = parseNoveltoonSeriesHtml(html);
      if (!parsed.title) throw novelFailure('noveltoon', id, 'getSeries', `no title for ${id}`);
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
