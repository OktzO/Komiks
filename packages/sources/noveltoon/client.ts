// noveltoon.mobi HTTP client. Indonesian lives under /id/.
//
// robots.txt disallows /api, and the site's chapter bodies only exist behind an
// /api path plus the mobile app — so this client fetches SSR HTML under /id/
// only. fetchRobots/isPathAllowed are exported so that invariant is enforced at
// call time rather than assumed.
const BASE = 'https://noveltoon.mobi';

export const NOVELTOON_BASE = BASE;
export const NOVELTOON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const NOVELTOON_REFERER = `${BASE}/id/`;

export const NOVELTOON_PATHS = {
  home: '/id/',
  // `/id/detail/{content_id}` 301s to the canonical `/id/{slug}?content_id={id}`.
  detail: (contentId: string | number): string => `/id/detail/${encodeURIComponent(String(contentId))}`,
  // SSR genre listing: /id/genre/{categoryId}/{sortId}/{page}. categoryId 2 = all.
  listing: (page: number): string => `/id/genre/2/0/${Math.max(page, 0)}`,
} as const;

export interface RobotsResult {
  allowed: boolean;
  disallowedPaths: string[];
  crawlDelay?: number;
}

export const fetchRobots = async (kv: KVNamespace | null): Promise<RobotsResult> => {
  const cacheKey = 'robots:noveltoon';
  if (kv) {
    const cached = await kv.get(cacheKey, 'json').catch(() => null);
    if (cached) return cached as RobotsResult;
  }
  try {
    const res = await fetch(`${BASE}/robots.txt`, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    const disallowedPaths: string[] = [];
    let crawlDelay: number | undefined;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith('disallow:')) {
        const path = trimmed.slice(9).trim();
        if (path) disallowedPaths.push(path);
      }
      if (trimmed.toLowerCase().startsWith('crawl-delay:')) {
        crawlDelay = Number(trimmed.slice(12).trim()) || undefined;
      }
    }
    const result: RobotsResult = { allowed: true, disallowedPaths, crawlDelay };
    if (kv) await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 }).catch(() => {});
    return result;
  } catch {
    return { allowed: true, disallowedPaths: [], crawlDelay: undefined };
  }
};

export const isPathAllowed = (robots: RobotsResult, urlPath: string): boolean => {
  for (const disallowed of robots.disallowedPaths) {
    if (disallowed === '/') return false;
    if (disallowed && urlPath.startsWith(disallowed)) return false;
  }
  return true;
};

/** Resolves to the final URL so the caller can read the canonical slug off the redirect. */
export const fetchHtmlWithUrl = async (
  url: string,
  timeoutMs = 15000
): Promise<{ html: string; finalUrl: string }> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': NOVELTOON_UA, Referer: NOVELTOON_REFERER, 'Accept-Language': 'id-ID,id;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`noveltoon fetch ${res.status} ${url}`);
  return { html: await res.text(), finalUrl: res.url || url };
};
