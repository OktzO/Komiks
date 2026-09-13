import { getResolve, getSeriesDetail, getChapters, getMangaSources, type ResolveData, type Series, type Chapter } from '@/lib/api';
import { chooseSource, type SourceLink } from '@/lib/sourceChoice';

export type SeriesDetail = Series & { chapters: Chapter[] };

export interface SourceAgg {
  sources: Array<{ source: string; sourceSlug: string; hasChapterList: boolean; chapterCount: number }>;
  recommendedSource: string | null;
}

// Cookie preferensi source: { [canonicalSlug]: sourceKey }. Ditulis client
// (SourceSwitcher) saat user memilih source; dibaca di sini supaya pilihan
// itu benar-benar dipakai server render — bukan hanya highlight di client.
// Tanpa ini, navigasi ulang ke slug kanonik selalu kembali ke recommended
// → seolah "pindah source tidak bisa".
const PREF_COOKIE = 'src-prefs';

const readPrefFor = (cookieHeader: string | undefined, slug: string): string | null => {
  try {
    if (!cookieHeader) return null;
    const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${PREF_COOKIE}=([^;]*)`));
    if (!m) return null;
    const map = JSON.parse(decodeURIComponent(m[1])) as Record<string, string>;
    return typeof map[slug] === 'string' ? map[slug] : null;
  } catch {
    return null;
  }
};

// ⭐ Async-first (pengganti streaming Suspense Next.js): frontmatter page cuma
// await resolve + series detail (cepat, KV-warm) — chapters & sources DIBERI
// TENGGAH (budget ms). Yang pulang dalam budget di-SSR (SEO link utuh); yang
// telat diselesaikan island client-side → chapter list "nyusul" tanpa menahan
// hero/sinopsis tampil.
export interface CanonicalQuick {
  resolved: ResolveData;
  detail: SeriesDetail;
  chapters: Chapter[] | null;
  sources: SourceAgg | null;
  chaptersPromise: Promise<Chapter[]>;
  sourcesPromise: Promise<SourceAgg | null>;
}

const withBudget = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);

export async function loadCanonicalQuick(slug: string, cookieHeader: string | undefined, budget = 250): Promise<CanonicalQuick> {
  const resolved = await getResolve(slug);

  const pref = readPrefFor(cookieHeader, resolved.slug);
  const links: SourceLink[] = (resolved.sources ?? []).map((s) => s as SourceLink);
  const picked = chooseSource(links, { recommended: resolved.recommendedSource, pref, current: resolved.source });
  const effective: ResolveData = picked
    ? { ...resolved, source: picked.source, sourceSlug: picked.sourceSlug }
    : resolved;

  // Probe: source pilihan user bisa sedang down/502 (Komiku sering kena
  // DDoS-guard). Kalau gagal → jangan 404: pakai source default dari API.
  const probe = await getSeriesDetail(effective.source, effective.sourceSlug, 'id').catch(() => null);
  const fallbackToDefault =
    probe === null && (effective.source !== resolved.source || effective.sourceSlug !== resolved.sourceSlug);
  const active = fallbackToDefault ? resolved : effective;

  const detail = probe !== null
    ? probe
    : await getSeriesDetail(active.source, active.sourceSlug, 'id');

  const chaptersPromise = getChapters(active.source, active.sourceSlug, 'id');
  const sourcesPromise = getMangaSources(active.source, active.sourceSlug);
  const [chapters, sources] = await Promise.all([
    withBudget(chaptersPromise, budget),
    withBudget(sourcesPromise, budget),
  ]);
  return { resolved: active, detail, chapters, sources, chaptersPromise, sourcesPromise };
}
