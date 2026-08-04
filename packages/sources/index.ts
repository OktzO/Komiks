// Source adapter registry. `getAdapter(sourceKey)` returns the adapter or null.
import { mangadexAdapter } from './mangadex/index.js';
import type { MangadexAdapter } from './mangadex/index.js';
import type { Series, Chapter } from '@manga-platform/shared';

export type SourceKey = 'mangadex';

export interface SourceAdapter {
  sourceKey: SourceKey;
  search(params: { q: string; limit?: number; offset?: number }): Promise<Series[]>;
  listChapters(sourceId: string, opts?: { lang?: string; chapter?: string }): Promise<Chapter[]>;
  getChapter(chapterSourceId: string): Promise<Chapter>;
  fetchPageUrls(
    chapterSourceId: string
  ): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]>;
}

const adapters: Record<SourceKey, SourceAdapter> = {
  mangadex: mangadexAdapter as unknown as SourceAdapter
};

export const getAdapter = (sourceKey: string): SourceAdapter | null =>
  (sourceKey in adapters) ? adapters[sourceKey as SourceKey] : null;

export { mangadexAdapter, type MangadexAdapter };
