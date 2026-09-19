// Source adapter registry. `getAdapter(sourceKey, env?)` returns the adapter or null.
// `env` is forwarded to adapters that read runtime config; omitting it yields
// keyless behavior (backwards-compatible).
import { komikuAdapter } from './komiku/index.js';
import { bacakomikAdapter } from './bacakomik/index.js';
import { thriveAdapter } from './thrive/index.js';
import { manhwaindoAdapter } from './manhwaindo/index.js';
import { shinigamiAdapter } from './shinigami/index.js';
import { webtoonAdapter } from './webtoon/index.js';
import type { AdapterEnv } from './komiku/index.js';
import type { Series, Chapter } from '@manga-platform/shared';
import type { RobotsResult } from './komiku/client.js';

export type SourceKey = 'komiku' | 'bacakomik' | 'thrive' | 'manhwaindo' | 'shinigami' | 'webtoon';

export interface ScrapeResult {
  series: Series;
  chapters: Chapter[];
  coverImageUrl: string | null;
}

export interface SourceAdapter {
  sourceKey: SourceKey;
  search(params: { q: string; limit?: number; offset?: number }): Promise<Series[]>;
  getSeries(sourceId: string): Promise<Series>;
  listChapters(sourceId: string, opts?: { lang?: string; chapter?: string }): Promise<Chapter[]>;
  // Single-fetch detail: returns both series + chapters from ONE upstream request.
  // Replaces the Promise.all([getSeries, listChapters]) pattern that double-fetched
  // the same detail-page URL and triggered intermittent 502s from Komiku's
  // DDoS-guard edge on parallel requests.
  getSeriesDetail?(sourceId: string, opts?: { lang?: string }): Promise<{ series: Series; chapters: Chapter[] }>;
  getChapter(chapterSourceId: string): Promise<Chapter>;
  fetchPageUrls(
    chapterSourceId: string
  ): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]>;
  scrapeUrl?(url: string): Promise<ScrapeResult>;
  checkRobots?(url: string): Promise<RobotsResult>;
  healthCheck?(): Promise<{ healthy: boolean; latency_ms: number; error?: string }>;
}

const adapterFactories: Partial<Record<SourceKey, (env?: AdapterEnv) => SourceAdapter>> = {
  komiku: (env) => komikuAdapter(env),
  bacakomik: (env) => bacakomikAdapter(env) as unknown as SourceAdapter,
  thrive: (env) => thriveAdapter(env) as unknown as SourceAdapter,
  manhwaindo: (env) => manhwaindoAdapter(env) as unknown as SourceAdapter,
  shinigami: () => shinigamiAdapter() as unknown as SourceAdapter,
  webtoon: (env) => webtoonAdapter(env) as unknown as SourceAdapter,
};

export const getAdapter = (sourceKey: string, env?: AdapterEnv): SourceAdapter | null => {
  const factory = adapterFactories[sourceKey as SourceKey];
  return factory ? factory(env) : null;
};

export { komikuAdapter, bacakomikAdapter, thriveAdapter, manhwaindoAdapter, shinigamiAdapter, webtoonAdapter, type AdapterEnv };
