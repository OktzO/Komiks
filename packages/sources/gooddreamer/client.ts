// gooddreamer.id HTTP client. Public Laravel JSON API under /api/web — robots.txt
// there is fully permissive (`Disallow:` empty), so no path gate is needed.
import { drainResponse } from '@manga-platform/shared/http';

export const GOODDREAMER_API_BASE = 'https://api.gooddreamer.id';
export const GOODDREAMER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const GOODDREAMER_REFERER = 'https://gooddreamer.id/';

export const GOODDREAMER_PATHS = {
  novels: '/api/web/novels',
  novel: (idOrUri: string | number): string => `/api/web/novels/${encodeURIComponent(String(idOrUri))}`,
  categories: '/api/web/categories',
  tags: '/api/web/tags',
} as const;

export const fetchJson = async <T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
  timeoutMs = 15000
): Promise<T> => {
  const url = new URL(path, GOODDREAMER_API_BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': GOODDREAMER_UA, Referer: GOODDREAMER_REFERER, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    await drainResponse(res);
    throw new Error(`gooddreamer fetch ${res.status} ${url.pathname}`);
  }
  return res.json() as Promise<T>;
};

/**
 * Upstream emits `https://api.gooddreamer.id//storage/...` — a doubled slash that
 * some CDNs 404 on. Collapse every run after the scheme back to one.
 */
export const normalizeMediaUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^(https?:)\/{2,}/i, '$1//').replace(/([^:])\/{2,}/g, '$1/');
};
