/// <reference lib="dom" />
// Komiku adapter: PRIMARY source. Fetches HTML directly from komiku.org (no Puppeteer).
// Komiku site returns server-rendered HTML — parsing via regex avoids browser rendering rate limits.
import type { Series, Chapter } from '@manga-platform/shared';
import { KOMIKU_SELECTORS } from './selectors.js';
import { fetchRobots, isPathAllowed, KOMIKU_BASE } from './client.js';
import type { RobotsResult } from './client.js';

export interface AdapterEnv {
  MY_BROWSER?: Fetcher;
}

const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'untitled';

const parseChapterNumber = (title: string): number => {
  const m = title.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
};

// Parse Komiku search HTML (from api.komiku.org) without DOM — Worker has no DOMParser.
// Extracts slug, title, cover, source_url from `.bge` blocks.
const parseSearchHtml = (html: string, _sel: typeof KOMIKU_SELECTORS.search): Series[] => {
  const blocks = html.split('<div class="bge">').slice(1);
  return blocks.map((b) => {
    const hrefMatch = b.match(/href="([^"]+)"/);
    const titleMatch = b.match(/<h3>([^<]+)<\/h3>/);
    const imgMatch = b.match(/<img[^>]*src="([^"]+)"/);
    // Type from .tpe1_inf: "Manhwa Fantasi", "Manga Aksi", "Manhua ...". Default manga.
    const typeMatch = b.match(/class="tpe1_inf"[^>]*>\s*<b[^>]*>([^<]+)<\/b>/i)
      ?? b.match(/class="tpe1_inf"[^>]*>\s*([A-Za-z]+)/i);
    const typeRaw = typeMatch?.[1]?.trim()?.toLowerCase() ?? 'manga';
    const type = (['manga', 'manhwa', 'manhua'].includes(typeRaw) ? typeRaw : 'manga') as 'manga' | 'manhwa' | 'manhua';
    const href = hrefMatch ? hrefMatch[1] : '';
    const slug = href.split('/').filter(Boolean).pop() ?? '';
    return {
      slug: slug || slugify(titleMatch?.[1]?.trim() ?? ''),
      title: titleMatch?.[1]?.trim() ?? '',
      source: 'komiku',
      source_url: href.startsWith('http') ? href : KOMIKU_BASE + href,
      cover_image: imgMatch?.[1] ?? null,
      type,
      status: 'ongoing',
    } as Series;
  }).filter((s) => s.title);
};

// Parse Komiku detail HTML (from komiku.org/manga/<slug>/) without DOM — Worker has no DOMParser.
const parseDetailHtml = (html: string): { title: string; synopsis: string | null; cover_image: string | null; author: string | null; status: string; type: string; genres: string[] } => {
  // Title: find <span itemprop="name"> that is not "Komiku" sitename (inside <h1> context ideally).
  const allNames = Array.from(html.matchAll(/itemprop="name"[^>]*>([^<]+)</g)).map((m) => m[1].trim());
  const title = allNames.find((n) => n && n.toLowerCase() !== 'komiku') ?? allNames[0] ?? '';
  // Synopsis: <p class="desc" itemprop="description"> or <div itemprop="description">
  const synopsis = html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, '').trim()
    ?? html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, '').trim()
    ?? null;
  const cover = html.match(/itemprop="image"[^>]*src="([^"]+)"/)?.[1] ?? null;
  // Info table: <td>Author:</td><td>Masashi Kishimoto</td>
  const tds = Array.from(html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)).map((m) => m[1].trim());
  const findVal = (label: RegExp) => {
    const idx = tds.findIndex((t) => label.test(t));
    return idx >= 0 ? tds[idx + 1] : null;
  };
  const author = findVal(/^Author:/i);
  const statusRaw = findVal(/^Status:/i);
  const status = statusRaw ? (statusRaw.toLowerCase().includes('end') ? 'completed' : 'ongoing') : 'ongoing';
  const typeRaw = findVal(/^Tipe:/i);
  const type = typeRaw ? typeRaw.toLowerCase() : 'manga';
  const genres = Array.from(html.matchAll(/<a[^>]*href="[^"]*\/genre\/[^"]*"[^>]*>([^<]+)<\/a>/g)).map((m) => m[1].trim()).filter(Boolean);
  return { title, synopsis, cover_image: cover, author, status, type, genres };
};

