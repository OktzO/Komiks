// Webtoon (webtoons.com/id) HTTP client.
// Uses m.webtoons.com mobile API endpoints (no auth required for public data).
// Based on keiyoushi/extensions-source Webtoons.kt implementation.

export const WEBTOON_BASE = 'https://www.webtoons.com';
export const WEBTOON_MOBILE = 'https://m.webtoons.com';
export const WEBTOON_API = 'https://m.webtoons.com/api/v1';

export const WEBTOON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface WebtoonFetchEnv {
  MY_BROWSER?: Fetcher;
}

export interface RobotsResult {
  allowed: boolean;
  disallowedPaths: string[];
  crawlDelay?: number;
}

// Language code mapping
export const LANG_CODE = 'id'; // Indonesian

const CHALLENGE_INDICATORS = [
  'Just a moment',
  'cf-challenge',
  'cf-browser-verification',
  'challenge-platform',
  'ray-id',
  'cloudflare',
  'checking your browser',
  'please wait',
  'ddos-guard',
  'access denied',
];

const isChallenge = (res: Response, body: string): boolean => {
  if (res.status === 403 || res.status === 503) return true;
  const lowerBody = body.toLowerCase();
  return CHALLENGE_INDICATORS.some(indicator => lowerBody.includes(indicator.toLowerCase()));
};

const looksLikeSearchResults = (body: string): boolean => {
  // Check if the HTML contains expected search result markers
  return body.includes('class="link _card_item"') || 
         body.includes('title_no=') ||
         body.includes('<strong class="title">');
};

export const fetchHtml = async (url: string, env?: WebtoonFetchEnv, timeoutMs = 15000): Promise<string> => {
  const headers = { 
    'User-Agent': WEBTOON_UA, 
    'Referer': WEBTOON_BASE + '/', 
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cookie': 'ageGatePass=true; locale=id; needGDPR=false'
  };
  
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text().catch(() => '');
  
  if (!isChallenge(res, text) && looksLikeSearchResults(text)) {
    if (res.status >= 400) throw new Error(`webtoon fetch ${res.status} ${url}`);
    return text;
  }
  
  // If challenge detected or search results not found, try browser rendering
  if (env?.MY_BROWSER) {
    const browser = env.MY_BROWSER as unknown as {
      newPage(): Promise<{ goto(url: string, opts: object): Promise<{ status(): number } | null>; content(): Promise<string>; close(): Promise<void> }>;
    };
    const page = await browser.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      const html = await page.content();
      const status = resp?.status() ?? 0;
      if (status < 400 && html && !isChallenge(resp as unknown as Response, html) && looksLikeSearchResults(html)) {
        return html;
      }
    } finally {
      await page.close().catch(() => {});
    }
  }
  
  // If we got here, either no browser or browser also failed
  // Return the original text anyway - let the parser handle it
  if (res.status >= 400) throw new Error(`webtoon fetch ${res.status} ${url}`);
  return text;
};

export const fetchJson = async <T,>(url: string, timeoutMs = 10000): Promise<T | null> => {
  const headers = { 'User-Agent': WEBTOON_UA, 'Accept': 'application/json', 'Referer': WEBTOON_BASE + '/' };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status >= 400) throw new Error(`webtoon fetchJson ${res.status} ${url}`);
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

export const fetchRobots = async (): Promise<RobotsResult> => {
  try {
    const res = await fetch(`${WEBTOON_BASE}/robots.txt`, { signal: AbortSignal.timeout(5000) });
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
    return { allowed: true, disallowedPaths, crawlDelay };
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

// Extract title_no from URL
export const extractTitleNo = (url: string): string | null => {
  const match = url.match(/[?&]title_no=(\d+)/i);
  return match ? match[1] : null;
};

// Extract episode_no from URL
export const extractEpisodeNo = (url: string): string | null => {
  const match = url.match(/[?&]episode_no=(\d+)/i);
  return match ? match[1] : null;
};

// Build series URL from title_no, genre, slug
export const buildSeriesUrl = (titleNo: string, genre: string, slug: string): string =>
  `${WEBTOON_BASE}/id/${genre}/${slug}/list?title_no=${titleNo}`;

// Build episode URL from title_no, episode_no, genre, slug, ep_slug
export const buildEpisodeUrl = (titleNo: string, episodeNo: string, genre: string, slug: string, epSlug: string): string =>
  `${WEBTOON_BASE}/id/${genre}/${slug}/${epSlug}?title_no=${titleNo}&episode_no=${episodeNo}`;

// Search URL - use desktop site for search results
export const buildSearchUrl = (query: string, page: number, type?: string): string => {
  const base = `${WEBTOON_BASE}/${LANG_CODE}/search`;
  const params = new URLSearchParams({ keyword: query, page: String(page) });
  if (type) params.set('type', type);
  return `${base}?${params.toString()}`;
};

export const buildSeriesDetailUrl = (type: 'webtoon' | 'canvas', titleNo: string): string =>
  `${WEBTOON_API}/${type}/${titleNo}/episodes?pageSize=99999`;

export const buildEpisodeViewerUrl = (type: 'webtoon' | 'canvas', titleNo: string, episodeNo: string): string =>
  `${WEBTOON_API}/${type}/${titleNo}/episodes/${episodeNo}/viewer`;
