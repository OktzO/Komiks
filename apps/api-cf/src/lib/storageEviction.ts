// LRU storage eviction — lazy, triggered every N reader requests.
// Goal: hapus objek B2/R2 yang last_access > N hari (default 30) ketika
// quota > 80%. Turun ke 70% lalu stop.
//
// B2 free tier: 10GB. Quota detection via D1 row count approximation
// (avg 1.6MB/obj → 5000 rows ≈ 8GB = 80% threshold).
// R2 ring: lifecycle rule 30 hari prefix `komiku/` (configured di CF dashboard,
// tidak butuh Worker-side evict).
import type { Env } from './context';
import { db } from '@manga-platform/db';
import { parseB2Accounts, b2AccountForIdx } from './b2Config';
import { b2PresignedGet } from './s3Upload';

const B2_QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // 10GB free tier
const B2_EVICT_THRESHOLD = 0.8; // 80%
const B2_EVICT_TARGET = 0.7; // 70%
const DEFAULT_EVICT_DAYS = 30;
const ROW_COUNT_THRESHOLD = 5000; // approx rows = 80% of 10GB

// B2 delete via S3 API (DELETE object).
const b2DeleteObject = async (
  b2: { keyId: string; appKey: string; bucket: string; region: string; host: string },
  key: string
): Promise<boolean> => {
  const dateISO = new Date().toISOString();
  const amzDate = dateISO.replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const path = `/${b2.bucket}/${key.split('/').map((s) => encodeURIComponent(s)).join('/')}`;
  const canonicalHeaders = `host:${b2.host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalRequest = `DELETE\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n`;
  const scope = `${dateStamp}/${b2.region}/s3/aws4_request`;
  const enc = new TextEncoder();
  const hashHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hashHex(await crypto.subtle.digest('SHA-256', enc.encode(canonicalRequest)))}`;
  // Signing key chain
  const hmac = (k: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> => {
    const raw = k instanceof Uint8Array ? k : new Uint8Array(k);
    return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then((ck) => crypto.subtle.sign('HMAC', ck, enc.encode(data)));
  };
  const kDate = await hmac(enc.encode(`AWS4${b2.appKey}`), dateStamp);
  const kRegion = await hmac(kDate, b2.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hashHex(await hmac(kSigning, stringToSign));
  const res = await fetch(`https://${b2.host}${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${b2.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-date': amzDate,
    },
  });
  return res.ok || res.status === 204;
};

export const evictStaleStorage = async (env: Env): Promise<{ evicted: number }> => {
  const evictDays = Number(env.B2_EVICTION_DAYS) || DEFAULT_EVICT_DAYS;
  const staleBeforeTs = Math.floor(Date.now() / 1000) - evictDays * 86400;
  const b2Accounts = parseB2Accounts(env.B2_CONFIG ?? env.B2_ACCOUNTS);
  let totalEvicted = 0;

  for (let i = 0; i < b2Accounts.length; i++) {
    const accountIdx = -(i + 1);
    // Approximate quota: count rows in D1 for this account.
    const client = db(env.DB);
    // Use listStalePages with limit to check if there are stale pages.
    const stalePages = await client.listStalePages(accountIdx, staleBeforeTs, 100).catch(() => []);
    if (stalePages.length === 0) continue;

    // Check approximate quota: count total rows for this account.
    // If below threshold, skip eviction for this account.
    const countRow = await env.DB.prepare('SELECT COUNT(*) as c FROM chapter_pages WHERE r2_account_idx = ?1')
      .bind(accountIdx).first<{ c: number }>().catch(() => null);
    const totalRows = countRow?.c ?? 0;
    if (totalRows < ROW_COUNT_THRESHOLD) continue;

    // Evict stale pages until below target (approx 70% = 4375 rows).
    const targetRows = Math.floor(ROW_COUNT_THRESHOLD * (B2_EVICT_TARGET / B2_EVICT_THRESHOLD));
    let evicted = 0;
    for (const page of stalePages) {
      if (totalRows - evicted <= targetRows) break;
      const b2 = b2AccountForIdx(b2Accounts, accountIdx);
      if (!b2) break;
      const deleted = await b2DeleteObject(b2, page.r2_key).catch(() => false);
      if (deleted) {
        await client.clearPageStorage(page.chapter_id, page.page_number).catch(() => {});
        evicted++;
      }
    }
    totalEvicted += evicted;
    console.log(`[evict] b2:${b2Accounts[i].name} evicted ${evicted} objects (was ${totalRows} rows)`);
  }

  return { evicted: totalEvicted };
};

// Suppress unused import warning — b2PresignedGet not used here but kept for future.
void b2PresignedGet;
void B2_QUOTA_BYTES;
