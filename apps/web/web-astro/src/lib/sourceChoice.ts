// Satu sumber kebenaran untuk "source mana yang dipakai/tampil" di seluruh UI.
//
// Urutan keputusan (deterministik, sama di server & client):
//   1. Pilihan user (pref) — tapi hanya kalau source itu punya daftar chapter
//   2. recommendedSource dari API (chapter terbanyak → terbaru → bobot)
//   3. Source yang sedang dipakai (current)
//   4. Chapter terbanyak → urutan SOURCE_ORDER
import { SOURCE_ORDER } from '@/components/SourceBadge';

export interface SourceLink {
  source: string;
  sourceSlug: string;
  hasChapterList: boolean;
  chapterCount: number;
}

/** Urutan tetap lintas surface: ikut SOURCE_ORDER, bukan urutan array API. */
export const orderedSources = (links: SourceLink[]): SourceLink[] => {
  const out: SourceLink[] = [];
  for (const s of SOURCE_ORDER) {
    const hit = links.find((l) => l.source === s);
    if (hit) out.push(hit);
  }
  for (const l of links) if (!out.includes(l)) out.push(l);
  return out;
};

export const chooseSource = (
  links: SourceLink[] | undefined | null,
  opts: { recommended?: string | null; pref?: string | null; current?: string | null } = {}
): SourceLink | null => {
  if (!links || links.length === 0) return null;
  const withList = links.filter((l) => l.hasChapterList);
  const pool = withList.length > 0 ? withList : links;
  const find = (s?: string | null) => (s ? pool.find((l) => l.source === s) ?? null : null);

  const byPref = find(opts.pref);
  if (byPref) return byPref;
  const byRec = find(opts.recommended);
  if (byRec) return byRec;
  const byCurrent = find(opts.current);
  if (byCurrent) return byCurrent;

  const max = pool.reduce((best, l) => ((l.chapterCount ?? 0) > (best.chapterCount ?? 0) ? l : best), pool[0]);
  return max ?? null;
};
