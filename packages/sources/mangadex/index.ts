// MangaDex → shared domain mapping + SourceAdapter implementation.
import type { Series, Chapter, SeriesType, SeriesStatus } from '@manga-platform/shared';
import {
  mdGetMangaList,
  mdGetManga,
  mdGetChapterList,
  mdGetChapter,
  mdGetAtHome,
  type Entity,
  type Relationship,
  type MangaAttributes,
  type ChapterAttributes
} from './client.js';

// ---- helpers ---------------------------------------------------------------

const slugify = (s: string): string =>
  s.toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'untitled';

const first8 = (uuid: string): string => uuid.replace(/-/g, '').slice(0, 8);

const pickTitle = (attrs: MangaAttributes): string => {
  const t = attrs.title;
  return t.en ?? t.ja ?? t['ja-ro'] ?? t.ko ?? t.zh ?? t['zh-ro'] ?? Object.values(t)[0] ?? 'Untitled';
};

const pickSynopsis = (attrs: MangaAttributes): string | null => {
  const d = attrs.description;
  if (!d) return null;
  return d.en ?? Object.values(d)[0] ?? null;
};

const TYPE_BY_LANG: Record<string, SeriesType> = {
  ja: 'manga',
  ko: 'manhwa',
  zh: 'manhua'
};

const STATUS_MAP: Record<string, SeriesStatus> = {
  ongoing: 'ongoing',
  completed: 'completed',
  hiatus: 'hiatus',
  discontinued: 'cancelled'
};

const mapType = (lang: string | undefined): SeriesType => {
  if (!lang) return 'manga';
  return TYPE_BY_LANG[lang.slice(0, 2)] ?? 'manga';
};

const mapStatus = (s: string | undefined): SeriesStatus => {
  if (!s) return 'ongoing';
  return STATUS_MAP[s.toLowerCase()] ?? 'ongoing';
};

const relsByType = (e: Entity<'manga', MangaAttributes>, type: string): Relationship[] =>
  e.relationships.filter((r) => r.type === type);

const coverFilename = (e: Entity<'manga', MangaAttributes>): string | null => {
  const cover = relsByType(e, 'cover_art')[0];
  const fn = cover?.attributes?.['fileName'];
  return typeof fn === 'string' ? fn : null;
};

const personName = (e: Entity<'manga', MangaAttributes>, type: 'author' | 'artist'): string | null => {
  const rel = relsByType(e, type)[0];
  const n = rel?.attributes?.['name'];
  return typeof n === 'string' ? n : null;
};

const genresFromTags = (attrs: MangaAttributes): string[] | undefined => {
  if (!attrs.tags || attrs.tags.length === 0) return undefined;
  const out = attrs.tags
    .filter((t) => t.attributes.group === 'tag')
    .map((t) => t.attributes.name.en ?? Object.values(t.attributes.name)[0])
    .filter((n): n is string => typeof n === 'string');
  return out.length > 0 ? out : undefined;
};

// ---- mapping ---------------------------------------------------------------

export const mapManga = (e: Entity<'manga', MangaAttributes>): Series => {
  const a = e.attributes;
  const id = e.id;
  const title = pickTitle(a);
  const cover = coverFilename(e);
  return {
    slug: `${slugify(title)}--${first8(id)}`,
    external_id: id,
    source: 'mangadex',
    title,
    synopsis: pickSynopsis(a),
    type: mapType(a.originalLanguage),
    status: mapStatus(a.status),
    author: personName(e, 'author'),
    artist: personName(e, 'artist'),
    cover_image: cover ? `https://uploads.mangadex.org/covers/${id}/${cover}` : null,
    genres: genresFromTags(a)
  };
};

export const mapChapter = (
  e: Entity<'chapter', ChapterAttributes>,
  mangaUuid: string
): Chapter => {
  const a = e.attributes;
  const numStr = a.chapter ?? '0';
  const num = parseFloat(numStr);
  return {
    id: `${mangaUuid}@${a.translatedLanguage}:${e.id}`,
    series_slug: '', // filled by caller (needs manga title); see listChapters
    chapter_number: Number.isFinite(num) ? num : 0,
    volume: a.volume ?? null,
    title: a.title ?? null,
    language: a.translatedLanguage,
    pages_count: 0,
    published_at: a.publishAt ? Date.parse(a.publishAt) / 1000 | 0 : null
  };
};

