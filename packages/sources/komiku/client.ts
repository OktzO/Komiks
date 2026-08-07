// Komiku HTTP client: robots.txt fetch + raw HTML fetch (no puppeteer for static pages).
const BASE = 'https://komiku.org';

export interface RobotsResult {
  allowed: boolean;
  disallowedPaths: string[];
  crawlDelay?: number;
}

export const fetchRobots = async (kv: KVNamespace | null): Promise<RobotsResult> => {
  const cacheKey = 'robots:komiku';
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
    // If robots.txt unreachable, assume allowed (standard behavior).
    return { allowed: true, disallowedPaths: [], crawlDelay: undefined };
  }
};

export const isPathAllowed = (robots: RobotsResult, urlPath: string): boolean => {
  for (const disallowed of robots.disallowedPaths) {
    if (disallowed === '/' ) return false;
    if (disallowed && urlPath.startsWith(disallowed)) return false;
  }
  return true;
};

export const KOMIKU_BASE = BASE;
