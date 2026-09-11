// KV-backed B2 usage tracker. Each account has a counter key `b2:usage:<idx>`
// holding JSON `{ bytes: number; updatedAt: number }`. Usage is additive;
// source-of-truth = KV + tabel b2_usage global.
import type { Context, Env } from './context';
import { writeWithFallback } from './dbWrite';
import { internalExec, internalQuery } from './peers';

const primaryOrigin = (env: Env): string | null => {
  try {
    const ep = env.DB_FORWARD_ENDPOINT as string | undefined;
    if (!ep) return null;
    return new URL(ep).origin;
  } catch {
    return null;
  }
};

export type UsageKv = {
  get(key: string, fmt?: 'json'): Promise<any | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};

export const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB per account

export const quotaBytes = (env: { B2_QUOTA_BYTES?: string }): number =>
  env.B2_QUOTA_BYTES ? Number(env.B2_QUOTA_BYTES) || DEFAULT_QUOTA_BYTES : DEFAULT_QUOTA_BYTES;

const key = (idx: number) => `b2:usage:${idx}`;

export const getB2Usage = async (kv: UsageKv, idx: number): Promise<number> => {
  const row = await kv.get(key(idx), 'json');
  return typeof row?.bytes === 'number' ? row.bytes : 0;
};

export const setB2Usage = async (kv: UsageKv, idx: number, bytes: number): Promise<void> => {
  await kv.put(key(idx), JSON.stringify({ bytes, updatedAt: Date.now() }));
};

// ── Batch flush (ops A) ────────────────────────────────────────────────────
// addB2Usage lama: KV GET+PUT per gambar (level request) → kuota KV write
// free 1.000/hari habis untuk < 100 chapter cold/hari. Kini delta diakumulasi
// di memori isolate dan di-flush maksimal 1×/FLUSH_MS. Akurasi pemakaian
// maximal tertunda FLUSH_MS saat isolate mati / request sepi — aman karena
// threshold eviction 80% (≈2GB longgar di bawah 10GB).
const FLUSH_MS = 60_000;
const pendingKv = new Map<number, number>();
const knownKv = new Map<number, number>(); // nilai terakhir yang diketahui (KV + flush)
let lastKvFlush = 0;
let kvFlushBusy = false;

const flushKvUsage = async (kv: UsageKv): Promise<void> => {
  if (kvFlushBusy || pendingKv.size === 0 || Date.now() - lastKvFlush < FLUSH_MS) return;
  kvFlushBusy = true;
  lastKvFlush = Date.now();
  try {
    for (const [idx, delta] of [...pendingKv]) {
      pendingKv.delete(idx);
      const total = (await getB2Usage(kv, idx)) + delta;
      await setB2Usage(kv, idx, total);
      knownKv.set(idx, total);
    }
  } catch {
    // KV put gagal → delta yang sedang diproses hilang (drift kecil).
    // Diterima: blokir user request demi counter tidak sebanding.
  } finally {
    kvFlushBusy = false;
  }
};

export const addB2Usage = async (kv: UsageKv, idx: number, delta: number): Promise<number> => {
  pendingKv.set(idx, (pendingKv.get(idx) ?? 0) + delta);
  await flushKvUsage(kv); // hanya menulis KV bila jendela flush tiba
  return (knownKv.get(idx) ?? 0) + (pendingKv.get(idx) ?? 0);
};

// Dengan batching, getB2Usage bisa tertunda FLUSH_MS — include pending lokal
// agar deteksi "akun nyaris penuh" (uploadToStorage) tidak kebas.
export const getB2UsageLive = async (kv: UsageKv, idx: number): Promise<number> =>
  (await getB2Usage(kv, idx)) + (pendingKv.get(idx) ?? 0);

export const usageRatio = async (
  env: { B2_QUOTA_BYTES?: string },
  kv: UsageKv,
  idx: number
): Promise<number> => {
  const quota = quotaBytes(env);
  if (quota <= 0) return 0;
  return (await getB2UsageLive(kv, idx)) / quota;
};

// Dihapus: b2NativeUsage/syncB2UsageFromBuckets (cron). B2 list_buckets tidak
// mengembalikan bytes per-bucket → fungsi selalu return null, hanya membuang
// 2 HTTP request per akun per jam. KV aditif + tabel b2_usage global tetap
// source-of-truth; rekonsiliasi bytes asli butuh b2_list_file_versions penuh
// (Class C mahal) — tak sebanding untuk free tier.

// Global b2_usage table: dibatch sama dengan timer yang sama (ops A).
// SQL ON CONFLICT menambah (bytes + delta), jadi akumulasi delta aman.
const pendingGlobal = new Map<string, number>();
let lastGlobalFlush = 0;
let globalFlushBusy = false;

export const addB2UsageGlobal = async (c: Context, accountName: string, delta: number): Promise<void> => {
  pendingGlobal.set(accountName, (pendingGlobal.get(accountName) ?? 0) + delta);
  if (globalFlushBusy || pendingGlobal.size === 0 || Date.now() - lastGlobalFlush < FLUSH_MS) return;
  globalFlushBusy = true;
  lastGlobalFlush = Date.now();
  try {
    for (const [name, d] of [...pendingGlobal]) {
      pendingGlobal.delete(name);
      await writeWithFallback(
        c,
        'b2_usage',
        'INSERT INTO b2_usage (account_name, bytes, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_name) DO UPDATE SET bytes = b2_usage.bytes + excluded.bytes, updated_at = excluded.updated_at',
        [name, d, Math.floor(Date.now() / 1000)]
      ).catch(() => {});
    }
  } finally {
    globalFlushBusy = false;
  }
};

export const getB2UsageGlobal = async (c: Context, accountName: string): Promise<number | null> => {
  try {
    const row = await c.env.DB.prepare('SELECT bytes FROM b2_usage WHERE account_name = ?1')
      .bind(accountName)
      .first<{ bytes: number }>();
    if (typeof row?.bytes === 'number') return row.bytes;
  } catch {}
  const origin = primaryOrigin(c.env);
  if (!origin) return null;
  const rows = await internalQuery<{ bytes: number }>(
    c.env, origin, 'SELECT bytes FROM b2_usage WHERE account_name = ?1', [accountName], 'b2_usage'
  ).catch(() => null);
  const bytes = rows?.[0]?.bytes;
  return typeof bytes === 'number' ? bytes : null;
};

export const decB2UsageGlobal = async (env: Env, accountName: string, delta: number): Promise<void> => {
  const origin = primaryOrigin(env);
  if (!origin || delta <= 0) return;
  await internalExec(env, origin, {
    sql: 'UPDATE b2_usage SET bytes = MAX(0, bytes - ?1), updated_at = ?2 WHERE account_name = ?3',
    params: [delta, Math.floor(Date.now() / 1000), accountName],
    table: 'b2_usage',
  }).catch(() => {});
};

export const setB2UsageGlobal = async (c: Context, accountName: string, bytes: number): Promise<void> => {
  try {
    await writeWithFallback(
      c,
      'b2_usage',
      'INSERT INTO b2_usage (account_name, bytes, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_name) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at',
      [accountName, bytes, Math.floor(Date.now() / 1000)]
    );
  } catch {}
};
