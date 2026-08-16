/// <reference lib="dom" />
// Komiku adapter: PRIMARY source. Fetches HTML directly from komiku.org (no Puppeteer).
// Komiku site returns server-rendered HTML — parsing via regex avoids browser rendering rate limits.
import type { Series, Chapter } from '@manga-platform/shared';
import { drainResponse, sanitizeCoverUrl } from '@manga-platform/shared/http';
import { decodeHtmlEntities } from '@manga-platform/shared/entities';
import { KOMIKU_SELECTORS } from './selectors.js';
import { fetchRobots, isPathAllowed, KOMIKU_BASE, KOMIKU_UA, KOMIKU_REFERER } from './client.js';
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

// Chapter number has higher fidelity from the URL slug (/-chapter-<n>/) than
// from the title — titles embed volume numbers / "39 volumes" text (e.g. the
// outcast-hero series where every chapter parsed as "39"). Prefer the id.
const parseChapterNumberFromId = (id: string): number => {
  const m = id.match(/-chapter-(\d+(?:\.\d+)?)$/);
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
    // Komiku ships a `?resize=450,235` query on cover thumbnails, forcing
    // landscape (1.91:1) art into what our 3:4 portrait grid expects. Strip
    // it so the upstream returns the original portrait thumbnail (≈2:3).
    const cover_image = sanitizeCoverUrl(imgMatch?.[1] ?? null);
    return {
      slug: slug || slugify(titleMatch?.[1]?.trim() ?? ''),
      title: decodeHtmlEntities(titleMatch?.[1]?.trim() ?? '') ?? '',
      source: 'komiku',
      source_url: href.startsWith('http') ? href : KOMIKU_BASE + href,
      cover_image,
      type,
      status: 'ongoing',
    } as Series;
  }).filter((s) => s.title);
};

