import { cache } from 'react';
import { getResolve, getSeriesDetail, type ResolveData } from '@/lib/api';

export const loadCanonical = cache(async (slug: string): Promise<{ resolved: ResolveData; detailPromise: Promise<Awaited<ReturnType<typeof getSeriesDetail>>>; chaptersPromise: Promise<Awaited<ReturnType<typeof import('@/lib/api').getChapters>>>; sourcesPromise: Promise<Awaited<ReturnType<typeof import('@/lib/api').getMangaSources>> | null> }> => {
  const { getChapters, getMangaSources } = await import('@/lib/api');
  const resolved = await getResolve(slug);
  const detailPromise = getSeriesDetail(resolved.source, resolved.sourceSlug, 'id');
  const chaptersPromise = getChapters(resolved.source, resolved.sourceSlug, 'id').catch(() => []);
  const sourcesPromise = getMangaSources(resolved.source, resolved.sourceSlug).catch(() => null);
  return { resolved, detailPromise, chaptersPromise, sourcesPromise };
});
