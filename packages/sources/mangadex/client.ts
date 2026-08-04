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
  return url.toString();
};

const getJson = async <T>(path: string, query?: Query, apiKey?: string): Promise<T> => {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'User-Agent': 'manga-platform/1.0'
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(buildUrl(path, query), { headers });
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

export const mdGetMangaList = (query: Query, apiKey?: string): Promise<MangaListResponse> =>
  getJson<MangaListResponse>('/manga', query, apiKey);

export const mdGetManga = (id: string, query?: Query, apiKey?: string): Promise<MangaEntityResponse> =>
  getJson<MangaEntityResponse>(`/manga/${id}`, query, apiKey);

export const mdGetChapterList = (query: Query, apiKey?: string): Promise<ChapterListResponse> =>
  getJson<ChapterListResponse>('/chapter', query, apiKey);

export const mdGetChapter = (id: string, query?: Query, apiKey?: string): Promise<ChapterEntityResponse> =>
  getJson<ChapterEntityResponse>(`/chapter/${id}`, query, apiKey);

export const mdGetAtHome = (chapterId: string, apiKey?: string): Promise<AtHomeResponse> =>
  getJson<AtHomeResponse>(`/at-home/server/${chapterId}`, undefined, apiKey);

export const MANGADEX_BASE = BASE;
