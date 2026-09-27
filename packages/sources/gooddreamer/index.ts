// gooddreamer.id novel adapter (capability: 'metadata').
//
// Chapter bodies are coin-gated upstream (`novel_price`, `free_chapter`) and no
// public chapter endpoint exists, so this adapter deliberately implements no
// `getChapterContent` and no `listChapters`. It is a catalogue fallback: enough
// to back-fill and match series, never enough to serve a chapter.
import { withNovelRetry } from '../novel.js';
import type { NovelChapterSummary, NovelSeries } from '../novel.js';
import { GOODDREAMER_PATHS, fetchJson, normalizeMediaUrl } from './client.js';

interface GooddreamerNovel {
  id: number;
  novel_uri: string;
  novel_title: string;
  novel_sinopsis?: string | null;
  novel_cover?: string | null;
  chapters_count?: number | null;
  author?: { fullname?: string | null } | null;
  main_category?: { category_name?: string | null } | null;
  categories?: { category_name?: string | null }[] | null;
  tags?: { name?: string | null }[] | null;
}

// Tags expose `name`, categories expose `category_name` — accept either so one
// helper covers both lists.
const names = (
  rows: ({ name?: string | null; category_name?: string | null } | null | undefined)[] | null | undefined
): string[] =>
  (rows ?? []).map((r) => (r?.name ?? r?.category_name)?.trim()).filter((n): n is string => Boolean(n));

const mapNovel = (raw: GooddreamerNovel): NovelSeries => {
  const genres = [
    ...(raw.main_category?.category_name?.trim() ? [raw.main_category.category_name.trim()] : []),
    ...names(raw.categories),
    ...names(raw.tags),
  ];
  return {
    sourceSeriesId: String(raw.id),
    source: 'gooddreamer',
    title: raw.novel_title,
    slug: raw.novel_uri,
    author: raw.author?.fullname?.trim() || null,
    genres: [...new Set(genres)],
    // Not published in the payload; a metadata source must not invent one.
    status: null,
    coverUrl: normalizeMediaUrl(raw.novel_cover),
    synopsis: raw.novel_sinopsis?.trim() || null,
    chapterCount: raw.chapters_count ?? null,
  };
};

export const gooddreamerAdapter = () => {
  const get = <T,>(path: string, query: Record<string, string | number | undefined>, entityId: string, stage: string) =>
    withNovelRetry(() => fetchJson<T>(path, query), { source: 'gooddreamer', entityId, stage });

  return {
    sourceKey: 'gooddreamer' as const,
    capability: 'metadata' as const,

    async search({ q, limit = 20, offset = 0 }: { q: string; limit?: number; offset?: number }): Promise<NovelSeries[]> {
      const trimmed = q.trim();
      if (!trimmed) return [];
      const payload = await get<{ data?: GooddreamerNovel[] }>(
        GOODDREAMER_PATHS.novels,
        { q: trimmed, limit, page: Math.floor(offset / Math.max(limit, 1)) + 1 },
        trimmed,
        'search'
      );
      return (payload.data ?? []).map(mapNovel);
    },

    async getSeries(sourceId: string): Promise<NovelSeries> {
      const id = sourceId.trim();
      const payload = await get<{ data?: GooddreamerNovel }>(
        GOODDREAMER_PATHS.novel(id),
        {},
        id,
        'getSeries'
      );
      const raw = payload.data;
      if (!raw) throw new Error(`gooddreamer getSeries: empty payload for ${id}`);
      return mapNovel(raw);
    },

    async listChapters(): Promise<NovelChapterSummary[]> {
      return [];
    },
  };
};
