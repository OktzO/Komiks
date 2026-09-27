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
  // Whole-catalogue page walk, for sources that have one. `search` is a keyword
  // endpoint — on novelid it substring-matches titles, so a catalogue harvested
  // through it can only ever find novels a reader could already name. Discovery
  // uses this instead, and falls back to `search` keywords only where it is
  // absent, so an unlisted source is a visible no-op rather than a silent one.
  browse?(params: { limit?: number; offset?: number }): Promise<NovelSeries[]>;
  getSeries(sourceId: string): Promise<NovelSeries>;
  listChapters(sourceId: string, opts?: { limit?: number; offset?: number }): Promise<NovelChapterSummary[]>;
  // Absent on `capability: 'metadata'` sources. Coin-gated or app-only chapter
  // bodies have no public endpoint, so those adapters omit it entirely rather
  // than throwing at read time.
  getChapterContent?(sourceChapterId: string): Promise<NovelChapterContent>;
}

export const NOVEL_SOURCES: NovelSourceKey[] = ['novelid', 'gooddreamer', 'noveltoon'];

/** What a novel adapter needs from the Worker. `KV` is the robots.txt cache —
 *  without it every single page fetch re-requests robots.txt, which doubles the
 *  subrequests a long chapter refresh spends. */
export interface NovelAdapterEnv {
  KV?: KVNamespace;
}

const novelAdapters: Partial<Record<NovelSourceKey, (env?: NovelAdapterEnv) => NovelSourceAdapter>> = {
  novelid: (env) => novelidAdapter(env) as unknown as NovelSourceAdapter,
  gooddreamer: () => gooddreamerAdapter() as unknown as NovelSourceAdapter,
  noveltoon: (env) => noveltoonAdapter(env) as unknown as NovelSourceAdapter,
};

export const getNovelAdapter = (key: string, env?: NovelAdapterEnv): NovelSourceAdapter | null => {
  const factory = novelAdapters[key as NovelSourceKey];
  return factory ? factory(env) : null;
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

/**
 * Log-and-throw for failures raised *after* a successful fetch — a missing
 * title, a chapter body that turned into a login wall, an upstream redesign.
 * `withNovelRetry` only sees errors from inside its closure, so without this a
 * silent 200-with-no-prose would never appear in Worker logs.
 *
 * Returns the Error so call sites read `throw novelFailure(...)`.
 */
export const novelFailure = (
  source: NovelSourceKey,
  entityId: string,
  stage: string,
  detail: string
): Error => {
  const error = `${source} ${stage}: ${detail}`;
  console.error(JSON.stringify({ source, entityId, stage, error }));
  return new Error(error);
};
