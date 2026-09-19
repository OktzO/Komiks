// BacaKomik.my HTTP client. Cloudflare Bot Fight blocks plain curl; hybrid
// strategy: plain fetch first, Puppeteer (MY_BROWSER) fallback on 403.
export const BACA_BASE = 'https://bacakomik.my';

export const BACA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface RobotsResult {
  allowed: boolean;
  disallowedPaths: string[];
  crawlDelay?: number;
}

export interface BacaFetchEnv {
  MY_BROWSER?: Fetcher;
}

const isChallenge = (res: Response, body: string): boolean =>
  res.status === 403 || body.includes('Just a moment') || body.includes('cf-challenge');

// Fetch HTML. Tries plain fetch first; on Cloudflare challenge (403 / bot
// check) falls back to remote browser (MY_BROWSER Puppeteer binding).
export const fetchHtml = async (url: string, env?: BacaFetchEnv, timeoutMs = 15000): Promise<string> => {
  const headers = { 'User-Agent': BACA_UA, 'Referer': BACA_BASE + '/', 'Accept': 'text/html' };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text().catch(() => '');
  if (!isChallenge(res, text)) {
    // Non-challenge HTTP errors (404 etc.) must throw: parsing a "Page not
    // found" body produced phantom Series that got persisted to D1.
    if (res.status >= 400) throw new Error(`bacakomik fetch ${res.status} ${url}`);
    return text;
  }

  // Fallback: remote browser rendering (Cloudflare Workers browser binding).
  if (env?.MY_BROWSER) {
    // Fetcher typing doesn't expose the Puppeteer API; the binding is a
    // Cloudflare Browser Binding with newPage(). Cast is intentional.
    const browser = env.MY_BROWSER as unknown as {
      newPage(): Promise<{ goto(url: string, opts: object): Promise<{ status(): number } | null>; content(): Promise<string>; close(): Promise<void> }>;
    };
    const page = await browser.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      const html = await page.content();
      const status = resp?.status() ?? 0;
      if (status < 400 && html && !html.includes('Just a moment')) return html;
    } finally {
      await page.close().catch(() => {});
    }
  }
  throw new Error(`bacakomik fetch ${res.status} ${url}`);
};

export const fetchRobots = async (kv: KVNamespace | null): Promise<RobotsResult> => {
  const cacheKey = 'robots:bacakomik';
  if (kv) {
    const cached = await kv.get(cacheKey, 'json').catch(() => null);
    if (cached) return cached as RobotsResult;
  }
  try {
    const res = await fetch(`${BACA_BASE}/robots.txt`, { signal: AbortSignal.timeout(5000) });
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