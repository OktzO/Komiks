// R2 multi-account routing — satu sumber kebenaran untuk hash, dipakai oleh
// scraper Worker (apps/api-cf) DAN frontend Pages (apps/web). JANGAN
// re-implement di sisi lain; import dari sini agar tidak drift.

export interface RingNode {
  pos: number;
  accountIndex: number;
}

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

// Consistent hashing ring: tiap akun diwakili `vnodes` titik di ring 2^32.
// Trade-off vs modulo polos: nambah/kurang akun cuma meremap key antara node
// baru dan tetangganya (~1/N bagian), bukan hampir semua. Harga: sedikit CPU
// + distribusi bergantung vnodes (semakin besar semakin merata, makin besar
// juga struktur ring).
export function buildRing(accounts: readonly string[], vnodes = 32): RingNode[] {
  if (accounts.length === 0) throw new Error('no accounts configured');
  const ring: RingNode[] = [];
  for (let a = 0; a < accounts.length; a++) {
    for (let v = 0; v < vnodes; v++) {
      ring.push({ pos: murmur3_32(`${accounts[a]}#${v}`), accountIndex: a });
    }
  }
  return ring.sort((x, y) => x.pos - y.pos);
}

// Key → index akun. Bangun ring sekali per request/halaman, lalu panggil ini
// per key — jangan panggil buildRing per key (O(N·vnodes·log) per call).
export function accountFor(key: string, ring: RingNode[]): number {
  if (ring.length === 0) throw new Error('empty ring');
  const h = murmur3_32(key);
  // Binary search node pertama >= h; wrap ke node pertama kalau lewat ujung.
  let lo = 0;
  let hi = ring.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ring[mid].pos >= h) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ring[found === -1 ? 0 : found].accountIndex;
}

// Key deterministik per source: {source}/{slug}/{chapterId}/{pageNo}.
// Format komiku lama (`komiku/{slug}/...`) identik — kompatibel penuh,
// key R2 existing tetap valid. Hash ring tetap dari slug (akun mapping
// per series tidak berubah saat source bertambah).
export const r2KeyFor = (source: string, slug: string, chapterId: string, pageNo: number): string =>
  `${source}/${slug}/${chapterId}/${pageNo}`;

// Utilitas migrasi manual: daftar key yang pindah akun saat jumlah akun
// berubah. Jalankan offline (script), bukan runtime. Key yang pindah akan
// di-re-fetch otomatis via cache-aside — tidak perlu aksi manual.
export function generateRemapReport(
  keys: readonly string[],
  oldAccounts: readonly string[],
  newAccounts: readonly string[],
  vnodes = 32
): Array<{ key: string; from: number; to: number }> {
  const oldRing = buildRing(oldAccounts, vnodes);
  const newRing = buildRing(newAccounts, vnodes);
  const report: Array<{ key: string; from: number; to: number }> = [];
  for (const key of keys) {
    const from = accountFor(key, oldRing);
    const to = accountFor(key, newRing);
    if (from !== to) report.push({ key, from, to });
  }
  return report;
}