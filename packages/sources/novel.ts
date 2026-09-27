// Web-novel source adapter contract. Kept separate from the manga `SourceAdapter`
// in ./index.ts: novel chapters are prose (single html blob), not image pages.
import { novelidAdapter } from './novelid/index.js';
import { gooddreamerAdapter } from './gooddreamer/index.js';
import { noveltoonAdapter } from './noveltoon/index.js';

export type NovelSourceKey = 'novelid' | 'gooddreamer' | 'noveltoon';
export type NovelCapability = 'chapter' | 'metadata';

export interface NovelSeries {
  sourceSeriesId: string;
  source: NovelSourceKey;
  title: string;
  slug: string;
  author?: string | null;
  genres?: string[];
  status?: string | null;
  coverUrl?: string | null;
  synopsis?: string | null;
  chapterCount?: number | null;
}

export interface NovelChapterSummary {
  sourceChapterId: string;
  number: number;
  title?: string | null;
  sourceUrl?: string;
}

export interface NovelChapterContent {
  html: string;
}

export interface NovelSourceAdapter {
  sourceKey: NovelSourceKey;
  capability: NovelCapability;
  search(params: { q: string; limit?: number; offset?: number }): Promise<NovelSeries[]>;
  getSeries(sourceId: string): Promise<NovelSeries>;
  listChapters(sourceId: string, opts?: { limit?: number; offset?: number }): Promise<NovelChapterSummary[]>;
  // Absent on `capability: 'metadata'` sources. Coin-gated or app-only chapter
  // bodies have no public endpoint, so those adapters omit it entirely rather
  // than throwing at read time.
  getChapterContent?(sourceChapterId: string): Promise<NovelChapterContent>;
}

export const NOVEL_SOURCES: NovelSourceKey[] = ['novelid', 'gooddreamer', 'noveltoon'];

const novelAdapters: Partial<Record<NovelSourceKey, () => NovelSourceAdapter>> = {
  novelid: () => novelidAdapter() as unknown as NovelSourceAdapter,
  gooddreamer: () => gooddreamerAdapter() as unknown as NovelSourceAdapter,
  noveltoon: () => noveltoonAdapter() as unknown as NovelSourceAdapter,
};

export const getNovelAdapter = (key: string): NovelSourceAdapter | null => {
  const factory = novelAdapters[key as NovelSourceKey];
  return factory ? factory() : null;
};

/**
 * Bounded retry for novel upstream fetches.
 *
 * Local to packages/sources on purpose: `apps/api-cf/src/lib/retry.ts` sits
 * across the workspace boundary and manga adapters already get their retry from
 * the api-cf caller, while novel adapters are invoked directly and need their
 * own. Two attempts is deliberate — a novel source outage should surface fast
 * instead of tripling reader-request latency.
 */
export const withNovelRetry = async <T>(
  fn: () => Promise<T>,
  meta: { source: NovelSourceKey; entityId: string; stage: string },
  attempts = 2
): Promise<T> => {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      last = e;
    }
  }
  console.error(JSON.stringify({ ...meta, error: String(last) }));
  throw last;
};
