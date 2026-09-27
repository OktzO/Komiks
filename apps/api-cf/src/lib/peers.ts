import { murmur3_32 } from '@manga-platform/shared/r2-routing';
import { PeerInventorySchema, type PeerInventory } from '@manga-platform/shared/types';
import type { Env } from './context';

export interface PeerInfo {
  url: string;
  index: number;
  self: boolean;
}

export const INVALID_PEER_URLS = 'INVALID_PEER_URLS';

export class PeerConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PeerConfigError';
    this.code = code;
  }
}

const normalizePeerUrl = (raw: string): string => raw.replace(/\/+$/, '');

export const peerUrlOrigin = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

// Dynamic-N: tidak ada asumsi jumlah account. Daftar peer SELURUHNYA dari
// config (PEER_URLS [vars], comma-CSV, ordinal = index shard) — panjang apapun
// N >= 1 berlaku. N=1 = single peer (ownerFor selalu self); N=0 (kosong) = no-op
// self router. ⚠️ PEER_URLS harus IDENTIK di semua worker account, kalau tidak
// ownerFor hash-mismatch silent (lihat docs/DEPLOY.md).
//
// getPeers sengaja TIDAK melempar pada URL rusak: ini jalur hot routing
// (ownerFor/internalExec), config salah harus tetap melayani request. Validasi
// HTTP(S) ada di getTopology, jalur inventory/konfigurasi. Trailing slash
// dinormalkan supaya satu peer tidak terhitung dua kali.

export const getPeers = (env: Env): PeerInfo[] => {
  const raw = env.PEER_URLS as string | undefined;
  const urls = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(normalizePeerUrl);
  const deduped = [...new Set(urls)];
  const parsed = Number(env.PEER_INDEX ?? 0);
  const selfIndex = Number.isInteger(parsed) && parsed >= 0 && parsed < deduped.length ? parsed : -1;
  if (selfIndex === -1 && deduped.length > 0) {
    console.error(`[peers] invalid PEER_INDEX=${String(env.PEER_INDEX)} for ${deduped.length} peers — no self match (fail-safe: treat as non-self router)`);
  }
  if (deduped.length === 0) {
    console.warn('[peers] PEER_URLS kosong — single-peer no-op sharding (ownerFor selalu self)');
    return [];
  }
  if (deduped.length !== urls.length) {
    console.warn(`[peers] PEER_URLS berisi ${urls.length - deduped.length} duplikat — didedupe ke ${deduped.length} peer`);
  }
  return deduped.map((url, index) => ({ url, index, self: index === selfIndex }));
};

export interface TopologySnapshot {
  peers: PeerInfo[];
  count: number;
  hash: string;
}

const topologyHash = (peers: PeerInfo[]): string => {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(peers.map((p) => p.url).join('\n'))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
};

export const getTopology = (env: Env): TopologySnapshot => {
  const peers = getPeers(env);
  peers.forEach((peer, index) => {
    if (peerUrlOrigin(peer.url) === null) {
      throw new PeerConfigError(INVALID_PEER_URLS, `${INVALID_PEER_URLS} at index ${index}`);
    }
  });
  return { peers, count: peers.length, hash: topologyHash(peers) };
};

export interface RoutableTopology {
  snapshot: TopologySnapshot;
  malformed: boolean;
}

// Jalur publik (pool /api/origins) tidak boleh 500 karena satu entri config
// rusak: entri yang tidak bisa di-parse dijatuhkan, peer sisanya tetap
// dilayani dengan index shard aslinya supaya identitas routable tidak bergeser.
// `malformed` dipakai pemanggil untuk tidak meng-cache pool turunan config rusak.
export const getRoutableTopology = (env: Env): RoutableTopology => {
  try {
    return { snapshot: getTopology(env), malformed: false };
  } catch (error) {
    if (!(error instanceof PeerConfigError)) throw error;
    const configured = getPeers(env);
    const peers = configured.filter((peer) => peerUrlOrigin(peer.url) !== null);
    console.error(
      `[peers] ${error.code} — ${peers.length} dari ${configured.length} peer bisa diroutkan, entri rusak dilewati`
    );
    return { snapshot: { peers, count: peers.length, hash: topologyHash(peers) }, malformed: true };
  }
};

export type PeerFetchResult =
  | { ok: true; data: PeerInventory }
  | { ok: false; errorCode: string };

