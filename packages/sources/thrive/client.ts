// Thrive.moe HTTP client: UA fetch + __NEXT_DATA__ extraction.
import { drainResponse } from '@manga-platform/shared/http';

export const THRIVE_BASE = 'https://thrive.moe';

export const THRIVE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface RobotsResult {
  allowed: boolean;
  disallowedPaths: string[];
  crawlDelay?: number;
}

// Extract pageProps from `<script id="__NEXT_DATA__">`. Returns null when absent.
export const parseNextData = <T>(html: string): T | null => {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return parsed?.props?.pageProps ?? null;
  } catch {
    return null;
  }
};

export const fetchHtml = async (url: string, timeoutMs = 15000): Promise<string> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': THRIVE_UA, 'Referer': THRIVE_BASE + '/' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) { await drainResponse(res); throw new Error(`thrive fetch ${res.status} ${url}`); }
  return res.text();
};

export const fetchRobots = async (kv: KVNamespace | null): Promise<RobotsResult> => {
  const cacheKey = 'robots:thrive';
  if (kv) {
    const cached = await kv.get(cacheKey, 'json').catch(() => null);
    if (cached) return cached as RobotsResult;
  }
  try {
    const res = await fetch(`${THRIVE_BASE}/robots.txt`, { signal: AbortSignal.timeout(5000) });
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