// Parse chapter links from the series detail HTML.
// Used by both listChapters and getSeriesDetail — single parse of one fetch.
const parseChapterList = (html: string, seriesSlug: string): Chapter[] => {
  const links = Array.from(html.matchAll(/<a[^>]*href="(\/[^"]*-chapter-[\d.-]+\/?)"[^>]*title="([^"]*)"/g)).map((m) => {
    const href = m[1];
    const title = decodeHtmlEntities(m[2].replace(/^Baca\s+/, '').replace(/\s+Bahasa Indonesia$/, '').replace(/\s+Terbaru$/, '')) ?? '';
    // Normalize: strip trailing slash so /foo-chapter-12/ and /foo-chapter-12 dedupe.
    const id = (href.split('/').filter(Boolean).pop() ?? '').replace(/\/$/, '');
    return { id, title, href };
  });
  const seen = new Set<string>();
  const chapters = links.filter((c) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
  return chapters.map((c) => ({
    id: c.id,
    series_slug: seriesSlug,
    chapter_number: parseChapterNumberFromId(c.id) || parseChapterNumber(c.title),
    title: c.title,
    language: 'id',
    pages_count: 0,
  }));
};

// Parse Komiku detail HTML (from komiku.org/manga/<slug>/) without DOM — Worker has no DOMParser.
const parseDetailHtml = (html: string): { title: string; synopsis: string | null; cover_image: string | null; author: string | null; status: string; type: string; genres: string[]; alt_titles: string[] } => {
  // Title: find <span itemprop="name"> that is not "Komiku" sitename (inside <h1> context ideally).
  // <meta itemprop="name" content="..."> tags are skipped because their content
  // sits INSIDE the tag, not after `>`. This naturally filters them out.
  const allNames = Array.from(html.matchAll(/itemprop="name"[^>]*>([^<]+)</g)).map((m) => m[1].trim());
  const title = decodeHtmlEntities(allNames.find((n) => n && n.toLowerCase() !== 'komiku') ?? allNames[0] ?? '') ?? '';
  // Synopsis: <p class="desc" itemprop="description"> or <div itemprop="description">
  const synopsis = (html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, '').trim()
    ?? html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, '').trim()
    ?? null);
  const synopsisDecoded = synopsis != null ? decodeHtmlEntities(synopsis) ?? null : null;
  // og:image is the most reliable cover source on Komiku manga pages — it
  // serves the full portrait art (`?w=1200`), unlike the lazy `itemprop=image`
  // attribute which often returns empty (itemscope-only) and forces a fallback
  // to the cropped landscape search thumbnail. Strip the `?resize=...` query
  // for the same reason as parseSearchHtml.
  const coverRaw =
    html.match(/property="og:image"\s+content="([^"]+)"/)?.[1]
    ?? html.match(/itemprop="image"[^>]*src="([^"]+)"/)?.[1]
    ?? null;
  const cover = sanitizeCoverUrl(coverRaw);
  // Info table: <td>Author:</td><td>Masashi Kishimoto</td>.
  // NOTE: Komiku wraps the type value in <strong>Manhwa</strong> so the
  // `[^<]*` table-cell capture returns empty for the Tipe row. We instead
  // prefer <meta itemprop="additionalType" content="Manhwa"> (schema.org) —
  // always present, always exact. Fall back to <td> parsing only if missing.
  const additionalType = html.match(/itemprop="additionalType"\s+content="([^"]+)"/i)?.[1]?.trim();
  const typeFromTable = (() => {
    const tds = Array.from(html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)).map((m) => m[1].trim());
    const idx = tds.findIndex((t) => /^Tipe:$/i.test(t));
    if (idx < 0) return null;
    // Skip the empty placeholder <td> that Komiku inserts before <td>Tema:</td>.
    for (let i = idx + 1; i < Math.min(idx + 4, tds.length); i++) {
      const v = tds[i].replace(/<[^>]+>/g, '').trim();
      if (/^(manga|manhwa|manhua)$/i.test(v)) return v.toLowerCase();
    }
    return null;
  })();
  const typeMatch = (additionalType && /^(manga|manhwa|manhua)$/i.test(additionalType) ? additionalType : null)
    ?? typeFromTable
    ?? html.match(/manga_img_horizontal-(manhua|manhwa|manga)/i)?.[1];
  const type = (typeMatch ?? 'manga').toLowerCase();
  // Genres: scope to the `<ul class="genre">...</ul>` block (excludes nav
  // menu genre links which are unrelated). Inside, Komiku nests `<span>`
  // inside `<a>` so direct text `[^<]+` misses the name — allow one nested
  // open+close tag level around the label.
  const genreBlock = html.match(/<ul class="genre">([\s\S]*?)<\/ul>/i)?.[1] ?? '';
  const genres = Array.from(genreBlock.matchAll(/<a[^>]*href="[^"]*\/genre\/[^"]*"[^>]*>(?:<[^>]+>)*([^<]+)(?:<\/[^>]+>)*<\/a>/g))
    .map((m) => (decodeHtmlEntities(m[1].trim()) ?? ''))
    .filter(Boolean);
  // Author / Status from <td> table (work fine — values are plain text).
  const tds = Array.from(html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)).map((m) => m[1].trim());
  const findVal = (label: RegExp) => {
    const idx = tds.findIndex((t) => label.test(t));
    return idx >= 0 ? tds[idx + 1] : null;
  };
  const author = findVal(/^Author:/i);
  const statusRaw = findVal(/^Status:/i);
  const status = statusRaw ? (statusRaw.toLowerCase().includes('end') ? 'completed' : 'ongoing') : 'ongoing';
  // Alt titles ("Judul Alternatif" row) — used for dedup matching + search.
  const altTitlesRaw = findVal(/^Judul Alternatif:/i) ?? findVal(/^Judul Lain:/i);
  const alt_titles = (altTitlesRaw ?? '')
    .replace(/<[^>]+>/g, '')
    .split(';')
    .map((t) => (decodeHtmlEntities(t.trim()) ?? '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0);
  return { title, synopsis: synopsisDecoded, cover_image: cover, author, status, type, genres, alt_titles };
};

export const komikuAdapter = (env?: AdapterEnv) => {
  return {
    sourceKey: 'komiku' as const,

    async search({ q, limit = 20 }: { q: string; limit?: number; offset?: number }): Promise<Series[]> {
      // Komiku search via htmx API endpoint — returns HTML directly, no JS render needed.
      // Avoids Puppeteer launch for search (saves browser requests for reader).
      const res = await fetch(`https://api.komiku.org/?s=${encodeURIComponent(q)}&post_type=manga`, {
        headers: { 'User-Agent': KOMIKU_UA, 'Referer': KOMIKU_REFERER },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { await drainResponse(res); return []; }
      const html = await res.text();
      const items = parseSearchHtml(html, KOMIKU_SELECTORS.search);
      return items.slice(0, limit);
    },

    async getSeries(sourceId: string): Promise<Series> {
      const res = await fetch(`${KOMIKU_BASE}/manga/${sourceId}/`, {
        headers: { 
          'User-Agent': KOMIKU_UA,
          'Referer': KOMIKU_REFERER,
        },
        signal: AbortSignal.timeout(30000),
        // Komiku HTML is cacheable at Cloudflare's edge (cf-cache-status
        // header on the response indicates HIT/MISS). Forcing cacheEverything
        // + cacheTtl ensures CF caches a successful upstream response so
        // concurrent miss-spike traffic doesn't all hammer komiku.org at once.
        cf: { cacheEverything: true, cacheTtl: 600 },
      });
      if (!res.ok) { await drainResponse(res); throw new Error(`komiku getSeries ${res.status}`); }
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
             headers: { 'User-Agent': KOMIKU_UA, 'Referer': KOMIKU_REFERER },
             signal: AbortSignal.timeout(8000),
           });
           if (searchRes.ok) {
             const sHtml = await searchRes.text();
             const items = parseSearchHtml(sHtml, KOMIKU_SELECTORS.search);
             const match = items.find((it) => it.slug === sourceId);
             if (match?.cover_image) cover = match.cover_image;
           } else {
             await drainResponse(searchRes);
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
        headers: { 'User-Agent': KOMIKU_UA },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { await drainResponse(res); throw new Error(`komiku listChapters ${res.status}`); }
      const html = await res.text();
      return parseChapterList(html, sourceId);
    },

    async getSeriesDetail(sourceId: string, _opts?: { lang?: string }): Promise<{ series: Series; chapters: Chapter[] }> {
      // SINGLE fetch of the detail page — parseBoth series metadata + chapter
      // list from the same HTML. Replaces the double-fetch (getSeries +
      // listChapters) that triggered Komiku DDoS-guard stalls → intermittent 502.
      const res = await fetch(`${KOMIKU_BASE}/manga/${sourceId}/`, {
        headers: { 'User-Agent': KOMIKU_UA, 'Referer': KOMIKU_REFERER },
        signal: AbortSignal.timeout(30000),
        cf: { cacheEverything: true, cacheTtl: 600 },
      });
      if (!res.ok) { await drainResponse(res); throw new Error(`komiku getSeriesDetail ${res.status}`); }
      const html = await res.text();
      const data = parseDetailHtml(html);
      let cover = data.cover_image;
      if (!cover) {
        try {
          const qWords = sourceId.split('-').slice(0, 2).join(' ');
          const searchRes = await fetch(`https://api.komiku.org/?s=${encodeURIComponent(qWords)}&post_type=manga`, {
            headers: { 'User-Agent': KOMIKU_UA, 'Referer': KOMIKU_REFERER },
            signal: AbortSignal.timeout(8000),
          });
          if (searchRes.ok) {
            const sHtml = await searchRes.text();
            const items = parseSearchHtml(sHtml, KOMIKU_SELECTORS.search);
            const match = items.find((it) => it.slug === sourceId);
            if (match?.cover_image) cover = match.cover_image;
          } else {
            await drainResponse(searchRes);
          }
        } catch { /* cover fallback optional */ }
      }
      const chapters = parseChapterList(html, sourceId);
      const series: Series = {
        slug: sourceId,
        external_id: sourceId,
        source: 'komiku',
        source_url: `${KOMIKU_BASE}/manga/${sourceId}/`,
        ...data,
        cover_image: cover,
      } as Series;
      return { series, chapters };
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
        headers: { 
          'User-Agent': KOMIKU_UA,
          'Referer': KOMIKU_REFERER,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) { await drainResponse(res); throw new Error(`komiku fetchPageUrls ${res.status}`); }
      const html = await res.text();
      const urls = Array.from(html.matchAll(/<img[^>]*src="(https?:\/\/img\.komiku\.org\/[^"]+)"/g)).map((m) => m[1]);
      // Komiku images require Referer header — pass to image proxy.
      return urls.map((url) => ({ url, proxyHeaders: { Referer: KOMIKU_REFERER } }));
    },

    async scrapeUrl(url: string): Promise<{ series: Series; chapters: Chapter[]; coverImageUrl: string | null }> {
      const res = await fetch(url, {
        headers: { 'User-Agent': KOMIKU_UA },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { await drainResponse(res); throw new Error(`komiku scrapeUrl ${res.status}`); }
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
        alt_titles: data.alt_titles.length > 0 ? data.alt_titles : undefined,
        source_url: url,
        language: 'id',
      } as Series;
      const chapterLinks = Array.from(html.matchAll(/<a[^>]*href="(\/[^"]*-chapter-[\d.-]+\/?)"[^>]*title="([^"]*)"/g)).map((m) => ({
        id: m[1].split('/').filter(Boolean).pop() ?? '',
        title: decodeHtmlEntities(m[2].replace(/^Baca\s+/, '').replace(/\s+Bahasa Indonesia$/, '').replace(/\s+Terbaru$/, '')) ?? '',
        href: m[1],
      }));
      const seen = new Set<string>();
      const chapters = chapterLinks.filter((c) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; }).map((c) => ({
        id: c.id,
        series_slug: slug,
        chapter_number: parseChapterNumberFromId(c.id) || parseChapterNumber(c.title),
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
        await drainResponse(res);
        return { healthy: res.ok, latency_ms: Date.now() - start };
      } catch (e) {
        return { healthy: false, latency_ms: Date.now() - start, error: String(e) };
      }
    },
  };
};
