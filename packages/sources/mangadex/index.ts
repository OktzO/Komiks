// MangaDex → shared domain mapping + SourceAdapter implementation.
import type { Series, Chapter, SeriesType, SeriesStatus } from '@manga-platform/shared';
import {
  mdGetMangaList,
  mdGetManga,
  mdGetChapterList,
  mdGetMangaFeed,
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
  // pick latest cover (highest volume or first if none)
  const covers = relsByType(e, 'cover_art').sort((a, b) => {
    const va = (a.attributes?.volume as number) || 0;
    const vb = (b.attributes?.volume as number) || 0;
    return vb - va;
  });
  const fn = covers[0]?.attributes?.['fileName'];
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
    pages_count: a.pages ?? 0,
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

    async getSeries(sourceId: string): Promise<Series> {
      const res = await mdGetManga(sourceId, { 'includes[]': ['cover_art', 'author', 'artist'] }, apiKey);
      return mapManga(res.data);
    },

    async listChapters(sourceId: string, opts: ListChaptersOpts = {}): Promise<Chapter[]> {
      // Need manga title for series_slug → fetch manga once.
      const manga = await mdGetManga(sourceId, { 'includes[]': 'author' }, apiKey);
      const seriesSlug = `${slugify(pickTitle(manga.data.attributes))}--${first8(sourceId)}`;
      // Use the manga feed endpoint (returns chapters scoped to this manga).
      // Fetch in both the requested language and, as a fallback for titles with
      // no translation in that language, English + original — then filter to
      // chapters that are actually readable on MangaDex (no externalUrl and
      // with pages > 0). The /chapter search endpoint returns entries that 404
      // on detail fetch when they are externally hosted; the feed is the
      // documented way to list a manga's chapters.
      const langs = [opts.lang, 'en', manga.data.attributes.originalLanguage].filter((l): l is string => !!l);
      const seen = new Set<string>();
      const out: Entity<'chapter', ChapterAttributes>[] = [];
      for (const lang of langs) {
        const res = await mdGetMangaFeed(
          sourceId,
          {
            'translatedLanguage[]': lang,
            limit: 100,
            offset: 0,
            'order[chapter]': 'asc',
            'includes[]': 'scanlation_group'
          },
          apiKey
        );
        for (const e of res.data) {
          const a = e.attributes;
          // Skip externally-hosted or empty chapters — they 404 on /chapter/{id}
          // and have no pages to render.
          if (a.externalUrl) continue;
          if ((a.pages ?? 0) === 0) continue;
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          out.push(e);
        }
        if (out.length > 0) break; // found chapters in this lang, no need to fallback
      }
      // If no readable chapters found in any fallback language, return empty.
      return out.map((e) => {
        const c = mapChapter(e, sourceId);
        c.series_slug = seriesSlug;
        return c;
      });
    },

    async getChapter(chapterSourceId: string): Promise<Chapter> {
      // chapterSourceId may be a raw MangaDex chapter UUID or composite `${mangaUuid}@${lang}:${chapterId}`.
      const colonIdx = chapterSourceId.lastIndexOf(':');
      const chapterId = colonIdx >= 0 && chapterSourceId.includes('@')
        ? chapterSourceId.slice(colonIdx + 1)
        : chapterSourceId;
      const res = await mdGetChapter(chapterId, { 'includes[]': ['scanlation_group', 'manga'] }, apiKey);
      const a = res.data.attributes;
      // Externally hosted or empty chapters cannot be read on MangaDex.
      if (a.externalUrl) throw new Error('Chapter is externally hosted and cannot be read here');
      if ((a.pages ?? 0) === 0) throw new Error('Chapter has no pages available');
      const mangaRel = res.data.relationships.find((r) => r.type === 'manga');
      const mangaUuid = mangaRel?.id ?? (colonIdx >= 0 ? chapterSourceId.slice(0, chapterSourceId.indexOf('@')) : chapterId);
      const c = mapChapter(res.data, mangaUuid);
      c.pages_count = a.pages ?? 0;
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
      // Probe the chapter first to reject externally-hosted / empty chapters
      // with a clear error instead of an opaque at-home 502.
      const probe = await mdGetChapter(chapterId, undefined, apiKey);
      const pa = probe.data.attributes;
      if (pa.externalUrl) throw new Error('Chapter is externally hosted and cannot be read here');
      if ((pa.pages ?? 0) === 0) throw new Error('Chapter has no pages available');
      const at = await mdGetAtHome(chapterId, apiKey);
      const { baseUrl, chapter } = at;
      return chapter.data.map((filename) => ({
        url: `${baseUrl}/data/${chapter.hash}/${filename}`
      }));
    },

    async healthCheck(): Promise<{ healthy: boolean; latency_ms: number; error?: string }> {
      const start = Date.now();
      try {
        const res = await fetch('https://api.mangadex.org/manga?limit=1', {
          headers: { 'User-Agent': 'manga-data-api/1.0', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000)
        });
        return { healthy: res.ok, latency_ms: Date.now() - start, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
      } catch (e) {
        return { healthy: false, latency_ms: Date.now() - start, error: String(e) };
      }
    }
  };
};

export interface MangadexAdapter {
  sourceKey: 'mangadex';
  search(params: SearchParams): Promise<Series[]>;
  getSeries(sourceId: string): Promise<Series>;
  listChapters(sourceId: string, opts?: ListChaptersOpts): Promise<Chapter[]>;
  getChapter(chapterSourceId: string): Promise<Chapter>;
  fetchPageUrls(chapterSourceId: string): Promise<PageUrl[]>;
  healthCheck(): Promise<{ healthy: boolean; latency_ms: number; error?: string }>;
}
