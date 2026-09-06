import { murmur3_32 } from '@manga-platform/shared/r2-routing';
import type { Env } from './context';

export interface PeerInfo {
  url: string;
  index: number;
  self: boolean;
}

export const EXPECTED_PEER_COUNT = 4;

export const getPeers = (env: Env): PeerInfo[] => {
  const raw = env.PEER_URLS as string | undefined;
  const urls = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const deduped = [...new Set(urls)];
  const parsed = Number(env.PEER_INDEX ?? 0);
  const selfIndex = Number.isInteger(parsed) && parsed >= 0 && parsed < deduped.length ? parsed : -1;
  if (selfIndex === -1 && deduped.length > 0) {
    console.error(`[peers] invalid PEER_INDEX=${String(env.PEER_INDEX)} for ${deduped.length} peers — no self match (fail-safe: treat as non-self router)`);
  }
  if (deduped.length !== 0 && deduped.length !== EXPECTED_PEER_COUNT) {
    console.error(`[peers] PEER_URLS length=${deduped.length}, expected ${EXPECTED_PEER_COUNT} — sharding mismatch risk across accounts`);
  }
  return deduped.map((url, index) => ({ url, index, self: index === selfIndex }));
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
