import { cache } from 'react';
import { cookies } from 'next/headers';
import { getResolve, getSeriesDetail, type ResolveData } from '@/lib/api';
import { chooseSource } from '@/lib/sourceChoice';
import type { SourceLink } from '@/lib/sourceChoice';

// Cookie preferensi source: { [canonicalSlug]: sourceKey }. Ditulis client
// (SourceSwitcher) saat user memilih source; dibaca di sini supaya pilihan
// itu benar-benar dipakai server render — bukan hanya highlight di client.
// Tanpa ini, navigasi ulang ke slug kanonik selalu kembali ke recommended
// → seolah "pindah source tidak bisa".
const PREF_COOKIE = 'src-prefs';

const readPrefFor = async (slug: string): Promise<string | null> => {
  try {
    const raw = (await cookies()).get(PREF_COOKIE)?.value;
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    return typeof map[slug] === 'string' ? map[slug] : null;
  } catch {
    return null;
  }
};

export const loadCanonical = cache(async (slug: string): Promise<{ resolved: ResolveData; detailPromise: Promise<Awaited<ReturnType<typeof getSeriesDetail>>>; chaptersPromise: Promise<Awaited<ReturnType<typeof import('@/lib/api').getChapters>>>; sourcesPromise: Promise<Awaited<ReturnType<typeof import('@/lib/api').getMangaSources>> | null> }> => {
  const { getChapters, getMangaSources } = await import('@/lib/api');
  const resolved = await getResolve(slug);

  // Pilihan user menang atas recommended — asal source-nya tersedia untuk
  // judul ini (punya daftar chapter). resolved.sources ikut dipakai so
  // halaman tidak pernah menampilkan source yang tidak punya datanya.
  const pref = await readPrefFor(resolved.slug);
  const links: SourceLink[] = (resolved.sources ?? []).map((s) => s as SourceLink);
  const picked = chooseSource(links, { recommended: resolved.recommendedSource, pref, current: resolved.source });
  const effective: ResolveData = picked
    ? { ...resolved, source: picked.source, sourceSlug: picked.sourceSlug }
    : resolved;

  const detailPromise = getSeriesDetail(effective.source, effective.sourceSlug, 'id');
  const chaptersPromise = getChapters(effective.source, effective.sourceSlug, 'id').catch(() => []);
  const sourcesPromise = getMangaSources(effective.source, effective.sourceSlug).catch(() => null);
  return { resolved: effective, detailPromise, chaptersPromise, sourcesPromise };
});
