// Konfigurasi Backblaze B2 multi-account.
// Secret JSON array (B2_ACCOUNTS), urutan = idx: [-1, -2, ...].
// Backward-compat: single-object B2_CONFIG lama diconvert ke array 1-item.
import { murmur3_32 } from '@manga-platform/shared/r2-routing';

export interface B2Account {
  name: string;
  bucket: string;
  keyId: string;
  appKey: string;
  region: string;
  host: string;
}

export const parseB2Accounts = (raw: string | undefined): B2Account[] => {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error('invalid B2_ACCOUNTS JSON');
  }
  // Single-object backward-compat (old B2_CONFIG format).
  if (!Array.isArray(arr)) {
    arr = [arr as unknown];
  }
  const list = arr as unknown[];
  const out: B2Account[] = [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i] as Record<string, unknown>;
    if (typeof o !== 'object' || o === null) throw new Error(`invalid B2_ACCOUNTS entry ${i}`);
    for (const f of ['bucket', 'keyId', 'appKey'] as const) {
      if (typeof o[f] !== 'string' || (o[f] as string).length === 0) throw new Error(`invalid B2_ACCOUNTS: missing field ${f} at index ${i}`);
    }
    const region = typeof o.region === 'string' && o.region.length > 0 ? (o.region as string) : 'us-east-005';
    out.push({
      name: typeof o.name === 'string' ? (o.name as string) : `b2-${i + 1}`,
      bucket: o.bucket as string,
      keyId: o.keyId as string,
      appKey: o.appKey as string,
      region,
      host: `s3.${region}.backblazeb2.com`,
    });
  }
  return out;
};

// Legacy single-config accessor — returns first account or null.
export const parseB2Config = (raw: string | undefined): B2Account | null => {
  const arr = parseB2Accounts(raw);
  return arr.length > 0 ? arr[0] : null;
};

// Resolve account by r2_account_idx value from D1 chapter_pages.
// -1 → B2-A (index 0), -2 → B2-B (index 1), etc.
// Returns null if idx out of range.
export const b2AccountForIdx = (accounts: B2Account[], idx: number): B2Account | null => {
  if (idx >= 0) return null; // R2 ring, not B2
  const arrIdx = -(idx + 1); // -1 → 0, -2 → 1
  if (arrIdx < 0 || arrIdx >= accounts.length) return null;
  return accounts[arrIdx];
};

// Merge B2_CONFIG (legacy single) + B2_ACCOUNTS (new array) into one array.
// Dedup by keyId (B2_CONFIG entry first if not already in B2_ACCOUNTS).
// This ensures backward-compat: akun-1 yang punya B2_CONFIG (B2 akun-1) +
// B2_ACCOUNTS (B2 akun-2) → round-robin kedua B2 accounts.
export const resolveB2Accounts = (
  b2ConfigRaw: string | undefined,
  b2AccountsRaw: string | undefined
): B2Account[] => {
  const configAccounts = parseB2Accounts(b2ConfigRaw); // B2_CONFIG (single → 1-item array)
  const arrayAccounts = parseB2Accounts(b2AccountsRaw); // B2_ACCOUNTS (array)
  // Merge: B2_CONFIG first, then B2_ACCOUNTS (skip dup by keyId).
  const seen = new Set<string>();
  const out: B2Account[] = [];
  for (const a of [...configAccounts, ...arrayAccounts]) {
    if (seen.has(a.keyId)) continue;
    seen.add(a.keyId);
    out.push(a);
  }
  return out;
};

// Deterministic B2 account pick by object-key hash (murmur3_32). Same object
// key always lands on the same B2 account (dedup-able, consistent eviction).
// Single account → always index 0 (backward compatible with legacy setup).
export const pickB2AccountIdx = (accounts: B2Account[], key: string): number => {
  if (accounts.length <= 1) return 0;
  return murmur3_32(key) % accounts.length;
};

export const pickB2Account = (accounts: B2Account[], key: string): B2Account | null => {
  if (accounts.length === 0) return null;
  return accounts[pickB2AccountIdx(accounts, key)];
};
