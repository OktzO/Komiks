// Typed fetch wrappers for the MangaDex public API.
// CF Worker runtime: global fetch, Web Crypto, no Node http. Base host + optional API key.

const BASE = 'https://api.mangadex.org';

type QueryVal = string | number | boolean | undefined;
type Query = Record<string, QueryVal | QueryVal[]>;

const buildUrl = (path: string, query?: Query): string => {
  const url = new URL(path, BASE + '/');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) if (item !== undefined && item !== null) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  // Optional API key (rate-limit / authenticated requests). Append as ?key=
  const key = (typeof process !== 'undefined' && process.env?.MANGADEX_API_KEY) || undefined;
  if (key) url.searchParams.set('key', key);
  return url.toString();
};

const getJson = async <T>(path: string, query?: Query): Promise<T> => {
  const res = await fetch(buildUrl(path, query), {
    headers: { accept: 'application/json' }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MangaDex ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
};

// ---- Response entity types (subset of MangaDex API used by this adapter) ----

export interface Relationship {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

export interface Entity<T extends string = string, A = Record<string, unknown>> {
  id: string;
  type: T;
  attributes: A;
  relationships: Relationship[];
}

export interface MangaAttributes {
  title: Record<string, string>;
  altTitles?: Record<string, string>[];
  description: Record<string, string>;
  originalLanguage: string;
  status: string;
  year?: number | null;
  tags?: Array<{ id: string; type: 'tag'; attributes: { name: Record<string, string>; group: string } }>;
  contentRating?: string;
}

export interface ChapterAttributes {
  volume?: string | null;
  chapter?: string | null;
  title?: string | null;
  translatedLanguage: string;
  pages?: number;
  publishAt?: string;
  externalUrl?: string | null;
}

export interface AtHomeAttributes {
  baseUrl: string;
}

export interface MangaListResponse {
  result: 'ok' | 'error';
  response: 'collection' | 'entity';
  data: Entity<'manga', MangaAttributes>[];
  limit: number;
  offset: number;
  total: number;
}

export interface MangaEntityResponse {
  result: 'ok' | 'error';
  response: 'entity';
  data: Entity<'manga', MangaAttributes>;
}

export interface ChapterListResponse {
  result: 'ok' | 'error';
  response: 'collection' | 'entity';
  data: Entity<'chapter', ChapterAttributes>[];
  limit: number;
  offset: number;
  total: number;
}

export interface ChapterEntityResponse {
  result: 'ok' | 'error';
  response: 'entity';
  data: Entity<'chapter', ChapterAttributes>;
}

export interface AtHomeResponse {
  result: 'ok' | 'error';
  baseUrl: string;
  chapter: {
    hash: string;
    data: string[];      // full-res filenames
    dataSaver: string[]; // compressed filenames
  };
}

// ---- Endpoint wrappers -----------------------------------------------------

export const mdGetMangaList = (query: Query): Promise<MangaListResponse> =>
  getJson<MangaListResponse>('/manga', query);

export const mdGetManga = (id: string, query?: Query): Promise<MangaEntityResponse> =>
  getJson<MangaEntityResponse>(`/manga/${id}`, query);

export const mdGetChapterList = (query: Query): Promise<ChapterListResponse> =>
  getJson<ChapterListResponse>('/chapter', query);

export const mdGetChapter = (id: string, query?: Query): Promise<ChapterEntityResponse> =>
  getJson<ChapterEntityResponse>(`/chapter/${id}`, query);

export const mdGetAtHome = (chapterId: string): Promise<AtHomeResponse> =>
  getJson<AtHomeResponse>(`/at-home/server/${chapterId}`);

export const MANGADEX_BASE = BASE;