export const komikuAdapter = (env?: AdapterEnv) => {
  return {
    sourceKey: 'komiku' as const,

    async search({ q, limit = 20 }: { q: string; limit?: number; offset?: number }): Promise<Series[]> {
      // Komiku search via htmx API endpoint — returns HTML directly, no JS render needed.
      // Avoids Puppeteer launch for search (saves browser requests for reader).
      const res = await fetch(`https://api.komiku.org/?s=${encodeURIComponent(q)}&post_type=manga`, {
        headers: { 'User-Agent': 'manga-platform/1.0', 'Referer': KOMIKU_BASE + '/' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      const html = await res.text();
      const items = parseSearchHtml(html, KOMIKU_SELECTORS.search);
      return items.slice(0, limit);
    },

    async getSeries(sourceId: string): Promise<Series> {
      const res = await fetch(`${KOMIKU_BASE}/manga/${sourceId}/`, {
        headers: { 'User-Agent': 'manga-platform/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`komiku getSeries ${res.status}`);
      const html = await res.text();
      const data = parseDetailHtml(html);
      // Komiku detail HTML lazily-loads the cover; the itemprop selector often
      // returns null. Fall back to the search endpoint to grab the thumbnail.
      // Komiku search matches on title keywords, not slug — use first words.
      let cover = data.cover_image;
      if (!cover) {
        try {
          const qWords = sourceId.split('-').slice(0, 2).join(' ');
          const searchRes = await fetch(`https://api.komiku.org/?s=${encodeURIComponent(qWords)}&post_type=manga`, {
            headers: { 'User-Agent': 'manga-platform/1.0', 'Referer': KOMIKU_BASE + '/' },
            signal: AbortSignal.timeout(8000),
          });
          if (searchRes.ok) {
            const sHtml = await searchRes.text();
            const items = parseSearchHtml(sHtml, KOMIKU_SELECTORS.search);
            const match = items.find((it) => it.slug === sourceId);
            if (match?.cover_image) cover = match.cover_image;
          }
        } catch { /* cover fallback optional */ }
      }
      return {
        slug: sourceId,
        external_id: sourceId,
        source: 'komiku',
        source_url: `${KOMIKU_BASE}/manga/${sourceId}/`,
        ...data,
        cover_image: cover,
      } as Series;
    },

    async listChapters(sourceId: string, _opts?: { lang?: string }): Promise<Chapter[]> {
      const res = await fetch(`${KOMIKU_BASE}/manga/${sourceId}/`, {
        headers: { 'User-Agent': 'manga-platform/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`komiku listChapters ${res.status}`);
      const html = await res.text();
      const links = Array.from(html.matchAll(/<a[^>]*href="(\/[^"]*-chapter-[\d.-]+\/?)"[^>]*title="([^"]*)"/g)).map((m) => {
        const href = m[1];
        const title = m[2].replace(/^Baca\s+/, '').replace(/\s+Bahasa Indonesia$/, '').replace(/\s+Terbaru$/, '');
        const id = href.split('/').filter(Boolean).pop() ?? '';
        return { id, title, href };
      });
      const seen = new Set<string>();
      const chapters = links.filter((c) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
      return chapters.map((c) => ({
        id: c.id,
        series_slug: sourceId,
        chapter_number: parseChapterNumber(c.title),
        title: c.title,
        language: 'id',
        pages_count: 0,
      }));
    },

    async getChapter(chapterSourceId: string): Promise<Chapter> {
      // Derive chapter metadata from URL slug — no Puppeteer needed (saves browser requests).
      const num = parseChapterNumber(chapterSourceId);
      const title = chapterSourceId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return {
        id: chapterSourceId,
        series_slug: '',
        chapter_number: num,
        title,
        language: 'id',
        pages_count: 0,
      };
    },

    async fetchPageUrls(chapterSourceId: string): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> {
      const res = await fetch(`${KOMIKU_BASE}/${chapterSourceId}/`, {
        headers: { 'User-Agent': 'manga-platform/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`komiku fetchPageUrls ${res.status}`);
      const html = await res.text();
      const urls = Array.from(html.matchAll(/<img[^>]*src="(https?:\/\/img\.komiku\.org\/[^"]+)"/g)).map((m) => m[1]);
      // Komiku images require Referer header — pass to image proxy.
      return urls.map((url) => ({ url, proxyHeaders: { Referer: 'https://komiku.org/' } }));
    },

    async scrapeUrl(url: string): Promise<{ series: Series; chapters: Chapter[]; coverImageUrl: string | null }> {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'manga-platform/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`komiku scrapeUrl ${res.status}`);
      const html = await res.text();
      const data = parseDetailHtml(html);
      const slug = url.split('/').filter(Boolean).pop() ?? slugify(data.title);
      const series: Series = {
        slug,
        external_id: slug,
        source: 'komiku',
        title: data.title,
        synopsis: data.synopsis,
        cover_image: data.cover_image,
        author: data.author,
        status: data.status,
        type: data.type,
        genres: data.genres.length > 0 ? data.genres : undefined,
        source_url: url,
        language: 'id',
      } as Series;
      const chapterLinks = Array.from(html.matchAll(/<a[^>]*href="(\/[^"]*-chapter-[\d.-]+\/?)"[^>]*title="([^"]*)"/g)).map((m) => ({
        id: m[1].split('/').filter(Boolean).pop() ?? '',
        title: m[2].replace(/^Baca\s+/, '').replace(/\s+Bahasa Indonesia$/, '').replace(/\s+Terbaru$/, ''),
        href: m[1],
      }));
      const seen = new Set<string>();
      const chapters = chapterLinks.filter((c) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; }).map((c) => ({
        id: c.id,
        series_slug: slug,
        chapter_number: parseChapterNumber(c.title),
        title: c.title,
        language: 'id',
        pages_count: 0,
      }));
      return { series, chapters, coverImageUrl: data.cover_image };
    },

    async checkRobots(url: string): Promise<RobotsResult> {
      const robots = await fetchRobots(null);
      const urlPath = new URL(url).pathname;
      if (!isPathAllowed(robots, urlPath)) {
        return { ...robots, allowed: false };
      }
      return robots;
    },

    async healthCheck(): Promise<{ healthy: boolean; latency_ms: number; error?: string }> {
      const start = Date.now();
      try {
        const res = await fetch(KOMIKU_BASE, { signal: AbortSignal.timeout(5000) });
        return { healthy: res.ok, latency_ms: Date.now() - start };
      } catch (e) {
        return { healthy: false, latency_ms: Date.now() - start, error: String(e) };
      }
    },
  };
};
