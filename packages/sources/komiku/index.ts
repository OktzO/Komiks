// Komiku adapter: PRIMARY source. Uses @cloudflare/puppeteer for JS-rendered pages.
import puppeteer from '@cloudflare/puppeteer';
import type { Series, Chapter } from '@manga-platform/shared';
import { KOMIKU_SELECTORS } from './selectors.js';
import { fetchRobots, isPathAllowed, KOMIKU_BASE } from './client.js';
import type { RobotsResult } from './client.js';

export interface AdapterEnv {
  MY_BROWSER?: Fetcher;
  MANGADEX_API_KEY?: string;
}

const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'untitled';

const parseChapterNumber = (title: string): number => {
  const m = title.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
};

export const komikuAdapter = (env?: AdapterEnv) => {
  const launchBrowser = async () => {
    if (!env?.MY_BROWSER) throw new Error('MY_BROWSER binding not configured');
    return puppeteer.launch(env.MY_BROWSER);
  };

  return {
    sourceKey: 'komiku' as const,

    async search({ q, limit = 20 }: { q: string; limit?: number; offset?: number }): Promise<Series[]> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(`${KOMIKU_BASE}/?s=${encodeURIComponent(q)}`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        const results = await page.evaluate((sel) => {
          const items = Array.from(document.querySelectorAll(sel.container));
          return items.slice(0, 20).map((el) => {
            const a = el.querySelector(sel.link) as HTMLAnchorElement | null;
            const img = el.querySelector(sel.cover) as HTMLImageElement | null;
            const titleEl = el.querySelector(sel.title);
            const href = a?.href ?? '';
            const slug = href.split('/').filter(Boolean).pop() ?? '';
            return {
              slug: slug || slugify(titleEl?.textContent?.trim() ?? ''),
              title: titleEl?.textContent?.trim() ?? '',
              source: 'komiku',
              source_url: href,
              cover_image: img?.src ?? null,
              type: 'manga',
              status: 'ongoing',
            };
          });
        }, KOMIKU_SELECTORS.search);
        return (results as Series[]).slice(0, limit);
      } finally {
        await browser.close();
      }
    },

    async getSeries(sourceId: string): Promise<Series> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(`${KOMIKU_BASE}/manga/${sourceId}/`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        const data = await page.evaluate((sel) => {
          const title = document.querySelector(sel.title)?.textContent?.trim() ?? '';
          const synopsis = document.querySelector(sel.synopsis)?.textContent?.trim() ?? null;
          const cover = (document.querySelector(sel.cover) as HTMLImageElement)?.src ?? null;
          const author = document.querySelector(sel.author)?.textContent?.trim() ?? null;
          const status = document.querySelector(sel.status)?.textContent?.trim()?.toLowerCase() ?? 'ongoing';
          const type = document.querySelector(sel.type)?.textContent?.trim()?.toLowerCase() ?? 'manga';
          const genres = Array.from(document.querySelectorAll(sel.genreList)).map((a) => (a as HTMLAnchorElement).textContent?.trim() ?? '').filter(Boolean);
          return { title, synopsis, cover_image: cover, author, status, type, genres };
        }, KOMIKU_SELECTORS.detail);
        return {
          slug: sourceId,
          external_id: sourceId,
          source: 'komiku',
          source_url: `${KOMIKU_BASE}/manga/${sourceId}/`,
          ...data,
        } as Series;
      } finally {
        await browser.close();
      }
    },

    async listChapters(sourceId: string, _opts?: { lang?: string }): Promise<Chapter[]> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(`${KOMIKU_BASE}/manga/${sourceId}/`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        const chapters = await page.evaluate((sel) => {
          const links = Array.from(document.querySelectorAll(sel.chapterList));
          return links.map((a) => {
            const link = (a.tagName === 'A' ? a : a.querySelector(sel.chapterLink)) as HTMLAnchorElement;
            const title = link?.textContent?.trim() ?? '';
            const href = link?.href ?? '';
            const id = href.split('/').filter(Boolean).pop() ?? '';
            return { id, title, href, chapter_number: 0 };
          });
        }, KOMIKU_SELECTORS.detail);
        return chapters.map((c) => ({
          id: c.id,
          series_slug: sourceId,
          chapter_number: parseChapterNumber(c.title),
          title: c.title,
          language: 'id',
          pages_count: 0,
        }));
      } finally {
        await browser.close();
      }
    },

    async getChapter(chapterSourceId: string): Promise<Chapter> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(`${KOMIKU_BASE}/${chapterSourceId}/`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        const title = await page.title();
        return {
          id: chapterSourceId,
          series_slug: '',
          chapter_number: parseChapterNumber(title),
          title,
          language: 'id',
          pages_count: 0,
        };
      } finally {
        await browser.close();
      }
    },

    async fetchPageUrls(chapterSourceId: string): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(`${KOMIKU_BASE}/${chapterSourceId}/`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        const urls = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('#readerarea img, .reader-area img'));
          return imgs.map((img) => (img as HTMLImageElement).src).filter(Boolean);
        });
        return urls.map((url) => ({ url }));
      } finally {
        await browser.close();
      }
    },

    async scrapeUrl(url: string): Promise<{ series: Series; chapters: Chapter[]; coverImageUrl: string | null }> {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        const data = await page.evaluate((sel) => {
          const title = document.querySelector(sel.title)?.textContent?.trim() ?? '';
          const synopsis = document.querySelector(sel.synopsis)?.textContent?.trim() ?? null;
          const cover = (document.querySelector(sel.cover) as HTMLImageElement)?.src ?? null;
          const author = document.querySelector(sel.author)?.textContent?.trim() ?? null;
          const status = document.querySelector(sel.status)?.textContent?.trim()?.toLowerCase() ?? 'ongoing';
          const type = document.querySelector(sel.type)?.textContent?.trim()?.toLowerCase() ?? 'manga';
          const genres = Array.from(document.querySelectorAll(sel.genreList)).map((a) => (a as HTMLAnchorElement).textContent?.trim() ?? '').filter(Boolean);
          const chapterLinks = Array.from(document.querySelectorAll(sel.chapterList)).map((a) => {
            const link = (a.tagName === 'A' ? a : a.querySelector(sel.chapterLink)) as HTMLAnchorElement;
            return { id: link?.href?.split('/').filter(Boolean).pop() ?? '', title: link?.textContent?.trim() ?? '', href: link?.href ?? '' };
          });
          return { title, synopsis, cover_image: cover, author, status, type, genres, chapterLinks };
        }, KOMIKU_SELECTORS.detail);
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
        const chapters: Chapter[] = data.chapterLinks.map((c) => ({
          id: c.id,
          series_slug: slug,
          chapter_number: parseChapterNumber(c.title),
          title: c.title,
          language: 'id',
          pages_count: 0,
        }));
        return { series, chapters, coverImageUrl: data.cover_image };
      } finally {
        await browser.close();
      }
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
