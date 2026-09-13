import { getResolve, getSeriesDetail, getChapters, getMangaSources, type ResolveData, type Series, type Chapter } from '@/lib/api';
import { chooseSource, type SourceLink } from '@/lib/sourceChoice';

export type SeriesDetail = Series & { chapters: Chapter[] };

export interface SourceAgg {
  sources: Array<{ source: string; sourceSlug: string; hasChapterList: boolean; chapterCount: number }>;
  recommendedSource: string | null;
}

export interface CanonicalLoad {
  resolved: ResolveData;
  detail: SeriesDetail;
  chapters: Chapter[];
  sources: SourceAgg | null;
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

// Port loadCanonical (Next.js cache() + cookies()) ke Astro: dipanggil sekali
// per request dari frontmatter page, hasil objek plain — tanpa React cache().
export async function loadCanonical(slug: string, cookieHeader: string | undefined): Promise<CanonicalLoad> {
  const resolved = await getResolve(slug);

  // Pilihan user menang atas recommended — asal source-nya tersedia untuk
  // judul ini (punya daftar chapter). resolved.sources ikut dipakai so
  // halaman tidak pernah menampilkan source yang tidak punya datanya.
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
  const chapters = await getChapters(active.source, active.sourceSlug, 'id').catch(() => []);
  const sources = await getMangaSources(active.source, active.sourceSlug).catch(() => null);
  return { resolved: active, detail, chapters, sources };
}
