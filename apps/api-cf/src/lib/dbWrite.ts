import type { Context, Env } from './context';
import { getPeers, internalExec } from './peers';

const OUTBOX_CAP = 1000;
const OUTBOX_TTL_DAYS = 7;

const OVERFLOW_FLAG_KEY = 'd1:overflow';
const USAGE_KEY = 'd1:usage';
const OVERFLOW_THRESHOLD_BYTES = 400 * 1024 * 1024; // 400MB hard cap — well below 10GB limit

export interface WriteResult {
  ok: boolean;
  target: 'local' | 'overflow';
  error?: string;
  changes?: number;
}

// Tracks D1 usage in shared KV (per-worker-account). Used to detect when this
// account's D1 is getting full and writes should overflow to the other account.
// Called after successful write — purely advisory, doesn't gate writes.
export const trackWriteSize = async (
  c: Context,
  table: string,
  bytes: number
): Promise<{ overflow: boolean; total: number }> => {
  try {
    const current = await c.env.CACHE_KV.get(USAGE_KEY, { type: 'json' }) as { bytes: number; per_table: Record<string, number> } | null;
    const bytes0 = (current?.bytes ?? 0) + bytes;
    const perTable = current?.per_table ?? {};
    perTable[table] = (perTable[table] ?? 0) + bytes;
    const overflow = bytes0 > OVERFLOW_THRESHOLD_BYTES;
    // TTL 7 days — usage data is advisory, no need to persist forever.
    await c.env.CACHE_KV.put(USAGE_KEY, JSON.stringify({ bytes: bytes0, per_table: perTable }), { expirationTtl: 604800 });
    if (overflow) {
      // TTL 7 days for overflow flag as well.
      await c.env.CACHE_KV.put(OVERFLOW_FLAG_KEY, JSON.stringify({ at: Date.now(), bytes: bytes0 }), { expirationTtl: 604800 });
    }
    return { overflow, total: bytes0 };
  } catch {
    return { overflow: false, total: 0 };
  }
};

// Returns true if THIS account should overflow (its D1 is full).
// Used by akun-1 to decide: write to local DB or forward to akun-2.
export const isOverflowing = async (c: Context): Promise<boolean> => {
  try {
    const usage = await c.env.CACHE_KV.get(USAGE_KEY, { type: 'json' }) as { bytes: number } | null;
    if (!usage) return false;
    return usage.bytes > OVERFLOW_THRESHOLD_BYTES;
  } catch {
    return false;
  }
};

