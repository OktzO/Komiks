// novelid.org novel adapter (capability: 'chapter').
// /novel/{slug}/ for series + chapter lists, /novel/{slug}/bab/{n}/ for prose.
// Search lives at `/?s=` — `/search/` is disallowed by robots.txt and is never
// requested.
import { withNovelRetry } from '../novel.js';
import type { NovelChapterContent, NovelChapterSummary, NovelSeries } from '../novel.js';
import { NOVELID_BASE, NOVELID_REFERER, fetchHtml, fetchRobots, isPathAllowed } from './client.js';
import type { RobotsResult } from './client.js';
import {
  NOVELID_PATHS,
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

    async search({ q, limit = 20 }: { q: string; limit?: number; offset?: number }): Promise<NovelSeries[]> {
      const trimmed = q.trim();
      if (!trimmed) return [];
      const html = await get(NOVELID_BASE + NOVELID_PATHS.search(trimmed), trimmed, 'search');
      return parseSearchHtml(html)
        .slice(0, limit)
        .map((item) => ({
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
      if (!parsed.title) throw new Error(`novelid getSeries: no title for ${slug}`);
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
      // Upstream ids are `slug/bab-number`; a bare bab number cannot address the
      // chapter page because the slug is part of the URL.
      return window.map((ep) => ({
        sourceChapterId: `${slug}/${ep.number}`,
        number: ep.number,
        title: ep.title,
        sourceUrl: ep.href,
      }));
    },

    async getChapterContent(sourceChapterId: string): Promise<NovelChapterContent> {
      const [slug, bab] = sourceChapterId.split('/');
      if (!slug || !bab) throw new Error(`novelid getChapterContent: bad id ${sourceChapterId}`);
      const url = buildChapterUrl(slug, bab);
      const html = await get(url, sourceChapterId, 'getChapterContent');
      const prose = parseChapterHtml(html);
      if (!prose) throw new Error(`novelid getChapterContent: no prose for ${sourceChapterId}`);
      return { html: prose };
    },

    async checkRobots(url: string): Promise<RobotsResult> {
      const robots = await fetchRobots(env?.KV ?? null);
      return isPathAllowed(robots, new URL(url).pathname) ? robots : { ...robots, allowed: false };
    },
  };
};

export { NOVELID_REFERER };
