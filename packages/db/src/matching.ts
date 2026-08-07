// Pure title-normalization + fuzzy matching for manga dedup.
// No DB, no network — unit-testable.

export interface MatchCandidate {
  id: number;
  title: string;
  alt_titles?: string[];
}

export type MatchResult =
  | { type: 'exact'; id: number }
  | { type: 'fuzzy'; id: number; score: number }
  | { type: 'queue'; candidateIds: number[]; confidence: number }
  | { type: 'new' };

const NOISE = /\b(season|chapter|vol|volume|full\s*color|special|indonesia)\b|[\s\-_.:()\[\]{}"']/g;

// Latin-aware normalize for fuzzy scoring. Non-ASCII (e.g. Korean titles)
// are preserved as-is; they rarely benefit from token noise-stripping.
export const normalizeTitle = (s: string): string => {
  const base = s.toLowerCase()
    .replace(/[^\w\s\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/g, '')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Strip trailing chapter number noise: "one piece 1100" → "one piece".
  return base.replace(/\s+\d+(\.\d+)?$/, '');
};

// Levenshtein distance.
export const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[b.length];
};

// Jaro-Winkler similarity, 0..1.
export const jaroWinkler = (a: string, b: string): number => {
  if (a === b) return 1;
  const aLen = a.length, bLen = b.length;
  if (!aLen || !bLen) return 0;
  const matchDist = Math.floor(Math.max(aLen, bLen) / 2) - 1;
  const aMatch = new Array<boolean>(aLen).fill(false);
  const bMatch = new Array<boolean>(bLen).fill(false);
  let matches = 0;
  for (let i = 0; i < aLen; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, bLen);
    for (let j = lo; j < hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < aLen; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / aLen + matches / bLen + (matches - transpositions / 2) / matches) / 3;
  // Winkler prefix boost (up to 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, aLen, bLen); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
};

export const FUZZY_THRESHOLD = 0.92;
export const AMBIGUITY_GAP = 0.05;

export const matchCandidate = (title: string, candidates: MatchCandidate[]): MatchResult => {
  const norm = normalizeTitle(title);
  if (!norm) return { type: 'new' };

  // 1. Exact normalized slug match (title or alt titles). Multiple exact
  // matches = real duplicates (same title in DB twice) → queue for review.
  const exact = candidates.filter(
    (c) => normalizeTitle(c.title) === norm
      || (c.alt_titles ?? []).some((a) => normalizeTitle(a) === norm)
  );
  if (exact.length === 1) return { type: 'exact', id: exact[0].id };
  if (exact.length > 1) return {
    type: 'queue',
    candidateIds: exact.slice(0, 2).map((c) => c.id),
    confidence: 1,
  };

  // 2. Fuzzy against title + alt titles, pick best.
  const scored: Array<{ id: number; score: number }> = [];
  for (const c of candidates) {
    const titles = [c.title, ...(c.alt_titles ?? [])];
    let best = 0;
    for (const t of titles) {
      const tn = normalizeTitle(t);
      if (!tn) continue;
      best = Math.max(best, jaroWinkler(norm, tn));
    }
    if (best >= FUZZY_THRESHOLD) scored.push({ id: c.id, score: best });
  }
  scored.sort((x, y) => y.score - x.score);
  if (scored.length === 0) return { type: 'new' };
  if (scored.length === 1) return { type: 'fuzzy', id: scored[0].id, score: scored[0].score };

  // 3. Ambiguous: top-2 within gap → manual queue.
  if (scored[0].score - scored[1].score <= AMBIGUITY_GAP) {
    return {
      type: 'queue',
      candidateIds: scored.slice(0, 2).map((s) => s.id),
      confidence: scored[0].score,
    };
  }
  return { type: 'fuzzy', id: scored[0].id, score: scored[0].score };
};