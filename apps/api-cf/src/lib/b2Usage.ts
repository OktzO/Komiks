// KV-backed B2 usage tracker. Each account has a counter key `b2:usage:<idx>`
// holding JSON `{ bytes: number; updatedAt: number }`. Usage is additive +
// occasionally reconciled from native B2 API by the cron (Task 15/16).
import { resolveB2Accounts } from './b2Config';
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

export type B2Account = { keyId: string; appKey: string; bucket: string };

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

export const addB2Usage = async (kv: UsageKv, idx: number, delta: number): Promise<number> => {
  const current = await getB2Usage(kv, idx);
  const bytes = current + delta;
  await setB2Usage(kv, idx, bytes);
  return bytes;
};

export const usageRatio = async (
  env: { B2_QUOTA_BYTES?: string },
  kv: UsageKv,
  idx: number
): Promise<number> => {
  const quota = quotaBytes(env);
  if (quota <= 0) return 0;
  return (await getB2Usage(kv, idx)) / quota;
};

// Native B2 API usage (b2_authorize_account → b2_list_buckets).
// list_buckets tidak mengembalikan bytes per-bucket; KV aditif tetap
// source-of-truth. Fungsi ini hanya verifikasi kredensial + bucket.
export const b2NativeUsage = async (b2: B2Account): Promise<{ fileCount: number; bytes: number } | null> => {
  try {
    const authRes = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
      headers: { Authorization: `Basic ${btoa(`${b2.keyId}:${b2.appKey}`)}` },
    });
    if (!authRes.ok) return null;
    const auth = (await authRes.json()) as {
      accountId: string;
      authorizationToken: string;
      apiUrl: string;
      apiInfo?: { storageApi?: { apiUrl?: string } };
    };
    const accountId = auth.accountId;
    const authorizationToken = auth.authorizationToken;
    const apiUrl = auth.apiUrl || auth.apiInfo?.storageApi?.apiUrl;
    if (!accountId || !apiUrl || !authorizationToken) return null;
    const listRes = await fetch(`${apiUrl}/b2api/v3/b2_list_buckets`, {
      method: 'POST',
      headers: { Authorization: authorizationToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    if (!listRes.ok) return null;
    const list = (await listRes.json()) as { buckets?: Array<{ bucketName: string; bucketId: string }> };
    const bucket = list.buckets?.find((b) => b.bucketName === b2.bucket);
    if (!bucket) return null;
    // Bucket ada + kredensial valid, tapi bytes akurat tidak tersedia tanpa
    // listing semua objek → kembalikan null agar caller TIDAK overwrite KV.
    return null;
  } catch {
    return null;
  }
};

export const syncB2UsageFromBuckets = async (env: {
  B2_CONFIG?: string;
  B2_ACCOUNTS?: string;
  CACHE_KV: UsageKv;
}): Promise<void> => {
  const accounts = resolveB2Accounts(env.B2_CONFIG, env.B2_ACCOUNTS);
  for (let i = 0; i < accounts.length; i++) {
    const usage = await b2NativeUsage(accounts[i]).catch(() => null);
    if (usage && typeof usage.bytes === 'number' && usage.bytes > 0) {
      await setB2Usage(env.CACHE_KV, i, usage.bytes);
    }
  }
};

export const addB2UsageGlobal = async (c: Context, accountName: string, delta: number): Promise<void> => {
  try {
    await writeWithFallback(
      c,
      'b2_usage',
      'INSERT INTO b2_usage (account_name, bytes, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_name) DO UPDATE SET bytes = b2_usage.bytes + excluded.bytes, updated_at = excluded.updated_at',
      [accountName, delta, Math.floor(Date.now() / 1000)]
    );
  } catch {}
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
