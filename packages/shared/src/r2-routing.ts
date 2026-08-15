// B2 multi-account routing — satu sumber kebenaran untuk hash, dipakai oleh
// scraper Worker (apps/api-cf). JANGAN re-implement di sisi lain; import dari
// sini agar tidak drift. Frontend tidak perlu hash routing lagi (B2 presigned
// langsung dari Worker), jadi tidak di-import dari apps/web.

// MurmurHash3 x86_32, pure JS, tanpa dependency. Deterministik lintas runtime
// (Worker + browser). seed default 0.
export function murmur3_32(key: string, seed = 0): number {
  const data = new TextEncoder().encode(key);
  const len = data.length;
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let i = 0;
  const blocks = len - (len % 4);
  for (; i < blocks; i += 4) {
    let k = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  let k = 0;
  const tail = len - blocks;
  if (tail >= 3) k ^= data[blocks + 2] << 16;
  if (tail >= 2) k ^= data[blocks + 1] << 8;
  if (tail >= 1) {
    k ^= data[blocks];
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// Key deterministik per source: {source}/{slug}/{chapterId}/{pageNo}.
// Format komiku lama (`komiku/{slug}/...`) identik — kompatibel penuh,
// key existing tetap valid.
export const b2KeyFor = (source: string, slug: string, chapterId: string, pageNo: number): string =>
  `${source}/${slug}/${chapterId}/${pageNo}`;