// Forward a write to the other account's Worker via internal HTTP endpoint.
// Requires secret DB_FORWARD_ENDPOINT + DB_FORWARD_KEY set in this Worker.
// Used by akun-1 when its DB is full → forward to akun-2 (or vice versa).
const forwardWrite = async (
  c: Context,
  payload: { sql: string; params: unknown[]; table: string; bytes: number }
): Promise<boolean> => {
  const endpoint = c.env.DB_FORWARD_ENDPOINT as string | undefined;
  const key = c.env.DB_FORWARD_KEY as string | undefined;
  if (!endpoint || !key) return false;
  try {
    const res = await fetch(`${endpoint}/api/_internal/db/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-db-forward-key': key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

// Estimate bytes written by a single statement based on param length.
// Conservative — used only for overflow tracking, not for actual row storage.
export const estimateBytes = (params: unknown[]): number => {
  let n = 0;
  for (const p of params) {
    if (p == null) continue;
    if (typeof p === 'string') n += p.length * 2; // UTF-16
    else if (typeof p === 'number') n += 8;
    else if (typeof p === 'boolean') n += 1;
    else n += 32;
  }
  return n + 64; // overhead
};

// Single entry point for all writes.
//
// Strategy (akun-2 is primary storage):
//   1. Forward to peer DB_FORWARD_ENDPOINT (akun-2) — this is where data lives
//   2. Track size on akun-2 (returns overflow flag)
//   3. If peer success → mirror to local async for read consistency
//   4. If peer failed (timeout/overflow/503) → fall back to LOCAL write
//   5. If both fail → return error
//
// Akun-2 is the primary. Akun-1 is read source for frontend, with mirror.
export const writeWithFallback = async (
  c: Context,
  table: string,
  sql: string,
  params: unknown[]
): Promise<WriteResult> => {
  const bytes = estimateBytes(params);

  // Try peer (akun-2) first
  const forwarded = await forwardWrite(c, { sql, params, table, bytes });
  if (forwarded) {
    // Peer will mirror back asynchronously — no need to mirror locally here.
    // (Avoids duplicate DB write to this account's local DB.)
    return { ok: true, target: 'overflow' };
  }

  // Fallback: local
  try {
    const stmt = c.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    const result = await bound.run();
    if (result.success) {
      c.executionCtx.waitUntil(trackWriteSize(c, table, bytes));
      return { ok: true, target: 'local' };
    }
    return { ok: false, target: 'local', error: 'local write returned success=false' };
  } catch (err) {
    return { ok: false, target: 'local', error: String(err) };
  }
};

// Mirror a write to local DB (read consistency for akun-1 reads).
// Not HTTP — direct DB write (already in this Worker).
const mirrorLocal = async (
  c: Context,
  table: string,
  sql: string,
  params: unknown[]
): Promise<void> => {
  try {
    const stmt = c.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    await bound.run();
  } catch {
    // best-effort — read consistency not guaranteed
  }
};

// Plain local write — used by akun-2 endpoint after receiving forward.
// Also mirrors to peer account via DB_MIRROR_ENDPOINT (async, best-effort)
// so reads from the other account eventually see the same data.
// Skips mirror if the current request is itself a mirror (x-db-mirror: 1).
export const writeLocal = async (
  c: Context,
  table: string,
  sql: string,
  params: unknown[]
): Promise<WriteResult> => {
  const bytes = estimateBytes(params);
  try {
    const stmt = c.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    const result = await bound.run();
    if (result.success) {
      c.executionCtx.waitUntil(trackWriteSize(c, table, bytes));
      // Skip mirror if this request IS a mirror (break loop)
      const isMirror = c.req.header('x-db-mirror') === '1';
      if (!isMirror) {
        c.executionCtx.waitUntil(mirrorToPeer(c, { sql, params, table, bytes }));
      }
      return { ok: true, target: 'local', changes: result.meta?.changes ?? 0 };
    }
    return { ok: false, target: 'local', error: 'success=false' };
  } catch (err) {
    return { ok: false, target: 'local', error: String(err) };
  }
};

export const enqueueOutbox = async (
  env: Env,
  ownerUrl: string,
  table: string,
  sql: string,
  params: unknown[]
): Promise<void> => {
  try {
    if (!getPeers(env).some((p) => p.url === ownerUrl)) return;
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare('DELETE FROM _outbox WHERE created_at < ?1')
      .bind(now - OUTBOX_TTL_DAYS * 86400).run().catch(() => {});
    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM _outbox').first<{ c: number }>().catch(() => null);
    if (count && count.c >= OUTBOX_CAP) {
      await env.DB.prepare('DELETE FROM _outbox WHERE id IN (SELECT id FROM _outbox ORDER BY id ASC LIMIT 100)').run().catch(() => {});
    }
    await env.DB.prepare(
      'INSERT INTO _outbox (owner_url, table_name, sql, params, created_at) VALUES (?1, ?2, ?3, ?4, ?5)'
    ).bind(ownerUrl, table, sql, JSON.stringify(params), now).run();
  } catch {}
};

export const flushOutbox = async (env: Env, limit = 50): Promise<{ flushed: number; pending: number }> => {
  let flushed = 0;
  try {
    const peers = getPeers(env);
    const { results } = await env.DB.prepare(
      'SELECT id, owner_url, table_name, sql, params, attempts FROM _outbox ORDER BY id ASC LIMIT ?1'
    ).bind(limit).all<{ id: number; owner_url: string; table_name: string; sql: string; params: string; attempts: number }>();
    for (const row of results ?? []) {
      if (!peers.some((p) => p.url === row.owner_url)) {
        await env.DB.prepare('DELETE FROM _outbox WHERE id = ?1').bind(row.id).run().catch(() => {});
        continue;
      }
      let params: unknown[] = [];
      try {
        params = JSON.parse(row.params) as unknown[];
      } catch {
        await env.DB.prepare('DELETE FROM _outbox WHERE id = ?1').bind(row.id).run().catch(() => {});
        continue;
      }
      const ok = await internalExec(env, row.owner_url, { sql: row.sql, params, table: row.table_name });
      if (ok) {
        await env.DB.prepare('DELETE FROM _outbox WHERE id = ?1').bind(row.id).run().catch(() => {});
        flushed++;
      } else if (row.attempts >= 50) {
        console.error(`[outbox] dropping id=${row.id} table=${row.table_name} after 50 attempts`);
        await env.DB.prepare('DELETE FROM _outbox WHERE id = ?1').bind(row.id).run().catch(() => {});
      } else {
        await env.DB.prepare('UPDATE _outbox SET attempts = attempts + 1 WHERE id = ?1').bind(row.id).run().catch(() => {});
      }
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM _outbox').first<{ c: number }>().catch(() => null);
    return { flushed, pending: count?.c ?? 0 };
  } catch {
    return { flushed, pending: -1 };
  }
};

// Mirror a successful write to the other account's DB so reads there
// see the same row. Fire-and-forget — never blocks the original write.
// Uses separate DB_MIRROR_KEY + x-db-mirror-key header so:
//   1. Mirror traffic is distinguishable from primary writes (auditable)
//   2. Receiver doesn't mirror-back (no loop)
//   3. Compromised mirror key can't be used to send primary writes
const mirrorToPeer = async (
  c: Context,
  payload: { sql: string; params: unknown[]; table: string; bytes: number }
): Promise<void> => {
  const endpoint = c.env.DB_MIRROR_ENDPOINT as string | undefined;
  const key = c.env.DB_MIRROR_KEY as string | undefined;
  if (!endpoint || !key) return;
  try {
    await fetch(`${endpoint}/api/_internal/db/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-db-mirror-key': key,
        'x-db-mirror': '1',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // best-effort
  }
};
