// novelid.org novel adapter (capability: 'chapter').
// /novel/{slug}/ for series + chapter lists, /novel/{slug}/bab/{n}/ for prose.
// Search lives at `/?s=` and `/page/N/?s=` — `/search/` is disallowed by
// robots.txt and is never requested.
import { novelFailure, withNovelRetry } from '../novel.js';
import type { NovelChapterContent, NovelChapterSummary, NovelSeries } from '../novel.js';
import { NOVELID_BASE, fetchHtml, fetchRobots, isPathAllowed } from './client.js';
import type { RobotsResult } from './client.js';
import {
  NOVELID_PATHS,
  NOVELID_SEARCH_PAGE_SIZE,
  buildChapterSourceId,
  buildChapterUrl,
  buildSeriesUrl,
  parseChapterHtml,
  parseChapterListHtml,
  parseSearchHtml,
  parseSeriesHtml,
} from './rules.js';

export interface NovelidEnv {
  KV?: KVNamespace;
}

/** Robots gate. Runs before every upstream fetch so a source policy change is
 *  honoured without a code change. */
const fetchAllowed = async (url: string, env: NovelidEnv | undefined): Promise<string> => {
  const robots = await fetchRobots(env?.KV ?? null);
  if (!isPathAllowed(robots, new URL(url).pathname)) {
    throw new Error(`novelid robots.txt disallows ${new URL(url).pathname}`);
  }
  return fetchHtml(url);
};

export const novelidAdapter = (env?: NovelidEnv) => {
  const get = (url: string, entityId: string, stage: string) =>
    withNovelRetry(() => fetchAllowed(url, env), { source: 'novelid', entityId, stage });

  return {
    sourceKey: 'novelid' as const,
    capability: 'chapter' as const,

    async search({ q, limit = 20, offset = 0 }: { q: string; limit?: number; offset?: number }): Promise<NovelSeries[]> {
      const trimmed = q.trim();
      if (!trimmed) return [];
      const page = Math.floor(offset / NOVELID_SEARCH_PAGE_SIZE) + 1;
      const url = NOVELID_BASE + NOVELID_PATHS.search(trimmed, page);
      const html = await get(url, trimmed, 'search');
      const items = parseSearchHtml(html);
      // Upstream paginates in fixed 18-card pages, so the in-page window is the
      // remainder — not a plain slice(0, limit), which would repeat page 1.
      const start = offset % NOVELID_SEARCH_PAGE_SIZE;
      return items.slice(start, start + limit).map((item) => ({
        sourceSeriesId: item.slug,
        source: 'novelid' as const,
        title: item.title,
        slug: item.slug,
        genres: item.genre ? [item.genre] : undefined,
        coverUrl: item.coverUrl,
      }));
    },

    async getSeries(sourceId: string): Promise<NovelSeries> {
      const slug = sourceId.trim();
      const html = await get(buildSeriesUrl(slug), slug, 'getSeries');
      const parsed = parseSeriesHtml(html, slug);
      if (!parsed.title) throw novelFailure('novelid', slug, 'getSeries', `no title for ${slug}`);
      return {
        sourceSeriesId: slug,
        source: 'novelid',
        title: parsed.title,
        slug: parsed.slug,
        author: parsed.author,
        genres: parsed.genres.length > 0 ? parsed.genres : undefined,
        status: parsed.status,
        coverUrl: parsed.coverUrl,
        synopsis: parsed.synopsis,
        chapterCount: parsed.chapterCount,
      };
    },

    async listChapters(
      sourceId: string,
      { limit, offset = 0 }: { limit?: number; offset?: number } = {}
    ): Promise<NovelChapterSummary[]> {
      const slug = sourceId.trim();
      const html = await get(buildSeriesUrl(slug), slug, 'listChapters');
      const episodes = parseChapterListHtml(html);
      const window = limit === undefined ? episodes.slice(offset) : episodes.slice(offset, offset + limit);
      return window.map((ep) => {
        // `buildChapterSourceId` is the single definition of this id, so the
        // value `getChapterContent` accepts is the value stored.
        const sourceChapterId = buildChapterSourceId(ep.href) ?? `${slug}/${ep.number}`;
        return { sourceChapterId, number: ep.number, title: ep.title, sourceUrl: ep.href };
      });
    },

    async getChapterContent(sourceChapterId: string): Promise<NovelChapterContent> {
      const [slug, bab] = sourceChapterId.split('/');
      if (!slug || !bab) {
        throw novelFailure(
          'novelid',
          sourceChapterId,
          'getChapterContent',
          `bad id ${sourceChapterId} (expected "{slug}/{bab}")`
        );
      }
      const url = buildChapterUrl(slug, bab);
      const html = await get(url, sourceChapterId, 'getChapterContent');
      const prose = parseChapterHtml(html);
      // A 200 that yields no prose is the login-wall / upstream-redesign case; it
      // must leave a log trail, not a bare throw.
      if (!prose) throw novelFailure('novelid', sourceChapterId, 'getChapterContent', 'no prose for page');
      return { html: prose };
    },

    async checkRobots(url: string): Promise<RobotsResult> {
      const robots = await fetchRobots(env?.KV ?? null);
      return isPathAllowed(robots, new URL(url).pathname) ? robots : { ...robots, allowed: false };
    },
  };
};
