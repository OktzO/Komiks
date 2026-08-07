// Konfigurasi akun R2 multi-account. Satu secret JSON (R2_ACCOUNTS) — bukan
// 3 env var per akun (batas 64 env var/Worker). Urutan array = index akun,
// HARUS sama dengan NEXT_PUBLIC_R2_DOMAINS di frontend.
export interface R2Account {
  account_id: string;
  access_key_id: string;
  secret_access_key: string;
  public_domain: string;
  bucket?: string;
}

export const DEFAULT_BUCKET = 'manga-images';

export const parseR2Accounts = (raw: string | undefined): R2Account[] => {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error('invalid R2_ACCOUNTS JSON');
  }
  if (!Array.isArray(arr)) throw new Error('invalid R2_ACCOUNTS: expected array');
  return arr.map((a) => {
    if (typeof a !== 'object' || a === null) throw new Error('invalid R2_ACCOUNTS entry');
    const o = a as Record<string, unknown>;
    for (const f of ['account_id', 'access_key_id', 'secret_access_key', 'public_domain'] as const) {
      if (typeof o[f] !== 'string' || (o[f] as string).length === 0) throw new Error(`invalid R2_ACCOUNTS: missing field ${f}`);
    }
    return {
      account_id: o.account_id as string,
      access_key_id: o.access_key_id as string,
      secret_access_key: o.secret_access_key as string,
      public_domain: o.public_domain as string,
      bucket: typeof o.bucket === 'string' && o.bucket.length > 0 ? o.bucket : DEFAULT_BUCKET,
    };
  });
};