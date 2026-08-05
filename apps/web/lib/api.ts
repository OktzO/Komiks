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

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { next: { revalidate: 300 } });
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
