// Konfigurasi Backblaze B2 (secondary object storage, PRIMARY untuk upload
// baru — R2 jadi legacy/fallback). Secret JSON tunggal (B2_CONFIG), bukan
// beberapa env var (batas 64 env var/Worker).
export interface B2Config {
  bucket: string;
  keyId: string;
  appKey: string;
  region: string;
  host: string;
}

export const parseB2Config = (raw: string | undefined): B2Config | null => {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('invalid B2_CONFIG JSON');
  }
  if (typeof o !== 'object' || o === null) throw new Error('invalid B2_CONFIG');
  for (const f of ['bucket', 'keyId', 'appKey'] as const) {
    if (typeof o[f] !== 'string' || (o[f] as string).length === 0) throw new Error(`invalid B2_CONFIG: missing field ${f}`);
  }
  const region = typeof o.region === 'string' && o.region.length > 0 ? (o.region as string) : 'us-east-005';
  return {
    bucket: o.bucket as string,
    keyId: o.keyId as string,
    appKey: o.appKey as string,
    region,
    host: `s3.${region}.backblazeb2.com`,
  };
};