// ---- adapter ---------------------------------------------------------------

export interface SearchParams {
  q: string;
  limit?: number;
  offset?: number;
}

export interface ListChaptersOpts {
  lang?: string;
  chapter?: string;
}

export interface PageUrl {
  url: string;
  proxyHeaders?: Record<string, string>;
}

export interface AdapterEnv {
  MANGADEX_API_KEY?: string;
}

export const mangadexAdapter = (env?: AdapterEnv): MangadexAdapter => {
  const apiKey = env?.MANGADEX_API_KEY || undefined;
  return {
    sourceKey: 'mangadex' as const,

    async search({ q, limit = 20, offset = 0 }: SearchParams): Promise<Series[]> {
      const res = await mdGetMangaList({
        title: q,
        limit,
        offset,
        'includes[]': ['cover_art', 'author', 'artist'],
        'order[relevance]': 'desc'
      }, apiKey);
      return res.data.map(mapManga);
    },

    async listChapters(sourceId: string, opts: ListChaptersOpts = {}): Promise<Chapter[]> {
      // Need manga title for series_slug → fetch manga once.
      const manga = await mdGetManga(sourceId, { 'includes[]': 'author' }, apiKey);
      const seriesSlug = `${slugify(pickTitle(manga.data.attributes))}--${first8(sourceId)}`;
      const res = await mdGetChapterList({
        manga: sourceId,
        'translatedLanguage[]': opts.lang,
        chapter: opts.chapter,
        limit: 100,
        offset: 0,
        'order[chapter]': 'asc',
        'includes[]': 'scanlation_group'
      }, apiKey);
      return res.data.map((e) => {
        const c = mapChapter(e, sourceId);
        c.series_slug = seriesSlug;
        return c;
      });
    },

    async getChapter(chapterSourceId: string): Promise<Chapter> {
      // chapterSourceId = `${mangaUuid}@${lang}:${chapterId}` — parse out pieces.
      const at = chapterSourceId.lastIndexOf(':');
      if (at < 0) throw new Error(`bad chapterSourceId: ${chapterSourceId}`);
      const chapterId = chapterSourceId.slice(at + 1);
      const beforeLang = chapterSourceId.slice(0, at);
      const atAt = beforeLang.indexOf('@');
      const mangaUuid = atAt >= 0 ? beforeLang.slice(0, atAt) : beforeLang;
      const res = await mdGetChapter(chapterId, { 'includes[]': 'scanlation_group' }, apiKey);
      const c = mapChapter(res.data, mangaUuid);
      // series_slug requires manga title; fetch lazily.
      const manga = await mdGetManga(mangaUuid, undefined, apiKey);
      c.series_slug = `${slugify(pickTitle(manga.data.attributes))}--${first8(mangaUuid)}`;
      return c;
    },

    async fetchPageUrls(chapterSourceId: string): Promise<PageUrl[]> {
      // chapterSourceId may be either a bare chapter UUID or the composite
      // `${mangaUuid}@${lang}:${chapterId}`. Extract the chapterId tail.
      const colonIdx = chapterSourceId.lastIndexOf(':');
      const chapterId = colonIdx >= 0 && chapterSourceId.includes('@')
        ? chapterSourceId.slice(colonIdx + 1)
        : chapterSourceId;
      const at = await mdGetAtHome(chapterId, apiKey);
      const { baseUrl, chapter } = at;
      return chapter.data.map((filename) => ({
        url: `${baseUrl}/data/${chapter.hash}/${filename}`
      }));
    }
  };
};

export interface MangadexAdapter {
  sourceKey: 'mangadex';
  search(params: SearchParams): Promise<Series[]>;
  listChapters(sourceId: string, opts?: ListChaptersOpts): Promise<Chapter[]>;
  getChapter(chapterSourceId: string): Promise<Chapter>;
  fetchPageUrls(chapterSourceId: string): Promise<PageUrl[]>;
}
