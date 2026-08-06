// Source adapter registry. `getAdapter(sourceKey, env?)` returns the adapter or null.
// `env` is forwarded to adapters that read runtime config (e.g. MANGADEX_API_KEY);
// omitting it yields keyless behavior (backwards-compatible).
import { mangadexAdapter } from './mangadex/index.js';
import { komikuAdapter } from './komiku/index.js';
import type { MangadexAdapter, AdapterEnv } from './mangadex/index.js';
import type { Series, Chapter } from '@manga-platform/shared';
import type { RobotsResult } from './komiku/client.js';

export type SourceKey = 'mangadex' | 'komiku';

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
  getChapter(chapterSourceId: string): Promise<Chapter>;
  fetchPageUrls(
    chapterSourceId: string
  ): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]>;
  scrapeUrl?(url: string): Promise<ScrapeResult>;
  checkRobots?(url: string): Promise<RobotsResult>;
  healthCheck?(): Promise<{ healthy: boolean; latency_ms: number; error?: string }>;
}

const adapterFactories: Record<SourceKey, (env?: AdapterEnv) => SourceAdapter> = {
  mangadex: (env) => mangadexAdapter(env) as unknown as SourceAdapter,
  komiku: (env) => komikuAdapter(env) as unknown as SourceAdapter
};

export const getAdapter = (sourceKey: string, env?: AdapterEnv): SourceAdapter | null =>
  (sourceKey in adapterFactories) ? adapterFactories[sourceKey as SourceKey](env) : null;

export { mangadexAdapter, komikuAdapter, type MangadexAdapter, type AdapterEnv };
