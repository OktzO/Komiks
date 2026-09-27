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

// --------------------------------------------------------------------------
// Consistent-hash ring (capability, TIDAK di-wire ke routing live).
//
// Live routing tetap `murmur3_32 % N` (lihat `apps/api-cf/src/lib/peers.ts`
// ownerFor/backupOwnerFor + `b2Config.ts` pickB2AccountIdx): zero behavior
// change, zero silent remap. Sesi di-shard per user_id via ownerFor dan
// fail-closed (row owner tak ada = treat as revoked → force logout semua
// user + bookmark/history hilang, tak self-healing); B2 objects sudah
// ter-upload di posisi `murmur3 % N` → ring-wiring remap semua /img → B2
// miss → re-download source CDN (risiko 429) + re-upload storm. Karena itu
// ring TIDAK dijadikan picker live.
//
// Ring ini adalah capability teruji (N=1/2/5) utk wiring masa depan via
// COORDINATED deploy: semua worker pakai buildRing yg IDENTIK (vnodesPerNode
// default sama + urutan account sama), deploy serentak, dan ada heal path
// utk owner-mapping yg berubah (sessions: coordinated migration / force
// re-login; B2: read-miss re-upload) — bukan silent. Selama belum ada
// coordinated deploy, routing live TETAP `% N`.
// --------------------------------------------------------------------------

export interface RingNode {
  /** Posisi hash (murmur3_32 dari `node:{accountIndex}:{vnode}`) pada ring. */
  pos: number;
  /** Index account target ([0, accounts.length)). */
  accountIndex: number;
}

export interface Ring {
  /** Ring point terurut ascending by pos; kosong saat accounts = []. */
  nodes: RingNode[];
  /** Jumlah vnode per account yang dipakai saat build. */
  vnodesPerNode: number;
}

const RING_NODE_KEY = (accountIndex: number, vnode: number): string => `node:${accountIndex}:${vnode}`;

/**
 * Bangun ring consistent-hash dari daftar account (N-agnostik).
 *
 * - N=0 → `{ nodes: [], vnodesPerNode }` (ringPick → -1).
 * - N=1 → satu account; semua key → account 0 (ringPick → 0). Setara
 *   `murmur3_32 % 1` (byte-identical dengan routing single-account).
 * - N≥2 → vnodesPerNode vnode per account, pos = murmur3_32(`node:{i}:{v}`),
 *   dedupe, sort ascending (tie-break by accountIndex lalu vnode, tetap
 *   deterministik), identik di semua caller dengan input sama.
 *
 * Deterministik lintas-runtime (murmur3_32 murni, tanpa dependency).
 */
export const buildRing = (accounts: readonly string[], vnodesPerNode = 32): Ring => {
  if (accounts.length === 0) return { nodes: [], vnodesPerNode };
  if (accounts.length === 1) {
    const nodes: RingNode[] = [];
    for (let v = 0; v < vnodesPerNode; v++) {
      nodes.push({ pos: murmur3_32(RING_NODE_KEY(0, v)), accountIndex: 0 });
    }
    return { nodes: sortRingNodes(nodes), vnodesPerNode };
  }
  const nodes: RingNode[] = [];
  for (let i = 0; i < accounts.length; i++) {
    for (let v = 0; v < vnodesPerNode; v++) {
      nodes.push({ pos: murmur3_32(RING_NODE_KEY(i, v)), accountIndex: i });
    }
  }
  return { nodes: sortRingNodes(nodes), vnodesPerNode };
};

const sortRingNodes = (nodes: RingNode[]): RingNode[] =>
  [...nodes]
    .sort((a, b) => (a.pos === b.pos ? a.accountIndex - b.accountIndex : a.pos - b.pos))
    .filter((n, i, arr) => i === 0 || !(n.pos === arr[i - 1].pos && n.accountIndex === arr[i - 1].accountIndex));

/**
 * Pick account index utk sebuah key dari ring (consistent-hash).
 * Binary search atas pos terurut; wrap ke ujung. Kosong → -1.
 *
 * Deterministik: ring sama + key sama → index sama. Balance: murmur3_32
 * uniform → vnode pos uniform → tiap account proporsional (vnodesPerNode
 * cukup besar utk distribusi halus).
 */
export const ringPick = (ring: Ring, key: string): number => {
  if (ring.nodes.length === 0) return -1;
  const h = murmur3_32(key);
  let lo = 0;
  let hi = ring.nodes.length - 1;
  // cari first node dengan pos >= h
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ring.nodes[mid].pos < h) lo = mid + 1;
    else hi = mid;
  }
  if (ring.nodes[lo].pos >= h) return ring.nodes[lo].accountIndex;
  return ring.nodes[0].accountIndex; // wrap-around
};
