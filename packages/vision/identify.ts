import { hashImage } from './phash.js';
import { hammingDistance } from './hamming.js';

export interface Candidate {
  series_slug: string;
  confidence: number;
  match_type: 'phash';
  r2_key: string | null;
}

export interface ImageHashRow {
  series_slug: string;
  hash: string;
  r2_key: string | null;
}

const THRESHOLD = 8; // max Hamming distance for a match

export const identifyImage = async (
  imageBytes: Uint8Array,
  imageType: string,
  hashes: ImageHashRow[]
): Promise<{ candidates: Candidate[]; computedHash: string }> => {
  const computedHash = await hashImage(imageBytes, imageType);
  const candidates: Candidate[] = [];
  for (const row of hashes) {
    const dist = hammingDistance(computedHash, row.hash);
    if (dist <= THRESHOLD) {
      candidates.push({
        series_slug: row.series_slug,
        confidence: 1 - dist / 64,
        match_type: 'phash',
        r2_key: row.r2_key,
      });
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  return { candidates, computedHash };
};
