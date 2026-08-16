// KV-backed B2 usage tracker. Each account has a counter key `b2:usage:<idx>`
// holding JSON `{ bytes: number; updatedAt: number }`. Usage is additive +
// occasionally reconciled from native B2 API by the cron (Task 15/16).
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
