// novelid.org HTTP client: robots.txt fetch + raw HTML fetch.
// Robots helpers mirror komiku/client.ts — same caching shape, same
// fail-open behaviour.
const BASE = 'https://novelid.org';

export const NOVELID_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const NOVELID_REFERER = `${BASE}/`;

export interface RobotsResult {
  allowed: boolean;
  disallowedPaths: string[];
  crawlDelay?: number;
}

export const fetchRobots = async (kv: KVNamespace | null): Promise<RobotsResult> => {
  const cacheKey = 'robots:novelid';
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
    if (disallowed === '/') return false;
    if (disallowed && urlPath.startsWith(disallowed)) return false;
  }
  return true;
};

export const fetchHtml = async (url: string, timeoutMs = 15000): Promise<string> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': NOVELID_UA, Referer: NOVELID_REFERER, 'Accept-Language': 'id-ID,id;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`novelid fetch ${res.status} ${url}`);
  return res.text();
};

export const NOVELID_BASE = BASE;
