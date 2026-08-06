export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export interface Series {
  slug: string;
  external_id: string;
  source: string;
  title: string;
  synopsis?: string | null;
  type: string;
  status: string;
  author?: string | null;
  artist?: string | null;
  cover_image?: string | null;
  genres?: string[];
  tags?: string[];
}

export interface Chapter {
  id: string;
  series_slug: string;
  chapter_number: number;
  volume?: string | null;
  title?: string | null;
  language: string;
  pages_count: number;
  published_at?: number | null;
  pages?: { proxyUrl: string }[];
}

export interface MangaDexManga {
  id: string;
  title: string;
  cover: string | null;
  slug: string;
}

// 12s timeout prevents Cloudflare Pages Function timeout (30s) from
// triggering a 502 when the Worker API is slow on cold KV cache.
async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const getSeries = (source: string, sourceId: string) =>
  api<{ data: Series }>(`/api/reader/${source}/series/${sourceId}`).then((r) => r.data);

export const getChapters = (source: string, sourceId: string, lang = 'id') =>
  api<{ data: Chapter[] }>(`/api/reader/${source}/series/${sourceId}/chapters?lang=${lang}`).then((r) => r.data);

export const getChapter = (source: string, chapterId: string) =>
  api<{ data: Chapter }>(`/api/reader/${source}/chapter/${chapterId}`).then((r) => r.data);

export async function fetchPopularIndonesian(): Promise<MangaDexManga[]> {
  const url = 'https://api.mangadex.org/manga?limit=24&availableTranslatedLanguage[]=id&includes[]=cover_art&order[followedCount]=desc&contentRating[]=safe&contentRating[]=suggestive';
  const res = await fetch(url, { next: { revalidate: 600 } });
  if (!res.ok) throw new Error(`MangaDex popular → ${res.status}`);
  const j = await res.json() as any;
  return j.data.map((m: any) => {
    const title = m.attributes.title.en || m.attributes.title['ja-ro'] || Object.values(m.attributes.title)[0] || 'Untitled';
    const coverRel = m.relationships.find((r: any) => r.type === 'cover_art');
    const cover = coverRel?.attributes?.fileName
      ? `https://uploads.mangadex.org/covers/${m.id}/${coverRel.attributes.fileName}`
      : null;
    return { id: m.id, title, cover, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) };
  });
}

// ---- Data API (manga-data-api Worker) --------------------------------------
export const DATA_API_URL = process.env.NEXT_PUBLIC_DATA_API_URL || 'http://localhost:8788';

export interface MergedManga {
  slug: string;
  title: string;
  cover_image?: string | null;
  source: string;
  sources: string[];
  type?: string;
  status?: string;
}

export interface SourceStatus {
  source: string;
  healthy: boolean;
  latency_ms: number;
  last_checked_at: number;
  error?: string;
}

async function dataApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DATA_API_URL}${path}`, {
    ...init,
    next: { revalidate: 60 },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Data API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const searchMerged = (q: string): Promise<{ data: MergedManga[]; sources_queried: string[] }> =>
  dataApi(`/api/search?q=${encodeURIComponent(q)}`);

export const getSourceStatus = (): Promise<{ data: SourceStatus[] }> =>
  dataApi('/api/source-status');