export const fetchPeerInventory = async (
  env: Env,
  peer: PeerInfo,
  refresh = false,
  signal?: AbortSignal
): Promise<PeerFetchResult> => {
  const key = forwardKey(env);
  if (!key) return { ok: false, errorCode: 'INTERNAL_KEY_MISSING' };
  try {
    const res = await fetch(`${peer.url}/api/_internal/admin/inventory${refresh ? '?refresh=1' : ''}`, {
      method: 'POST',
      headers: { 'x-db-forward-key': key },
      signal: signal ?? AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, errorCode: `PEER_HTTP_${res.status}` };
    const parsed = PeerInventorySchema.safeParse((await res.json() as { data: unknown }).data);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, errorCode: 'PEER_SCHEMA_INVALID' };
  } catch {
    return { ok: false, errorCode: 'PEER_UNREACHABLE' };
  }
};

export const ownerFor = (env: Env, key: string): PeerInfo => {
  const peers = getPeers(env);
  if (peers.length === 0) return { url: '', index: 0, self: true };
  return peers[murmur3_32(key) % peers.length];
};

export const backupOwnerFor = (env: Env, key: string): PeerInfo => {
  const peers = getPeers(env);
  if (peers.length < 2) return ownerFor(env, key);
  const owner = ownerFor(env, key);
  return peers[(owner.index + 1) % peers.length];
};

const forwardKey = (env: Env): string | undefined => env.DB_FORWARD_KEY as string | undefined;

// Write-forward to a peer worker's internal /db/exec. Returns false on
// missing key, missing peer, or non-2xx (caller falls back to local).
export const internalExec = async (
  env: Env,
  peerUrl: string,
  payload: { sql: string; params: unknown[]; table: string }
): Promise<boolean> => {
  const key = forwardKey(env);
  if (!key || !peerUrl) return false;
  try {
    const res = await fetch(`${peerUrl}/api/_internal/db/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-db-forward-key': key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

export type QueryResult<T> = { ok: true; rows: T[] } | { ok: false };

export const internalQueryEx = async <T = Record<string, unknown>>(
  env: Env,
  peerUrl: string,
  sql: string,
  params: unknown[],
  table: string
): Promise<QueryResult<T>> => {
  const key = forwardKey(env);
  if (!key || !peerUrl) return { ok: false };
  try {
    const res = await fetch(`${peerUrl}/api/_internal/db/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-db-forward-key': key },
      body: JSON.stringify({ sql, params, table }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as { results?: T[] };
    return { ok: true, rows: j.results ?? [] };
  } catch {
    return { ok: false };
  }
};

// Read-forward: SELECT via peer /db/query (allowlisted table). null = failure.
export const internalQuery = async <T = Record<string, unknown>>(
  env: Env,
  peerUrl: string,
  sql: string,
  params: unknown[],
  table: string
): Promise<T[] | null> => {
  const key = forwardKey(env);
  if (!key || !peerUrl) return null;
  try {
    const res = await fetch(`${peerUrl}/api/_internal/db/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-db-forward-key': key },
      body: JSON.stringify({ sql, params, table }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { results?: T[] };
    return j.results ?? null;
  } catch {
    return null;
  }
};

export const peerKvGet = async (env: Env, key: string): Promise<unknown | null> => {
  const k = forwardKey(env);
  if (!k) return null;
  const peers = getPeers(env).filter((p) => !p.self);
  if (peers.length === 0) return null;
  const results = await Promise.allSettled(
    peers.map(async (peer) => {
      const res = await fetch(`${peer.url}/api/_internal/kv/get?key=${encodeURIComponent(key)}`, {
        headers: { 'x-db-forward-key': k },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { value?: unknown };
      return j.value ?? null;
    })
  );
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value != null) return r.value;
  }
  return null;
};

// KV write-forward to every non-self peer (homepage feed push). Best-effort:
// returns true if at least one peer accepted the write; caller keeps its own
// local KV regardless.
export const peerKvSet = async (
  env: Env,
  key: string,
  value: string,
  expirationTtl?: number
): Promise<boolean> => {
  const k = forwardKey(env);
  if (!k) return false;
  const results = await Promise.allSettled(
    getPeers(env)
      .filter((p) => !p.self)
      .map((peer) =>
        fetch(`${peer.url}/api/_internal/kv/put`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-db-forward-key': k },
          body: JSON.stringify({ key, value, expirationTtl }),
          signal: AbortSignal.timeout(5000),
        }).then((r) => r.ok)
      )
  );
  return results.some((r) => r.status === 'fulfilled' && r.value);
};
