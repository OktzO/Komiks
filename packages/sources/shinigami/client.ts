// Shinigami (11.shinigami.asia) HTTP client.
// The site itself is behind Cloudflare managed challenge (403 "Just a moment…"),
// but all data lives in a public JSON API at api.shngm.io — no challenge, no
// auth, no UA requirement. Adapter talks to the API only; the HTML site is
// never scraped.
import { drainResponse } from '@manga-platform/shared/http';

export const SHINIGAMI_BASE = 'https://11.shinigami.asia';
export const SHINIGAMI_API = 'https://api.shngm.io';

export const SHINIGAMI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface RobotsResult {
  allowed: boolean;
  disallowedPaths: string[];
  crawlDelay?: number;
}

// API envelope. `retcode` 0 = success; `data` shape varies per endpoint.
export interface ApiEnvelope<T> {
  retcode: number;
  message?: string;
  meta?: { page?: number; total_page?: number; total_record?: number };
  data: T;
}

export const fetchJson = async <T>(url: string, timeoutMs = 15000): Promise<T> => {
  const res = await fetch(url, {
    headers: {
      'User-Agent': SHINIGAMI_UA,
      'Accept': 'application/json',
      'Origin': SHINIGAMI_BASE,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    await drainResponse(res);
    throw new Error(`shinigami fetch ${res.status} ${url}`);
  }
  const env = await res.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!env || env.retcode !== 0 || env.data == null) {
    throw new Error(`shinigami api error (retcode=${env?.retcode}) ${url}`);
  }
  return env.data;
};

export const fetchRobots = async (kv: KVNamespace | null): Promise<RobotsResult> => {
  const cacheKey = 'robots:shinigami';
  if (kv) {
    const cached = await kv.get(cacheKey, 'json').catch(() => null);
    if (cached) return cached as RobotsResult;
  }
  // API has no robots.txt (404); the web site 403s bots entirely. Allow.
  const result: RobotsResult = { allowed: true, disallowedPaths: [], crawlDelay: undefined };
  if (kv) await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 }).catch(() => {});
  return result;
};

export const isPathAllowed = (robots: RobotsResult, urlPath: string): boolean => {
  for (const disallowed of robots.disallowedPaths) {
    if (disallowed === '/') return false;
    if (disallowed && urlPath.startsWith(disallowed)) return false;
  }
  return true;
};
